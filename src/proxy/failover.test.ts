import { describe, expect, it } from "bun:test";
import { AccountPool } from "../auth/pool.js";
import { AuthManager } from "../auth/manager.js";
import { executeWithAccountFailover } from "./failover.js";
import { proxyRequest } from "./handler.js";
import type { ProxyConfig } from "../config/types.js";

describe("executeWithAccountFailover", () => {
  it("429 后释放第一个账号并切换到下一个账号", async () => {
    const pool = new AccountPool({ maxConcurrencyPerAccount: 1 });
    pool.add({ id: "zai-1", provider: "zai", credential: { apiKey: "key-1", provider: "zai" } });
    pool.add({ id: "zai-2", provider: "zai", credential: { apiKey: "key-2", provider: "zai" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", pool });
    const attempts: string[] = [];

    const result = await executeWithAccountFailover(auth, "zai", async (lease) => {
      attempts.push(lease.accountId);
      return attempts.length === 1
        ? new Response("rate limited", { status: 429 })
        : new Response("ok", { status: 200 });
    });

    expect(result.response.status).toBe(200);
    expect(result.lease?.accountId).toBe("zai-2");
    expect(attempts).toEqual(["zai-1", "zai-2"]);
    result.lease?.release();
    expect(pool.snapshot("zai-1")?.status).toBe("cooling");
    expect(pool.snapshot("zai-1")?.inFlight).toBe(0);
  });

  it("客户端请求错误不触发账号切换", async () => {
    const pool = new AccountPool();
    pool.add({ id: "zai-1", provider: "zai", credential: { apiKey: "key-1", provider: "zai" } });
    pool.add({ id: "zai-2", provider: "zai", credential: { apiKey: "key-2", provider: "zai" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", pool });
    const attempts: string[] = [];

    const result = await executeWithAccountFailover(auth, "zai", async (lease) => {
      attempts.push(lease.accountId);
      return new Response("bad request", { status: 400 });
    });

    expect(result.response.status).toBe(400);
    expect(attempts).toEqual(["zai-1"]);
    result.lease?.release();
    expect(pool.snapshot("zai-1")?.status).toBe("active");
    expect(pool.snapshot("zai-2")?.requestCount).toBe(0);
  });

  it("上游连接异常时切换账号，所有账号不可用时释放租约", async () => {
    const pool = new AccountPool({ maxConcurrencyPerAccount: 1, coolingSeconds: 60 });
    pool.add({ id: "zai-1", provider: "zai", credential: { apiKey: "key-1", provider: "zai" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", pool });

    await expect(
      executeWithAccountFailover(auth, "zai", async () => {
        throw new Error("connection reset");
      }),
    ).rejects.toThrow("connection reset");

    expect(pool.snapshot("zai-1")?.status).toBe("cooling");
    expect(pool.snapshot("zai-1")?.inFlight).toBe(0);
  });
});

describe("proxyRequest 账号池接入", () => {
  it("上游 429 后使用下一个账号继续完成 Anthropic 请求", async () => {
    const pool = new AccountPool({ maxConcurrencyPerAccount: 1 });
    pool.add({ id: "zai-1", provider: "zai", credential: { apiKey: "key-1", provider: "zai" } });
    pool.add({ id: "zai-2", provider: "zai", credential: { apiKey: "key-2", provider: "zai" } });
    const auth = new AuthManager({ mode: "apikey", provider: "zai", pool });
    const seenKeys: string[] = [];
    let call = 0;
    const config = {
      provider: "zai",
      plan: "coding-plan",
      providers: {
        zai: { anthropicBase: "https://api.z.ai/api/anthropic", openaiBase: "https://api.z.ai/api/coding/paas/v4" },
        bigmodel: { anthropicBase: "https://open.bigmodel.cn/api/anthropic", openaiBase: "https://open.bigmodel.cn/api/coding/paas/v4" },
      },
      identity: { appVersion: "test", sourceTitle: "test", refererOrigin: "https://zcode.z.ai" },
      clientIdentity: { mode: "off", ttlSeconds: 60, maxSessions: 10 },
    } as ProxyConfig;

    const response = await proxyRequest(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      }),
      "anthropic",
      {
        config,
        auth,
        fetchImpl: (async (input, init) => {
          const upstreamRequest = input instanceof Request ? input : new Request(input, init);
          seenKeys.push(upstreamRequest.headers.get("x-api-key") ?? "");
          call += 1;
          if (call === 1) return new Response("rate limited", { status: 429 });
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch,
        endpointRouting: null,
        clientSigning: null,
      },
    );

    expect(response.status).toBe(200);
    expect(seenKeys).toEqual(["key-1", "key-2"]);
    expect(pool.snapshot("zai-1")?.status).toBe("cooling");
    expect(pool.snapshot("zai-2")?.requestCount).toBe(1);
  });
});
