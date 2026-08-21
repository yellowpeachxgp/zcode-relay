import { describe, expect, it } from "bun:test";
import { AccountPool } from "./pool.js";
import { QuotaMonitor } from "./quota.js";

describe("QuotaMonitor", () => {
  it("读取 provider balance 并写入账号 quota 快照", async () => {
    const pool = new AccountPool();
    pool.add({ id: "zai-1", provider: "zai", credential: { apiKey: "key-1", provider: "zai" } });
    const monitor = new QuotaMonitor(pool, {
      enabled: true,
      intervalSeconds: 60,
      timeoutMs: 1000,
      endpoints: { zai: "https://quota.test/api", bigmodel: "" },
    }, (async () => new Response(JSON.stringify({ data: { balances: [{ total_units: 10, used_units: 6, remaining_units: 4 }] } }), { status: 200 })) as unknown as typeof fetch);

    const result = await monitor.checkAccount("zai-1");

    expect(result.status).toBe("healthy");
    expect(result.remaining).toBe(4);
    expect(pool.snapshot("zai-1")?.quota.remaining).toBe(4);
    expect(pool.snapshot("zai-1")?.quota.limit).toBe(10);
  });

  it("余额耗尽时将账号标记为 exhausted 并从选择池移除", async () => {
    const pool = new AccountPool();
    pool.add({ id: "zai-1", provider: "zai", credential: { apiKey: "key-1", provider: "zai" } });
    const monitor = new QuotaMonitor(pool, {
      enabled: true,
      intervalSeconds: 60,
      timeoutMs: 1000,
      endpoints: { zai: "https://quota.test/api", bigmodel: "" },
    }, (async () => new Response(JSON.stringify({ data: { remaining: 0, limit: 10, used: 10 } }), { status: 200 })) as unknown as typeof fetch);

    const result = await monitor.checkAccount("zai-1");

    expect(result.status).toBe("exhausted");
    expect(pool.snapshot("zai-1")?.status).toBe("exhausted");
    expect(pool.acquire("zai")).toBeNull();
  });

  it("provider 未配置巡检端点时不发起网络请求并返回 unknown", async () => {
    const pool = new AccountPool();
    pool.add({ id: "bigmodel-1", provider: "bigmodel", credential: { apiKey: "key-1", provider: "bigmodel" } });
    let calls = 0;
    const monitor = new QuotaMonitor(pool, {
      enabled: true,
      intervalSeconds: 60,
      timeoutMs: 1000,
      endpoints: { zai: "", bigmodel: "" },
    }, (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);

    const result = await monitor.checkAccount("bigmodel-1");

    expect(result.status).toBe("unknown");
    expect(calls).toBe(0);
    expect(pool.snapshot("bigmodel-1")?.status).toBe("active");
  });
});
