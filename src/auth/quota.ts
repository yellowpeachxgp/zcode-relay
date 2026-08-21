import { credentialString, type Credential } from "./types.js";
import type { AccountPool } from "./pool.js";
import type { AccountQuotaSnapshot } from "./pool-types.js";
import type { ProviderId } from "../provider/types.js";

export interface QuotaMonitorConfig {
  enabled: boolean;
  intervalSeconds: number;
  timeoutMs: number;
  endpoints: Record<ProviderId, string>;
}

export interface QuotaCheckResult extends AccountQuotaSnapshot {
  accountId: string;
  provider: ProviderId;
}

export type QuotaFetch = typeof fetch;

/** Provider quota checker with bounded requests and an optional periodic loop. */
export class QuotaMonitor {
  private readonly pool: AccountPool;
  private readonly config: QuotaMonitorConfig;
  private readonly fetchImpl: QuotaFetch;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;

  constructor(pool: AccountPool, config: QuotaMonitorConfig, fetchImpl: QuotaFetch = fetch) {
    this.pool = pool;
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async checkAccount(id: string): Promise<QuotaCheckResult> {
    const account = this.pool.snapshot(id);
    const credential = this.pool.credentialFor(id);
    if (!account || !credential) throw new Error("account not found: " + id);

    const endpoint = this.config.endpoints[account.provider];
    if (!endpoint) {
      return this.apply(id, account.provider, { status: "unknown", source: "not_configured", updatedAt: Date.now() });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, this.config.timeoutMs));
    try {
      const response = await this.fetchImpl(quotaUrl(endpoint), {
        method: "GET",
        headers: quotaHeaders(credential),
        signal: controller.signal,
      });
      if (!response.ok) {
        return this.apply(id, account.provider, {
          status: "error",
          source: endpoint,
          updatedAt: Date.now(),
          error: "quota endpoint returned HTTP " + response.status,
        });
      }
      const payload = await response.json() as unknown;
      const parsed = parseQuotaPayload(payload);
      return this.apply(id, account.provider, { ...parsed, source: endpoint, updatedAt: Date.now() });
    } catch (error) {
      return this.apply(id, account.provider, {
        status: "error",
        source: endpoint,
        updatedAt: Date.now(),
        error: error instanceof Error && error.name === "AbortError" ? "quota request timed out" : (error as Error).message,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async checkAll(): Promise<QuotaCheckResult[]> {
    const accounts = this.pool.list();
    return Promise.all(accounts.map((account) => this.checkAccount(account.id).catch((error) => ({
      accountId: account.id,
      provider: account.provider,
      status: "error" as const,
      updatedAt: Date.now(),
      error: (error as Error).message,
    }))));
  }

  start(): void {
    if (!this.config.enabled || this.config.intervalSeconds <= 0 || this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => { void this.runOnce(); }, this.config.intervalSeconds * 1000);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async runOnce(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      await this.checkAll();
    } finally {
      this.checking = false;
    }
  }

  private apply(id: string, provider: ProviderId, quota: AccountQuotaSnapshot): QuotaCheckResult {
    const normalized = { ...quota, status: quota.status ?? "unknown" };
    this.pool.updateQuota(id, normalized);
    return { accountId: id, provider, ...normalized };
  }
}

function quotaUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  return trimmed.endsWith("/billing/balance") ? trimmed : trimmed + "/billing/balance";
}

function quotaHeaders(credential: Credential): Record<string, string> {
  if (credential.jwt) return { authorization: "Bearer " + credential.jwt, accept: "application/json" };
  return { "x-api-key": credentialString(credential), accept: "application/json" };
}

function parseQuotaPayload(payload: unknown): AccountQuotaSnapshot {
  const root = asRecord(payload);
  const data = asRecord(root?.data) ?? root;
  const balances = Array.isArray(data?.balances) ? data.balances.map(asRecord).filter(Boolean) as Record<string, unknown>[] : [];
  const source = balances[0] ?? asRecord(data?.balance) ?? data ?? root;
  const remaining = sumNumber(balances, ["remaining_units", "remaining", "quota_remaining"]) ?? numberFrom(source, ["remaining_units", "remaining", "quota_remaining"]);
  const limit = sumNumber(balances, ["total_units", "total", "limit", "quota_limit"]) ?? numberFrom(source, ["total_units", "total", "limit", "quota_limit"]);
  const used = sumNumber(balances, ["used_units", "used", "consumed"]) ?? numberFrom(source, ["used_units", "used", "consumed"]);
  if (remaining === undefined && limit === undefined && used === undefined) {
    return { status: "error", error: "quota response did not contain numeric balance fields" };
  }
  return { status: remaining !== undefined && remaining <= 0 ? "exhausted" : "healthy", ...(remaining !== undefined ? { remaining } : {}), ...(limit !== undefined ? { limit } : {}), ...(used !== undefined ? { used } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numberFrom(value: Record<string, unknown> | null, keys: string[]): number | undefined {
  if (!value) return undefined;
  for (const key of keys) {
    const raw = value[key];
    const number = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function sumNumber(values: Record<string, unknown>[], keys: string[]): number | undefined {
  if (values.length === 0) return undefined;
  const numbers = values.map((value) => numberFrom(value, keys));
  if (numbers.some((value) => value === undefined)) return undefined;
  return numbers.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}
