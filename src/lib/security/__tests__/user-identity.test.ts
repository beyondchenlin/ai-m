import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { getUserIdFromRequest } from "@/lib/get-user-id";

const ORIGINAL = { ...process.env };

afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...ORIGINAL };
});

describe("user identity trust boundary", () => {
  it("ignores a spoofed browser header in production without an identity mode", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.AI_M_USER_IDENTITY_MODE;
    const request = new Request("http://localhost", { headers: { "x-user-id": "victim" } });
    expect(getUserIdFromRequest(request)).toBe("");
  });

  it("uses the configured principal in single-user mode", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.AI_M_USER_IDENTITY_MODE = "single-user";
    process.env.AI_M_SINGLE_USER_ID = "local-owner";
    const request = new Request("http://localhost", { headers: { "x-user-id": "attacker" } });
    expect(getUserIdFromRequest(request)).toBe("local-owner");
  });

  it("verifies timestamped trusted-proxy identity headers", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.AI_M_USER_IDENTITY_MODE = "trusted-proxy";
    process.env.AI_M_TRUSTED_USER_HEADER_SECRET = "s".repeat(40);
    const timestamp = Date.now().toString();
    const userId = "workspace-user";
    const nonce = "unique-proxy-nonce-0001";
    const signature = createHmac("sha256", process.env.AI_M_TRUSTED_USER_HEADER_SECRET)
      .update(`${timestamp}.${userId}.GET./.${nonce}`).digest("hex");
    const request = new Request("http://localhost", { headers: {
      "x-ai-m-authenticated-user": userId,
      "x-ai-m-user-timestamp": timestamp,
      "x-ai-m-user-signature": signature,
      "x-ai-m-user-nonce": nonce,
    } });
    expect(getUserIdFromRequest(request)).toBe(userId);
  });
});
