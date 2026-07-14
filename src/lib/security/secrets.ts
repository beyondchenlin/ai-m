import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const LEGACY_ENVELOPE_PREFIX = "enc:v1:";
const ENVELOPE_PREFIX = "enc:v2:";

export class SecretConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretConfigurationError";
  }
}

interface KeyMaterial {
  id: string;
  value: Buffer;
}

function decodeKey(encoded: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(encoded)
    ? Buffer.from(encoded, "hex")
    : Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new SecretConfigurationError("Secret master keys must decode to exactly 32 bytes");
  return key;
}

function keyId(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function loadKeyring(): KeyMaterial[] {
  const primary = process.env.AI_M_SECRET_MASTER_KEY?.trim();
  if (!primary) throw new SecretConfigurationError("AI_M_SECRET_MASTER_KEY is required");
  const encodedKeys = [
    primary,
    ...(process.env.AI_M_SECRET_PREVIOUS_KEYS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  ];
  const seen = new Set<string>();
  const keys: KeyMaterial[] = [];
  for (const encoded of encodedKeys) {
    const value = decodeKey(encoded);
    const id = keyId(value);
    if (seen.has(id)) continue;
    seen.add(id);
    keys.push({ id, value });
  }
  return keys;
}

function decryptWithKey(payload: Buffer, key: Buffer): string {
  if (payload.length < 29) throw new Error("Encrypted secret envelope is malformed");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) throw new Error("Secret value cannot be empty");
  const primary = loadKeyring()[0];
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", primary.value, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}${primary.id}:${Buffer.concat([iv, tag, ciphertext]).toString("base64")}`;
}

export function decryptSecret(envelope: string): string {
  const keyring = loadKeyring();
  if (envelope.startsWith(ENVELOPE_PREFIX)) {
    const remainder = envelope.slice(ENVELOPE_PREFIX.length);
    const separator = remainder.indexOf(":");
    if (separator <= 0) throw new Error("Encrypted secret envelope is malformed");
    const id = remainder.slice(0, separator);
    const key = keyring.find((candidate) => candidate.id === id);
    if (!key) throw new SecretConfigurationError(`Secret key ${id} is not available in the configured keyring`);
    return decryptWithKey(Buffer.from(remainder.slice(separator + 1), "base64"), key.value);
  }

  if (envelope.startsWith(LEGACY_ENVELOPE_PREFIX)) {
    const payload = Buffer.from(envelope.slice(LEGACY_ENVELOPE_PREFIX.length), "base64");
    for (const key of keyring) {
      try { return decryptWithKey(payload, key.value); } catch { /* try the next rotation key */ }
    }
    throw new SecretConfigurationError("Legacy encrypted secret could not be decrypted by the configured keyring");
  }

  if (process.env.NODE_ENV !== "production" && process.env.AI_M_ALLOW_LEGACY_PLAINTEXT_KEYS === "true") {
    return envelope;
  }
  throw new SecretConfigurationError("Legacy plaintext secret is not permitted");
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX) || value.startsWith(LEGACY_ENVELOPE_PREFIX);
}
