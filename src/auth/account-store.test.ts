import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountPool } from "./pool.js";
import { AccountStore } from "./account-store.js";

describe("AccountStore", () => {
  it("encrypts credentials and restores the account pool", () => {
    const directory = mkdtempSync(join(tmpdir(), "zcode-relay-store-"));
    const path = join(directory, "accounts.enc.json");
    try {
      const pool = new AccountPool();
      pool.add({ id: "zai-1", provider: "zai", credential: { apiKey: "api-key", secret: "secret", provider: "zai" } });
      const store = new AccountStore({ path, secret: "admin-secret" });
      store.save(pool);

      const encrypted = readFileSync(path, "utf8");
      expect(encrypted).not.toContain("api-key");
      expect(encrypted).not.toContain("secret");
      expect(statSync(path).mode & 0o777).toBe(0o600);

      const restored = new AccountPool();
      expect(store.load(restored)).toBe(1);
      expect(restored.exportInputs()[0].credential).toEqual({ apiKey: "api-key", secret: "secret", provider: "zai" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
