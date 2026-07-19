import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { buildTrustedProxyProof } from "@/lib/security/trusted-proxy-auth";
import { setupTestDb, type TestDbContext } from "@/lib/test-helpers/db";

const ORIGINAL = { ...process.env };

afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...ORIGINAL };
});

describe("user identity trust boundary", () => {
  let ctx: TestDbContext;
  beforeAll(() => { ctx = setupTestDb(); });
  afterAll(() => ctx.cleanup());

  it("ignores a spoofed browser header in production without an identity mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.AI_M_USER_IDENTITY_MODE;
    const request = new Request("http://localhost", { headers: { "x-user-id": "victim" } });
    await expect(getUserIdFromRequest(request)).resolves.toBe("");
  });

  it("uses the configured principal in single-user mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.AI_M_USER_IDENTITY_MODE = "single-user";
    process.env.AI_M_SINGLE_USER_ID = "local-owner";
    const request = new Request("http://localhost", { headers: { "x-user-id": "attacker" } });
    await expect(getUserIdFromRequest(request)).resolves.toBe("local-owner");
  });

  it("verifies a versioned request-bound trusted-proxy identity", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.AI_M_USER_IDENTITY_MODE = "trusted-proxy";
    const secret = randomBytes(32);
    process.env.AI_M_TRUSTED_USER_HEADER_SECRET = secret.toString("base64url");
    const timestamp = Date.now().toString();
    const userId = "workspace-user";
    const nonce = "unique-proxy-nonce-0001";
    const bodySha256 = `sha256:${createHash("sha256").update("").digest("hex")}`;
    const signature = createHmac("sha256", secret)
      .update(buildTrustedProxyProof({
        issuer: "edge-gateway",
        keyId: "primary-2026",
        userId,
        timestampMs: Number(timestamp),
        nonce,
        scheme: "http",
        authority: "localhost",
        method: "GET",
        pathAndQuery: "/",
        bodySha256,
      })).digest("hex");
    const request = new Request("http://localhost", { headers: {
      "x-ai-m-auth-version": "2",
      "x-ai-m-auth-issuer": "edge-gateway",
      "x-ai-m-auth-key-id": "primary-2026",
      "x-ai-m-authenticated-user": userId,
      "x-ai-m-user-timestamp": timestamp,
      "x-ai-m-user-signature": signature,
      "x-ai-m-user-nonce": nonce,
      "x-ai-m-body-sha256": bodySha256,
    } });
    await expect(getUserIdFromRequest(request)).resolves.toBe(userId);
  });
});
