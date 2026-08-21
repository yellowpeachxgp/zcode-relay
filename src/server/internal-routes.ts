import { createHash, timingSafeEqual } from "node:crypto";
import type { ProxyConfig } from "../config/types.js";
import type { ProviderId } from "../provider/types.js";
import { createApiKeyCredential } from "../auth/apikey.js";
import type { AuthManager } from "../auth/manager.js";
import type { AccountPool } from "../auth/pool.js";
import type { AccountStatus } from "../auth/pool-types.js";

export interface InternalRouteOptions {
  config: ProxyConfig;
  auth: AuthManager;
  onPoolChanged?: () => void;
  onQuotaCheck?: (accountId?: string) => Promise<unknown>;
}

/** Handle /internal/* routes. Returns null for paths outside the control API. */
export async function handleInternalRoute(req: Request, opts: InternalRouteOptions): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/internal")) return null;

  const control = opts.config.control;
  if (!control?.enabled) return jsonError(404, "not_found_error", "Internal control API is disabled");
  if (!control.adminKey) return jsonError(503, "control_unavailable", "Internal control API has no admin key");
  if (!hasControlKey(req, control.adminKey)) return jsonError(401, "authentication_error", "Invalid or missing control API key");

  const pool = opts.auth.getPool();
  if (!pool) return jsonError(503, "pool_unavailable", "Account pool is not configured");

  const path = url.pathname;
  if (req.method === "GET" && path === "/internal/health") {
    return json({ status: "ok", service: "zcode-relay-core", provider: opts.config.provider });
  }
  if (req.method === "GET" && path === "/internal/runtime") {
    return json(runtimeSummary(pool, opts.config));
  }
  if (req.method === "GET" && path === "/internal/accounts") {
    return json(accountSummary(pool));
  }
  if (req.method === "POST" && path === "/internal/accounts") {
    return createAccount(req, pool, opts.onPoolChanged);
  }
  if (req.method === "GET" && path === "/internal/usage/summary") {
    return json(usageSummary(pool));
  }
  if (req.method === "GET" && path.startsWith("/internal/usage/accounts/")) {
    const id = decodeId(path.slice("/internal/usage/accounts/".length));
    const account = id ? pool.snapshot(id) : null;
    if (!account) return jsonError(404, "not_found_error", "Account not found");
    return json({ accountId: id, requestCount: account.requestCount, failureCount: account.failureCount, status: account.status, lastSuccessAt: account.lastSuccessAt, lastFailureAt: account.lastFailureAt });
  }
  if (req.method === "GET" && path === "/internal/policy") {
    return json({ strategy: "round_robin", retryableStatuses: [401, 402, 429, 500, 502, 503, 504], providerIsolation: true });
  }
  if (req.method === "POST" && path === "/internal/accounts/check") {
    const result = opts.onQuotaCheck ? await opts.onQuotaCheck() : pool.list();
    return json({ checkedAt: Date.now(), accounts: result, mode: opts.onQuotaCheck ? "provider_quota" : "runtime_only" });
  }

  const match = path.match(/^\/internal\/accounts\/([^/]+)(?:\/(enable|disable|check))?$/);
  if (!match) return jsonError(404, "not_found_error", "No route for " + req.method + " " + path);
  const id = decodeId(match[1]);
  if (!id) return jsonError(400, "invalid_request_error", "Invalid account id");

  if (req.method === "DELETE" && !match[2]) {
    if (!pool.remove(id)) return jsonError(404, "not_found_error", "Account not found");
    const persistenceError = persist(opts.onPoolChanged);
    if (persistenceError) return persistenceError;
    return json({ deleted: true, id });
  }
  if (req.method === "POST" && match[2] === "enable") return toggleAccount(pool, id, true, opts.onPoolChanged);
  if (req.method === "POST" && match[2] === "disable") return toggleAccount(pool, id, false, opts.onPoolChanged);
  if (req.method === "POST" && match[2] === "check") {
    const account = pool.snapshot(id);
    if (!account) return jsonError(404, "not_found_error", "Account not found");
    const result = opts.onQuotaCheck ? await opts.onQuotaCheck(id) : account;
    return json({ ok: true, mode: opts.onQuotaCheck ? "provider_quota" : "runtime_only", checkedAt: Date.now(), account: result });
  }
  if (req.method === "PUT" && !match[2]) return updateAccount(req, pool, id, opts.onPoolChanged);
  return jsonError(404, "not_found_error", "No route for " + req.method + " " + path);
}

