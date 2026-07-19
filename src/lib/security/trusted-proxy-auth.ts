import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getSqlite } from "@/lib/db";
import { canonicalize } from "@/lib/generation/workflows/canonical";

const USER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const COMPONENT_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/;
const BODY_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PROOF_VERSION = "2";
const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export const TRUSTED_PROXY_HEADER_NAMES = Object.freeze([
  "x-ai-m-auth-version",
  "x-ai-m-auth-issuer",
  "x-ai-m-auth-key-id",
  "x-ai-m-authenticated-user",
  "x-ai-m-user-timestamp",
  "x-ai-m-user-nonce",
  "x-ai-m-body-sha256",
  "x-ai-m-user-signature",
] as const);

export function hasCompleteTrustedProxyProofHeaders(request: Request): boolean {
  return TRUSTED_PROXY_HEADER_NAMES.every(
    (name) => Boolean(request.headers.get(name)?.trim()),
  );
}

export class TrustedProxyAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TrustedProxyAuthError";
  }
}

function header(request: Request, name: string): string {
  return request.headers.get(name)?.trim() ?? "";
}

export function decodeTrustedProxySecret(encoded: string | undefined): Buffer {
  const value = encoded?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TrustedProxyAuthError("trusted_proxy_secret_encoding_invalid");
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    throw new TrustedProxyAuthError("trusted_proxy_secret_encoding_invalid");
  }
  if (decoded.toString("base64url") !== value.replace(/=+$/, "")) {
    throw new TrustedProxyAuthError("trusted_proxy_secret_encoding_invalid");
  }
  if (decoded.length < 32 || new Set(decoded).size < 16) {
    throw new TrustedProxyAuthError("trusted_proxy_secret_entropy_insufficient");
  }
  return decoded;
}

async function digestBody(request: Request): Promise<string> {
  const hash = createHash("sha256");
  const body = request.clone().body;
  if (!body) return `sha256:${hash.digest("hex")}`;
  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) throw new TrustedProxyAuthError("trusted_proxy_body_too_large");
      hash.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return `sha256:${hash.digest("hex")}`;
}

export function buildTrustedProxyProof(input: {
  issuer: string;
  keyId: string;
  userId: string;
  timestampMs: number;
  nonce: string;
  scheme: string;
  authority: string;
  method: string;
  pathAndQuery: string;
  bodySha256: string;
}): string {
  return canonicalize({
    version: PROOF_VERSION,
    issuer: input.issuer,
    keyId: input.keyId,
    userId: input.userId,
    timestampMs: input.timestampMs,
    nonce: input.nonce,
    scheme: input.scheme,
    authority: input.authority,
    method: input.method,
    pathAndQuery: input.pathAndQuery,
    bodySha256: input.bodySha256,
  });
}

function reserveNonce(input: {
  issuer: string;
  keyId: string;
  nonce: string;
  nowMs: number;
  expiresAtMs: number;
}): void {
  const sqlite = getSqlite();
  const transaction = sqlite.transaction(() => {
    sqlite.prepare(`
      DELETE FROM trusted_proxy_nonces
      WHERE rowid IN (
        SELECT rowid FROM trusted_proxy_nonces
        WHERE expires_at_ms <= ?
        ORDER BY expires_at_ms
        LIMIT 100
      )
    `).run(input.nowMs);
    sqlite.prepare(`
      INSERT INTO trusted_proxy_nonces (issuer, key_id, nonce, expires_at_ms, created_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.issuer, input.keyId, input.nonce, input.expiresAtMs, input.nowMs);
  });
  try {
    transaction.immediate();
  } catch (error) {
    if (typeof error === "object" && error !== null
      && "code" in error && String((error as { code?: unknown }).code).startsWith("SQLITE_CONSTRAINT")) {
      throw new TrustedProxyAuthError("trusted_proxy_proof_replayed");
    }
    throw error;
  }
}

export async function verifyTrustedProxyRequest(
  request: Request,
  options: { nowMs?: number; reserve?: typeof reserveNonce } = {},
): Promise<string> {
  if (header(request, "x-ai-m-auth-version") !== PROOF_VERSION) {
    throw new TrustedProxyAuthError("trusted_proxy_version_invalid");
  }
  const issuer = header(request, "x-ai-m-auth-issuer");
  const keyId = header(request, "x-ai-m-auth-key-id");
  const userId = header(request, "x-ai-m-authenticated-user");
  const timestampText = header(request, "x-ai-m-user-timestamp");
  const nonce = header(request, "x-ai-m-user-nonce");
  const claimedBodyDigest = header(request, "x-ai-m-body-sha256").toLowerCase();
  const signature = header(request, "x-ai-m-user-signature").toLowerCase();
  if (!COMPONENT_PATTERN.test(issuer) || !COMPONENT_PATTERN.test(keyId)
    || !USER_ID_PATTERN.test(userId) || !NONCE_PATTERN.test(nonce)
    || !/^\d{13}$/.test(timestampText) || !BODY_DIGEST_PATTERN.test(claimedBodyDigest)
    || !SIGNATURE_PATTERN.test(signature)) {
    throw new TrustedProxyAuthError("trusted_proxy_headers_invalid");
  }
  const timestampMs = Number(timestampText);
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(timestampMs)
    || timestampMs + MAX_CLOCK_SKEW_MS <= nowMs
    || timestampMs - MAX_CLOCK_SKEW_MS > nowMs) {
    throw new TrustedProxyAuthError("trusted_proxy_timestamp_invalid");
  }
  const actualBodyDigest = await digestBody(request);
  if (actualBodyDigest !== claimedBodyDigest) {
    throw new TrustedProxyAuthError("trusted_proxy_body_digest_mismatch");
  }
  const url = new URL(request.url);
  const proof = buildTrustedProxyProof({
    issuer,
    keyId,
    userId,
    timestampMs,
    nonce,
    scheme: url.protocol.slice(0, -1).toLowerCase(),
    authority: url.host.toLowerCase(),
    method: request.method.toUpperCase(),
    pathAndQuery: `${url.pathname}${url.search}`,
    bodySha256: actualBodyDigest,
  });
  const secret = decodeTrustedProxySecret(process.env.AI_M_TRUSTED_USER_HEADER_SECRET);
  const expected = createHmac("sha256", secret).update(proof).digest();
  const actual = Buffer.from(signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new TrustedProxyAuthError("trusted_proxy_signature_invalid");
  }
  (options.reserve ?? reserveNonce)({
    issuer,
    keyId,
    nonce,
    nowMs,
    expiresAtMs: timestampMs + MAX_CLOCK_SKEW_MS,
  });
  return userId;
}
