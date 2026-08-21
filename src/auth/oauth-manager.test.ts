import { describe, expect, it } from "bun:test";
import { AccountPool } from "./pool.js";
import { OAuthManager } from "./oauth-manager.js";

describe("OAuthManager", () => {
  it("completes auth-code exchange, resolves an API key and inserts it into the core pool", async () => {
    const pool = new AccountPool();
    const fakeClient = {
      startWithCallback: (callbackUrl: string) => ({ authorizeUrl: "https://chat.z.ai/authorize", callbackUrl, state: "state-1" }),
      acceptCallback: (code: string, state: string) => ({ code, state }),
      exchangeCode: async () => ({ accessToken: "oauth-access", userId: "user-1", jwt: "plan-jwt" }),
      close: async () => undefined,
    };
    const manager = new OAuthManager(pool, {
      clientFactory: () => fakeClient,
      resolveCredential: async (accessToken, provider, userId) => ({ apiKey: "api-key", secret: "secret", provider, userId, jwt: accessToken === "oauth-access" ? "plan-jwt" : undefined }),
    });

    const started = await manager.start("zai", "http://panel/admin/api/login/callback/flow-1");
    expect(started.flowId).toBeTruthy();
    expect((await manager.callback(started.flowId, "auth-code", "state-1")).status).toBe("ready");
    const accounts = pool.list();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].credentialMasked).toBe("api-key.…cret");
    expect(accounts[0].mode).toBe("apikey");
  });

  it("rejects a callback with the wrong state without touching the pool", async () => {
    const pool = new AccountPool();
    const fakeClient = {
      startWithCallback: (callbackUrl: string) => ({ authorizeUrl: "https://chat.z.ai/authorize", callbackUrl, state: "expected" }),
      acceptCallback: () => { throw new Error("OAuth callback state mismatch"); },
      exchangeCode: async () => ({ accessToken: "unused" }),
      close: async () => undefined,
    };
    const manager = new OAuthManager(pool, { clientFactory: () => fakeClient, resolveCredential: async () => ({ apiKey: "unused", provider: "zai" }) });
    const started = await manager.start("zai", "http://panel/callback");
    const result = await manager.callback(started.flowId, "code", "wrong");

    expect(result.status).toBe("failed");
    expect(pool.list()).toHaveLength(0);
  });
});
