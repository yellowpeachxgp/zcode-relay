import { credentialString, type AuthMode, type Credential } from "./types.js";
import type {
  AccountFailureClass,
  AccountLease,
  AccountPoolInput,
  AccountSnapshot,
  AccountStatus,
} from "./pool-types.js";
import type { ProviderId } from "../provider/types.js";

export type { AccountStatus } from "./pool-types.js";

interface AccountRecord {
  id: string;
  provider: ProviderId;
  credential: Credential;
  mode: AuthMode;
  enabled: boolean;
  status: AccountStatus;
  inFlight: number;
  maxConcurrency: number;
  requestCount: number;
  failureCount: number;
  coolingUntil?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastErrorClass?: AccountFailureClass;
  lastError?: string;
}

export interface AccountPoolOptions {
  now?: () => number;
  coolingSeconds?: number;
  maxConcurrencyPerAccount?: number;
}

export class AccountPool {
  private readonly accounts = new Map<string, AccountRecord>();
  private readonly rotation = new Map<ProviderId, number>();
  private readonly now: () => number;
  private readonly coolingSeconds: number;
  private readonly maxConcurrencyPerAccount: number;

  constructor(options: AccountPoolOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.coolingSeconds = Math.max(0, options.coolingSeconds ?? 30);
    this.maxConcurrencyPerAccount = normalizeConcurrency(options.maxConcurrencyPerAccount ?? 4);
  }

  add(input: AccountPoolInput): AccountSnapshot {
    if (!input.id.trim()) throw new Error("account id must not be empty");
    if (this.accounts.has(input.id)) throw new Error("account already exists: " + input.id);
    if (input.credential.provider !== input.provider) {
      throw new Error("credential provider mismatch for account: " + input.id);
    }

    const record: AccountRecord = {
      id: input.id,
      provider: input.provider,
      credential: input.credential,
      mode: input.mode ?? "apikey",
      enabled: input.enabled ?? true,
      status: input.enabled === false ? "disabled" : "active",
      inFlight: 0,
      maxConcurrency: normalizeConcurrency(input.maxConcurrency ?? this.maxConcurrencyPerAccount),
      requestCount: 0,
      failureCount: 0,
    };
    this.accounts.set(record.id, record);
    return this.toSnapshot(record);
  }

  list(provider?: ProviderId): AccountSnapshot[] {
    return [...this.accounts.values()]
      .filter((account) => provider === undefined || account.provider === provider)
      .map((account) => this.toSnapshot(account));
  }

  snapshot(id: string): AccountSnapshot | null {
    const account = this.accounts.get(id);
    return account ? this.toSnapshot(account) : null;
  }

  remove(id: string): boolean {
    return this.accounts.delete(id);
  }

  setEnabled(id: string, enabled: boolean): AccountSnapshot | null {
    const account = this.accounts.get(id);
    if (!account) return null;
    account.enabled = enabled;
    account.status = enabled ? "active" : "disabled";
    account.coolingUntil = undefined;
    account.lastErrorClass = undefined;
    account.lastError = undefined;
    return this.toSnapshot(account);
  }

  acquire(provider: ProviderId): AccountLease | null {
    const candidates = this.listSelectable(provider);
    if (candidates.length === 0) return null;

    const start = this.rotation.get(provider) ?? 0;
    for (let offset = 0; offset < candidates.length; offset += 1) {
      const index = (start + offset) % candidates.length;
      const account = candidates[index];
      if (account.inFlight >= account.maxConcurrency) continue;
      account.inFlight += 1;
      this.rotation.set(provider, (index + 1) % candidates.length);
      let released = false;
      return {
        accountId: account.id,
        provider: account.provider,
        credential: account.credential,
        release: () => {
          if (released) return;
          released = true;
          account.inFlight = Math.max(0, account.inFlight - 1);
        },
      };
    }
    return null;
  }

  markSuccess(id: string): AccountSnapshot | null {
    const account = this.accounts.get(id);
    if (!account) return null;
    account.requestCount += 1;
    account.lastSuccessAt = this.now();
    account.lastErrorClass = undefined;
    account.lastError = undefined;
    account.coolingUntil = undefined;
    account.status = account.enabled ? "active" : "disabled";
    return this.toSnapshot(account);
  }

  markFailure(id: string, failureClass: AccountFailureClass, error?: string): AccountSnapshot | null {
    const account = this.accounts.get(id);
    if (!account) return null;
    account.failureCount += 1;
    account.lastFailureAt = this.now();
    account.lastErrorClass = failureClass;
    account.lastError = error;

    if (!account.enabled) {
      account.status = "disabled";
      return this.toSnapshot(account);
    }

    switch (failureClass) {
      case "auth":
        account.status = "invalid";
        account.coolingUntil = undefined;
        break;
      case "quota":
        account.status = "exhausted";
        account.coolingUntil = undefined;
        break;
      case "challenge":
        account.status = "challenge";
        account.coolingUntil = undefined;
        break;
      case "rate_limit":
      case "network":
      case "upstream":
        account.status = "cooling";
        account.coolingUntil = this.now() + this.coolingSeconds * 1000;
        break;
      case "client":
        break;
    }
    return this.toSnapshot(account);
  }

  private listSelectable(provider: ProviderId): AccountRecord[] {
    const now = this.now();
    return [...this.accounts.values()].filter((account) => {
      if (account.provider !== provider || !account.enabled) return false;
      if (account.status === "disabled" || account.status === "invalid") return false;
      if (account.status === "exhausted" || account.status === "challenge") return false;
      if (account.status === "cooling") {
        if ((account.coolingUntil ?? Number.POSITIVE_INFINITY) > now) return false;
        account.status = "active";
        account.coolingUntil = undefined;
      }
      return true;
    });
  }

  private toSnapshot(account: AccountRecord): AccountSnapshot {
    return {
      id: account.id,
      provider: account.provider,
      mode: account.mode,
      enabled: account.enabled,
      status: account.status,
      credentialMasked: maskCredential(credentialString(account.credential)),
      inFlight: account.inFlight,
      maxConcurrency: account.maxConcurrency,
      requestCount: account.requestCount,
      failureCount: account.failureCount,
      coolingUntil: account.coolingUntil,
      lastSuccessAt: account.lastSuccessAt,
      lastFailureAt: account.lastFailureAt,
      lastErrorClass: account.lastErrorClass,
      lastError: account.lastError,
    };
  }
}

function normalizeConcurrency(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}

function maskCredential(value: string): string {
  if (value.length <= 12) return "********";
  return value.slice(0, 8) + "…" + value.slice(-4);
}
