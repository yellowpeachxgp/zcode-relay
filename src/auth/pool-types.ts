import type { ProviderId } from "../provider/types.js";
import type { AuthMode, Credential } from "./types.js";

export type AccountStatus =
  | "active"
  | "cooling"
  | "exhausted"
  | "invalid"
  | "challenge"
  | "disabled";

export type AccountFailureClass =
  | "auth"
  | "quota"
  | "rate_limit"
  | "network"
  | "challenge"
  | "upstream"
  | "client";

export interface AccountUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export type AccountQuotaStatus = "unknown" | "healthy" | "exhausted" | "error";

export interface AccountQuotaSnapshot {
  status: AccountQuotaStatus;
  remaining?: number;
  limit?: number;
  used?: number;
  updatedAt?: number;
  source?: string;
  error?: string;
}

export interface AccountPoolInput {
  id: string;
  provider: ProviderId;
  credential: Credential;
  mode?: AuthMode;
  enabled?: boolean;
  maxConcurrency?: number;
}

export interface AccountSnapshot {
  id: string;
  provider: ProviderId;
  mode: AuthMode;
  enabled: boolean;
  status: AccountStatus;
  credentialMasked: string;
  inFlight: number;
  maxConcurrency: number;
  requestCount: number;
  failureCount: number;
  coolingUntil?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastErrorClass?: AccountFailureClass;
  lastError?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    updatedAt?: number;
  };
  quota: AccountQuotaSnapshot;
}

export interface AccountLease {
  readonly accountId: string;
  readonly provider: ProviderId;
  readonly credential: Credential;
  release(): void;
}
