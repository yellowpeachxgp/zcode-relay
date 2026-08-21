import { describe, expect, it } from "bun:test";
import { AccountPool } from "../auth/pool.js";
import { AuthManager } from "../auth/manager.js";
import { handleInternalRoute } from "./internal-routes.js";
import type { ProxyConfig } from "../config/types.js";

function makeConfig(): ProxyConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    auth: { mode: "apikey", apiKey: "fallback" },
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
      bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: { appVersion: "test", sourceTitle: "test", refererOrigin: "https://zcode.z.ai" },
    clientIdentity: { mode: "off", ttlSeconds: 60, maxSessions: 10 },
    responses: { enabled: false, storeMaxEntries: 10, storeTtlMs: 1000 },
    endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
    clientSigning: { enabled: false, origin: "https://zcode.z.ai" },
    mcp: { enabled: false, webSearch: false, webReader: false, zread: false },
    async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 100, keepAliveIntervalMs: 100, maxWaitMs: 0, maxRetries: 0, settleTimeoutMs: 100, controlTimeoutMs: 100, defaultModel: "" },
    logging: { level: "info" },
    control: { enabled: true, adminKey: "control-secret" },
  };
}

function auth(pool = new AccountPool()): { config: ProxyConfig; auth: AuthManager } {
  return { config: makeConfig(), auth: new AuthManager({ mode: "apikey", provider: "zai", pool }) };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request("http://localhost" + path, init);
}

describe("internal control routes", () => {
  it("requires the independent control key", async () => {
    const result = auth();
    const response = await handleInternalRoute(request("/internal/accounts"), result);
    expect(response?.status).toBe(401);
  });

  it("lists accounts without returning the raw credential", async () => {
    const pool = new AccountPool();
    pool.add({ id: "zai-1", provider: "zai", credential: { apiKey: "super-secret", provider: "zai" } });
    const result = auth(pool);
    const response = await handleInternalRoute(request("/internal/accounts", { headers: { authorization: "Bearer control-secret" } }), result);
    const body = await response?.json();

    expect(response?.status).toBe(200);
    expect(body.accounts[0].credentialMasked).toBe("********");
    expect(JSON.stringify(body)).not.toContain("super-secret");
  });

  it("creates, disables and removes an account through the control contract", async () => {
    const result = auth();
    const headers = { authorization: "Bearer control-secret", "content-type": "application/json" };
    const created = await handleInternalRoute(request("/internal/accounts", {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "zai-2", provider: "zai", credential: "key-2.secret" }),
    }), result);
    expect(created?.status).toBe(201);
    expect(JSON.stringify(await created?.json())).not.toContain("key-2.secret");

    const disabled = await handleInternalRoute(request("/internal/accounts/zai-2/disable", { method: "POST", headers }), result);
    expect((await disabled?.json()).account.enabled).toBe(false);

    const removed = await handleInternalRoute(request("/internal/accounts/zai-2", { method: "DELETE", headers }), result);
    expect(removed?.status).toBe(200);
    expect(result.auth.getPool()?.snapshot("zai-2")).toBeNull();
  });

  it("reuses an existing account for a repeated credential", async () => {
    const pool = new AccountPool();
    pool.add({ id: "zai-existing", provider: "zai", credential: { apiKey: "same-key", provider: "zai" } });
    const result = auth(pool);
    const response = await handleInternalRoute(request("/internal/accounts", {
      method: "POST",
      headers: { authorization: "control-secret", "content-type": "application/json" },
      body: JSON.stringify({ id: "another-id", provider: "zai", credential: "same-key" }),
    }), result);

    expect(response?.status).toBe(200);
    expect((await response?.json()).existed).toBe(true);
    expect(pool.list()).toHaveLength(1);
  });

  it("returns runtime and usage summaries", async () => {
    const pool = new AccountPool();
    pool.add({ id: "zai-1", provider: "zai", credential: { apiKey: "key-1", provider: "zai" } });
    pool.markSuccess("zai-1");
    const result = auth(pool);
    const headers = { authorization: "control-secret" };

    const runtime = await handleInternalRoute(request("/internal/runtime", { headers }), result);
    const usage = await handleInternalRoute(request("/internal/usage/summary", { headers }), result);
    expect((await runtime?.json()).pool.total).toBe(1);
    expect((await usage?.json()).totalRequests).toBe(1);
  });
});
