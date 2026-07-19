import { createHash, createHmac, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTrustedProxyProof,
  decodeTrustedProxySecret,
  verifyTrustedProxyRequest,
} from "../trusted-proxy-auth";

const ORIGINAL = { ...process.env };

afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...ORIGINAL };
});

function signedRequest(input: {
  url?: string;
  method?: string;
  body?: string;
  secret: Buffer;
  nowMs: number;
  nonce?: string;
}): Request {
  const url = new URL(input.url ?? "https://app.example.test/api/projects?a=1&b=%2F");
  const method = input.method ?? "POST";
  const body = input.body ?? "{\"value\":1}";
  const bodySha256 = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const issuer = "edge-gateway";
  const keyId = "primary-2026";
  const userId = "workspace-user";
  const nonce = input.nonce ?? "unique-proxy-nonce-0001";
  const proof = buildTrustedProxyProof({
    issuer,
    keyId,
    userId,
    timestampMs: input.nowMs,
    nonce,
    scheme: url.protocol.slice(0, -1),
    authority: url.host,
    method,
    pathAndQuery: `${url.pathname}${url.search}`,
    bodySha256,
  });
  return new Request(url, {
    method,
    body: ["GET", "HEAD"].includes(method) ? undefined : body,
    headers: {
      "content-type": "application/json",
      "x-ai-m-auth-version": "2",
      "x-ai-m-auth-issuer": issuer,
      "x-ai-m-auth-key-id": keyId,
      "x-ai-m-authenticated-user": userId,
      "x-ai-m-user-timestamp": String(input.nowMs),
      "x-ai-m-user-nonce": nonce,
      "x-ai-m-body-sha256": bodySha256,
      "x-ai-m-user-signature": createHmac("sha256", input.secret).update(proof).digest("hex"),
    },
  });
}

describe("trusted proxy request proof", () => {
  it("accepts one exact request and reserves its scoped nonce", async () => {
    const secret = randomBytes(32);
    process.env.AI_M_TRUSTED_USER_HEADER_SECRET = secret.toString("base64url");
    const nowMs = 2_000_000_000_000;
    const reservations: unknown[] = [];
    await expect(verifyTrustedProxyRequest(signedRequest({ secret, nowMs }), {
      nowMs,
      reserve: (input) => { reservations.push(input); },
    })).resolves.toBe("workspace-user");
    expect(reservations).toEqual([expect.objectContaining({
      issuer: "edge-gateway",
      keyId: "primary-2026",
      nonce: "unique-proxy-nonce-0001",
    })]);
  });

  it.each([
    ["scheme", { url: "http://app.example.test/api/projects?a=1&b=%2F" }],
    ["authority", { url: "https://other.example.test/api/projects?a=1&b=%2F" }],
    ["method", { method: "PUT" }],
    ["path", { url: "https://app.example.test/api/other?a=1&b=%2F" }],
    ["query order", { url: "https://app.example.test/api/projects?b=%2F&a=1" }],
    ["query encoding", { url: "https://app.example.test/api/projects?a=1&b=%2f" }],
    ["body", { body: "{\"value\":2}" }],
  ])("rejects a signed request after %s mutation", async (_name, mutation) => {
    const secret = randomBytes(32);
    process.env.AI_M_TRUSTED_USER_HEADER_SECRET = secret.toString("base64url");
    const nowMs = 2_000_000_000_000;
    const original = signedRequest({ secret, nowMs });
    const mutated = new Request(
      "url" in mutation ? mutation.url : original.url,
      {
        method: "method" in mutation ? mutation.method : original.method,
        body: "body" in mutation ? mutation.body : await original.clone().text(),
        headers: original.headers,
      },
    );
    await expect(verifyTrustedProxyRequest(mutated, { nowMs, reserve: () => undefined }))
      .rejects.toThrow(/signature|body[_ ]digest/i);
  });

  it("rejects stale and future proofs before reserving a nonce", async () => {
    const secret = randomBytes(32);
    process.env.AI_M_TRUSTED_USER_HEADER_SECRET = secret.toString("base64url");
    const nowMs = 2_000_000_000_000;
    await expect(verifyTrustedProxyRequest(signedRequest({ secret, nowMs: nowMs - 60_000 }), {
      nowMs,
      reserve: () => { throw new Error("must not reserve"); },
    })).rejects.toThrow(/timestamp/i);
    await expect(verifyTrustedProxyRequest(signedRequest({ secret, nowMs: nowMs + 60_001 }), {
      nowMs,
      reserve: () => { throw new Error("must not reserve"); },
    })).rejects.toThrow(/timestamp/i);
  });
});

describe("trusted proxy decoded secret policy", () => {
  it("rejects long low-entropy text and short decoded base64url", () => {
    expect(() => decodeTrustedProxySecret("a".repeat(64))).toThrow(/entropy/i);
    expect(() => decodeTrustedProxySecret(randomBytes(16).toString("base64url"))).toThrow(/entropy/i);
  });

  it("accepts at least 32 high-entropy decoded bytes", () => {
    const secret = randomBytes(32);
    expect(decodeTrustedProxySecret(secret.toString("base64url"))).toEqual(secret);
  });
});
