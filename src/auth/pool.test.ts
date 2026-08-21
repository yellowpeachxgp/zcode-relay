import { describe, expect, it } from "bun:test";
import type { Credential } from "./types.js";
import { AccountPool, type AccountStatus } from "./pool.js";

function credential(provider: Credential["provider"], apiKey: string): Credential {
  return { provider, apiKey };
}

describe("AccountPool", () => {
  it("按 provider 隔离并以 round-robin 顺序分配账号", () => {
    const pool = new AccountPool();
    pool.add({ id: "zai-1", provider: "zai", credential: credential("zai", "key-1") });
    pool.add({ id: "zai-2", provider: "zai", credential: credential("zai", "key-2") });
    pool.add({ id: "bigmodel-1", provider: "bigmodel", credential: credential("bigmodel", "key-bm") });

    const first = pool.acquire("zai");
    const second = pool.acquire("zai");
    const bigmodel = pool.acquire("bigmodel");

    expect(first?.accountId).toBe("zai-1");
    expect(second?.accountId).toBe("zai-2");
    expect(bigmodel?.accountId).toBe("bigmodel-1");
  });

  it("释放租约后账号可以再次被选择", () => {
    const pool = new AccountPool({ maxConcurrencyPerAccount: 1 });
    pool.add({ id: "zai-1", provider: "zai", credential: credential("zai", "key-1") });

    const lease = pool.acquire("zai");
    expect(pool.acquire("zai")).toBeNull();

    lease?.release();

    expect(pool.acquire("zai")?.accountId).toBe("zai-1");
  });

  it("跳过禁用、额度耗尽和冷却中的账号", () => {
    let now = 1_000;
    const pool = new AccountPool({ now: () => now, coolingSeconds: 30 });
    pool.add({ id: "zai-active", provider: "zai", credential: credential("zai", "active") });
    pool.add({ id: "zai-rate-limited", provider: "zai", credential: credential("zai", "rate") });
    pool.add({ id: "zai-exhausted", provider: "zai", credential: credential("zai", "exhausted") });
    pool.add({ id: "zai-disabled", provider: "zai", credential: credential("zai", "disabled") });

    pool.markFailure("zai-rate-limited", "rate_limit", "429");
    pool.markFailure("zai-exhausted", "quota", "quota");
    pool.setEnabled("zai-disabled", false);

    expect(pool.acquire("zai")?.accountId).toBe("zai-active");

    now += 31;
    pool.markSuccess("zai-rate-limited");
    expect(pool.snapshot("zai-rate-limited")?.status).toBe("active");
  });

  it("失败分类更新状态但不泄露完整凭据", () => {
    const pool = new AccountPool();
    pool.add({
      id: "zai-secret",
      provider: "zai",
      credential: credential("zai", "super-secret-api-key"),
    });

    pool.markFailure("zai-secret", "auth", "上游返回 401");

    const view = pool.snapshot("zai-secret");
    if (!view) throw new Error("expected account snapshot");
    expect(view?.status satisfies AccountStatus).toBe("invalid");
    expect(view?.credentialMasked).toContain("super-");
    expect(view?.credentialMasked).not.toBe("super-secret-api-key");
    expect(JSON.stringify(view)).not.toContain("super-secret-api-key");
  });
});