async function createAccount(req: Request, pool: AccountPool, onPoolChanged?: () => void): Promise<Response> {
  const body = await readObject(req);
  if (!body.ok) return body.response;
  const provider = body.value.provider;
  if (provider !== "zai" && provider !== "bigmodel") return jsonError(400, "invalid_request_error", "provider must be zai or bigmodel");
  const rawCredential = credentialInput(body.value);
  if (!rawCredential) return jsonError(400, "invalid_request_error", "credential is required");
  const id = typeof body.value.id === "string" && body.value.id.trim() ? body.value.id.trim() : provider + "-" + crypto.randomUUID().slice(0, 8);
  if (pool.snapshot(id)) return jsonError(409, "conflict_error", "Account already exists");
  try {
    const credential = makeCredential(provider, rawCredential, body.value.mode);
    const existing = pool.findByCredential(provider, credential);
    if (existing) return json({ account: existing, existed: true });
    const account = pool.add({
      id,
      provider,
      credential,
      mode: body.value.mode === "oauth" ? "oauth" : "apikey",
      enabled: body.value.enabled !== false,
      ...(typeof body.value.maxConcurrency === "number" ? { maxConcurrency: body.value.maxConcurrency } : {}),
    });
    const persistenceError = persist(onPoolChanged);
    if (persistenceError) return persistenceError;
    return json({ account }, 201);
  } catch (error) {
    return jsonError(400, "invalid_request_error", (error as Error).message);
  }
}

async function updateAccount(req: Request, pool: AccountPool, id: string, onPoolChanged?: () => void): Promise<Response> {
  if (!pool.snapshot(id)) return jsonError(404, "not_found_error", "Account not found");
  const body = await readObject(req);
  if (!body.ok) return body.response;
  const rawCredential = credentialInput(body.value);
  try {
    const current = pool.snapshot(id);
    const provider = current!.provider;
    const changes: Parameters<AccountPool["update"]>[1] = {
      ...(rawCredential ? { credential: makeCredential(provider, rawCredential, body.value.mode) } : {}),
      ...(body.value.mode === "oauth" || body.value.mode === "apikey" ? { mode: body.value.mode } : {}),
      ...(typeof body.value.enabled === "boolean" ? { enabled: body.value.enabled } : {}),
      ...(typeof body.value.maxConcurrency === "number" ? { maxConcurrency: body.value.maxConcurrency } : {}),
    };
    const account = pool.update(id, changes);
    const persistenceError = persist(onPoolChanged);
    if (persistenceError) return persistenceError;
    return json({ account });
  } catch (error) {
    return jsonError(400, "invalid_request_error", (error as Error).message);
  }
}

function toggleAccount(pool: AccountPool, id: string, enabled: boolean, onPoolChanged?: () => void): Response {
  const account = pool.setEnabled(id, enabled);
  if (!account) return jsonError(404, "not_found_error", "Account not found");
  const persistenceError = persist(onPoolChanged);
  if (persistenceError) return persistenceError;
  return json({ account });
}

function persist(onPoolChanged?: () => void): Response | null {
  try {
    onPoolChanged?.();
    return null;
  } catch (error) {
    return jsonError(500, "persistence_error", "Account state changed in memory but could not be persisted: " + (error as Error).message);
  }
}

function makeCredential(provider: ProviderId, raw: string, mode: unknown) {
  if (mode === "oauth") return { apiKey: raw, jwt: raw, provider };
  return createApiKeyCredential(provider, raw);
}

function credentialInput(body: Record<string, unknown>): string | null {
  for (const key of ["credential", "token", "apiKey"]) {
    if (typeof body[key] === "string" && body[key].trim()) return body[key].trim();
  }
  return null;
}

function accountSummary(pool: AccountPool) {
  const accounts = pool.list();
  const statuses = Object.fromEntries(([] as AccountStatus[]).concat("active", "cooling", "exhausted", "invalid", "challenge", "disabled").map((status) => [status, accounts.filter((account) => account.status === status).length]));
  return { accounts, total: accounts.length, selectable: statuses.active + statuses.cooling, statuses, ts: Date.now() };
}

function runtimeSummary(pool: AccountPool, config: ProxyConfig) {
  const summary = accountSummary(pool);
  return { status: "ok", service: "zcode-relay-core", provider: config.provider, plan: config.plan, pool: { total: summary.total, selectable: summary.selectable, statuses: summary.statuses }, ts: summary.ts };
}

function usageSummary(pool: AccountPool) {
  const accounts = pool.list();
  return {
    totalRequests: accounts.reduce((sum, account) => sum + account.requestCount, 0),
    totalFailures: accounts.reduce((sum, account) => sum + account.failureCount, 0),
    inputTokens: accounts.reduce((sum, account) => sum + account.usage.inputTokens, 0),
    outputTokens: accounts.reduce((sum, account) => sum + account.usage.outputTokens, 0),
    byProvider: Object.fromEntries(["zai", "bigmodel"].map((provider) => [provider, accounts.filter((account) => account.provider === provider).reduce((sum, account) => sum + account.requestCount, 0)])),
    ts: Date.now(),
  };
}

function hasControlKey(req: Request, expected: string): boolean {
  const authorization = req.headers.get("authorization")?.trim();
  const candidate = authorization?.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : authorization;
  const supplied = candidate || req.headers.get("x-zcode-admin-key")?.trim() || req.headers.get("x-admin-key")?.trim() || "";
  const left = createHash("sha256").update(supplied).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

async function readObject(req: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  try {
    const value: unknown = JSON.parse(await req.text());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be a JSON object");
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) {
    return { ok: false, response: jsonError(400, "invalid_request_error", (error as Error).message) };
  }
}

function decodeId(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.trim() || null;
  } catch {
    return null;
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function jsonError(status: number, type: string, message: string): Response {
  return json({ error: { type, message } }, status);
}
