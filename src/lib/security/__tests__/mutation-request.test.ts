import { afterEach, describe, expect, it, vi } from "vitest";
import { assertMutationRequest } from "../mutation-request";
import { TRUSTED_PROXY_HEADER_NAMES } from "../trusted-proxy-auth";

const ADMIN_TOKEN = "a".repeat(64);
const LOCAL_CLIENT_TOKEN = "b".repeat(64);

function request(headers: HeadersInit = {}, url = "https://app.example/api/projects"): Request {
  return new Request(url, { method: "POST", headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("central mutation request boundary", () => {
  it("rejects browser mutations with missing, malformed, or cross-site evidence", () => {
    expect(() => assertMutationRequest(request({ cookie: "ai_comic_uid=u" })))
      .toThrow(/origin evidence/i);
    expect(() => assertMutationRequest(request({
      cookie: "ai_comic_uid=u",
      origin: "not a url",
    }))).toThrow(/origin header is invalid/i);
    expect(() => assertMutationRequest(request({
      cookie: "ai_comic_uid=u",
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    }))).toThrow(/cross-site|cross-origin/i);
  });

  it("accepts canonical same-origin browser evidence", () => {
    expect(assertMutationRequest(request({
      cookie: "ai_comic_uid=u",
      origin: "https://app.example",
      "sec-fetch-site": "same-origin",
    }))).toBe("browser");
  });

  it("rejects noncanonical origin and insecure production configuration", () => {
    expect(() => assertMutationRequest(request({
      origin: "https://app.example/",
    }))).toThrow(/canonical/i);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AI_M_PUBLIC_ORIGIN", "http://app.example");
    expect(() => assertMutationRequest(request({
      origin: "http://app.example",
    }, "http://app.example/api/projects"))).toThrow(/canonical HTTPS/i);
  });

  it("allows only a valid admin bearer without browser headers", () => {
    vi.stubEnv("AI_M_ADMIN_TOKEN", ADMIN_TOKEN);
    expect(assertMutationRequest(request({
      authorization: `Bearer ${ADMIN_TOKEN}`,
    }, "https://app.example/api/admin/backends"))).toBe("admin-service");
    expect(() => assertMutationRequest(request({
      authorization: "Bearer invalid",
    }, "https://app.example/api/admin/backends"))).toThrow(/authentication/i);
  });

  it("keeps a credential-free same-origin admin request on the browser boundary", () => {
    vi.stubEnv("AI_M_ADMIN_TOKEN", ADMIN_TOKEN);
    expect(assertMutationRequest(request({
      origin: "https://app.example",
      "sec-fetch-site": "same-origin",
    }, "https://app.example/api/admin/backends"))).toBe("browser");
  });

  it("does not let cookie presence downgrade a bearer request", () => {
    vi.stubEnv("AI_M_ADMIN_TOKEN", ADMIN_TOKEN);
    expect(() => assertMutationRequest(request({
      cookie: "ai_comic_uid=u",
      authorization: `Bearer ${ADMIN_TOKEN}`,
    }, "https://app.example/api/admin/backends"))).toThrow(/origin evidence/i);
  });

  it("recognizes the canonical trusted-proxy proof headers only in trusted-proxy mode", () => {
    vi.stubEnv("AI_M_USER_IDENTITY_MODE", "trusted-proxy");
    const headers = Object.fromEntries(
      TRUSTED_PROXY_HEADER_NAMES.map((header) => [header, "proof"]),
    );
    expect(assertMutationRequest(request(headers))).toBe("trusted-proxy-service");
    vi.stubEnv("AI_M_USER_IDENTITY_MODE", "single-user");
    expect(() => assertMutationRequest(request(headers))).toThrow(/origin evidence/i);
  });

  it("allows an authenticated local client without browser headers only in single-user mode", () => {
    vi.stubEnv("AI_M_USER_IDENTITY_MODE", "single-user");
    vi.stubEnv("AI_M_LOCAL_CLIENT_TOKEN", LOCAL_CLIENT_TOKEN);
    expect(assertMutationRequest(request({
      "x-ai-m-local-client-token": LOCAL_CLIENT_TOKEN,
    }))).toBe("local-client-service");
    expect(() => assertMutationRequest(request({
      "x-ai-m-local-client-token": "invalid",
    }))).toThrow(/origin evidence/i);
    vi.stubEnv("AI_M_USER_IDENTITY_MODE", "trusted-proxy");
    expect(() => assertMutationRequest(request({
      "x-ai-m-local-client-token": LOCAL_CLIENT_TOKEN,
    }))).toThrow(/origin evidence/i);
  });

  it("rejects credential-free non-browser mutations", () => {
    vi.stubEnv("AI_M_USER_IDENTITY_MODE", "single-user");
    expect(() => assertMutationRequest(request())).toThrow(/origin evidence/i);
  });
});
