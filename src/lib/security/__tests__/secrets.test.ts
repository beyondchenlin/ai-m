import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../secrets";

const original = {
  primary: process.env.AI_M_SECRET_MASTER_KEY,
  previous: process.env.AI_M_SECRET_PREVIOUS_KEYS,
  legacy: process.env.AI_M_ALLOW_LEGACY_PLAINTEXT_KEYS,
  nodeEnv: process.env.NODE_ENV,
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  vi.unstubAllEnvs();
  restoreEnv("AI_M_SECRET_MASTER_KEY", original.primary);
  restoreEnv("AI_M_SECRET_PREVIOUS_KEYS", original.previous);
  restoreEnv("AI_M_ALLOW_LEGACY_PLAINTEXT_KEYS", original.legacy);
  restoreEnv("NODE_ENV", original.nodeEnv);
});

describe("PR-12 secret envelopes", () => {
  it("encrypts with an authenticated versioned envelope", () => {
    process.env.AI_M_SECRET_MASTER_KEY = Buffer.alloc(32, 1).toString("base64");
    const envelope = encryptSecret("top-secret");
    expect(envelope.startsWith("enc:v2:")).toBe(true);
    expect(isEncryptedSecret(envelope)).toBe(true);
    expect(decryptSecret(envelope)).toBe("top-secret");
    expect(envelope).not.toContain("top-secret");
  });

  it("decrypts after key rotation using the previous keyring", () => {
    const oldKey = Buffer.alloc(32, 2).toString("base64");
    const newKey = Buffer.alloc(32, 3).toString("base64");
    process.env.AI_M_SECRET_MASTER_KEY = oldKey;
    const envelope = encryptSecret("rotatable");
    process.env.AI_M_SECRET_MASTER_KEY = newKey;
    process.env.AI_M_SECRET_PREVIOUS_KEYS = oldKey;
    expect(decryptSecret(envelope)).toBe("rotatable");
  });

  it("rejects plaintext secrets in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.AI_M_SECRET_MASTER_KEY = Buffer.alloc(32, 4).toString("base64");
    expect(() => decryptSecret("plaintext")).toThrow(/not permitted/i);
  });
});
