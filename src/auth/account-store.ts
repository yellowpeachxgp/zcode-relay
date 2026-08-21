import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, chmodSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { credentialString, type Credential } from "./types.js";
import { createApiKeyCredential } from "./apikey.js";
import type { AccountPool } from "./pool.js";
import type { AccountPoolInput } from "./pool-types.js";
import type { ProviderId } from "../provider/types.js";

const VERSION = "zcode-relay-account-store-v1";
const SALT = Buffer.from(VERSION, "utf8");

interface StoredAccount {
  id: string;
  provider: ProviderId;
  mode: "apikey" | "oauth";
  enabled: boolean;
  maxConcurrency: number;
  credential: string;
  jwt?: string;
  userId?: string;
  expiresAt?: number;
}

interface StoredDocument {
  version: 1;
  accounts: StoredAccount[];
}

export interface AccountStoreOptions {
  path: string;
  secret: string;
}

/** AES-GCM encrypted account store. The plaintext credential never leaves this module during normal persistence. */
export class AccountStore {
  private readonly path: string;
  private readonly key: Buffer;

  constructor(options: AccountStoreOptions) {
    if (!options.secret.trim()) throw new Error("account store secret must not be empty");
    this.path = options.path;
    this.key = scryptSync(options.secret, SALT, 32);
  }

  load(pool: AccountPool): number {
    if (!existsSync(this.path)) return 0;
    const raw = readFileSync(this.path, "utf8");
    const document = this.decrypt(raw);
    let loaded = 0;
    for (const stored of document.accounts) {
      try {
        pool.add(toPoolInput(stored));
        loaded += 1;
      } catch {
        // 单个损坏或重复账号不应阻止其余账号加载。
      }
    }
    return loaded;
  }

  save(pool: AccountPool): void {
    const document: StoredDocument = {
      version: 1,
      accounts: pool.exportInputs().map(fromPoolInput),
    };
    const directory = dirname(this.path);
    if (directory && directory !== ".") mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(this.path, this.encrypt(document), { encoding: "utf8", mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  private encrypt(document: StoredDocument): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(SALT);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(document), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  private decrypt(value: string): StoredDocument {
    const parts = value.trim().split(".");
    if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("invalid account store format");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(parts[1], "base64url"));
    decipher.setAAD(SALT);
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plaintext) as StoredDocument;
    if (parsed.version !== 1 || !Array.isArray(parsed.accounts)) throw new Error("invalid account store document");
    return parsed;
  }
}

function fromPoolInput(input: AccountPoolInput): StoredAccount {
  return {
    id: input.id,
    provider: input.provider,
    mode: input.mode ?? "apikey",
    enabled: input.enabled !== false,
    maxConcurrency: input.maxConcurrency ?? 4,
    credential: credentialString(input.credential),
    ...(input.credential.jwt ? { jwt: input.credential.jwt } : {}),
    ...(input.credential.userId ? { userId: input.credential.userId } : {}),
    ...(input.credential.expiresAt ? { expiresAt: input.credential.expiresAt } : {}),
  };
}

function toPoolInput(input: StoredAccount): AccountPoolInput {
  const credential: Credential = input.mode === "oauth"
    ? { apiKey: input.credential, jwt: input.jwt ?? input.credential, provider: input.provider }
    : { ...createApiKeyCredential(input.provider, input.credential), ...(input.jwt ? { jwt: input.jwt } : {}), ...(input.userId ? { userId: input.userId } : {}), ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) };
  return { id: input.id, provider: input.provider, mode: input.mode, enabled: input.enabled, maxConcurrency: input.maxConcurrency, credential };
}
