import { randomUUID } from "node:crypto";
import type { ProviderId } from "../provider/types.js";
import type { Credential } from "./types.js";
import type { AccountPool } from "./pool.js";
import type { AccountSnapshot } from "./pool-types.js";
import { BigmodelOAuthClient, ZaiOAuthClient, type AuthCodeOAuthClient } from "./oauth.js";
import { KeyResolver } from "./resolver.js";

export interface OAuthStartResult {
  flowId: string;
  provider: ProviderId;
  authorizeUrl: string;
  callbackUrl: string;
}

export interface OAuthStatus {
  flowId: string;
  provider: ProviderId;
  status: "pending" | "processing" | "ready" | "failed";
  authorizeUrl: string;
  account?: AccountSnapshot;
  error?: string;
}

interface OAuthClientLike {
  startWithCallback(callbackUrl: string): { authorizeUrl: string; callbackUrl: string; state: string };
  acceptCallback(code: string, state: string): { code: string; state: string };
  exchangeCode(code: string, redirectUri: string, state: string): Promise<{ accessToken: string; userId?: string; jwt?: string }>;
  close(): Promise<void>;
}

interface OAuthFlow {
  id: string;
  provider: ProviderId;
  client: OAuthClientLike;
  state: string;
  callbackUrl: string;
  authorizeUrl: string;
  status: OAuthStatus["status"];
  account?: AccountSnapshot;
  error?: string;
}

export interface OAuthManagerOptions {
  clientFactory?: (provider: ProviderId) => OAuthClientLike;
  resolveCredential?: (accessToken: string, provider: ProviderId, userId?: string) => Promise<Credential>;
  onPoolChanged?: () => void;
}

/** Core-owned OAuth coordinator: the panel never receives access tokens or API keys. */
export class OAuthManager {
  private readonly pool: AccountPool;
  private readonly clientFactory: (provider: ProviderId) => OAuthClientLike;
  private readonly resolveCredential: (accessToken: string, provider: ProviderId, userId?: string) => Promise<Credential>;
  private readonly onPoolChanged?: () => void;
  private readonly flows = new Map<string, OAuthFlow>();

  constructor(pool: AccountPool, options: OAuthManagerOptions = {}) {
    this.pool = pool;
    this.clientFactory = options.clientFactory ?? ((provider) => provider === "zai" ? new ZaiOAuthClient() : new BigmodelOAuthClient());
    const resolver = new KeyResolver();
    this.resolveCredential = options.resolveCredential ?? ((accessToken, provider, userId) => resolver.resolveCodingPlanCredential(accessToken, provider, userId));
    this.onPoolChanged = options.onPoolChanged;
  }

  async start(provider: ProviderId, redirectUri: string): Promise<OAuthStartResult> {
    validateRedirectUri(redirectUri);
    const flowId = randomUUID();
    const callbackUrl = appendFlowId(redirectUri, flowId);
    const client = this.clientFactory(provider);
    const started = client.startWithCallback(callbackUrl);
    this.flows.set(flowId, {
      id: flowId,
      provider,
      client,
      state: started.state,
      callbackUrl: started.callbackUrl,
      authorizeUrl: started.authorizeUrl,
      status: "pending",
    });
    return { flowId, provider, authorizeUrl: started.authorizeUrl, callbackUrl: started.callbackUrl };
  }

  async callback(flowId: string, code: string, state: string): Promise<OAuthStatus> {
    const flow = this.flows.get(flowId);
    if (!flow) throw new Error("OAuth flow not found or expired");
    if (flow.status === "ready" || flow.status === "failed") return this.toStatus(flow);
    flow.status = "processing";
    try {
      flow.client.acceptCallback(code, state);
      const result = await flow.client.exchangeCode(code, flow.callbackUrl, state);
      const credential = await this.resolveCredential(result.accessToken, flow.provider, result.userId);
      if (credential.provider !== flow.provider) throw new Error("resolved credential provider mismatch");
      if (result.jwt) credential.jwt = result.jwt;
      if (result.userId && !credential.userId) credential.userId = result.userId;

      const existing = this.pool.findByCredential(flow.provider, credential);
      flow.account = existing ?? this.pool.add({
        id: flow.provider + "-oauth-" + flow.id.slice(0, 8),
        provider: flow.provider,
        credential,
        mode: "apikey",
      });
      this.onPoolChanged?.();
      flow.status = "ready";
    } catch (error) {
      flow.status = "failed";
      flow.error = (error as Error).message;
    } finally {
      await flow.client.close().catch(() => undefined);
    }
    return this.toStatus(flow);
  }

  status(flowId: string): OAuthStatus | null {
    const flow = this.flows.get(flowId);
    return flow ? this.toStatus(flow) : null;
  }

  async close(): Promise<void> {
    await Promise.all([...this.flows.values()].map((flow) => flow.client.close().catch(() => undefined)));
    this.flows.clear();
  }

  private toStatus(flow: OAuthFlow): OAuthStatus {
    return {
      flowId: flow.id,
      provider: flow.provider,
      status: flow.status,
      authorizeUrl: flow.authorizeUrl,
      ...(flow.account ? { account: flow.account } : {}),
      ...(flow.error ? { error: flow.error } : {}),
    };
  }
}

function appendFlowId(redirectUri: string, flowId: string): string {
  return redirectUri.replace(/\/+$/, "") + "/" + encodeURIComponent(flowId);
}

function validateRedirectUri(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("OAuth redirect URI must use http or https");
  if (url.username || url.password || url.hash) throw new Error("OAuth redirect URI must not contain credentials or fragment");
}
