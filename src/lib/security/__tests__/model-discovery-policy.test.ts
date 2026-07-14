import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  default: {
    lookup: vi.fn(async (hostname: string) => {
      if (hostname === "api.openai.com") return [{ address: "104.18.7.192", family: 4 }];
      if (hostname === "allowed.example.com") return [{ address: "8.8.8.8", family: 4 }];
      return [{ address: "127.0.0.1", family: 4 }];
    }),
  },
}));

import { assertModelDiscoveryUrl } from "../model-discovery-policy";

describe("model discovery network policy", () => {
  afterEach(() => {
    delete process.env.AI_M_MODEL_DISCOVERY_HOST_ALLOWLIST;
    delete process.env.AI_M_MODEL_DISCOVERY_PORT_ALLOWLIST;
    delete process.env.AI_M_MODEL_DISCOVERY_ALLOW_HTTP;
    delete process.env.AI_M_MODEL_DISCOVERY_ALLOW_PRIVATE_HOSTS;
  });

  it("allows the official protocol host", async () => {
    await expect(assertModelDiscoveryUrl({ protocol: "openai", baseUrl: "https://api.openai.com/v1" }))
      .resolves.toMatchObject({ hostname: "api.openai.com", protocol: "https:" });
  });

  it("requires explicit allowlisting for custom compatible endpoints", async () => {
    await expect(assertModelDiscoveryUrl({ protocol: "openai", baseUrl: "https://allowed.example.com/v1" }))
      .rejects.toThrow(/allowlist/i);
    process.env.AI_M_MODEL_DISCOVERY_HOST_ALLOWLIST = "allowed.example.com";
    await expect(assertModelDiscoveryUrl({ protocol: "openai", baseUrl: "https://allowed.example.com/v1" }))
      .resolves.toMatchObject({ hostname: "allowed.example.com" });
  });

  it("rejects private and loopback address targets even when allowlisted", async () => {
    process.env.AI_M_MODEL_DISCOVERY_HOST_ALLOWLIST = "127.0.0.1";
    await expect(assertModelDiscoveryUrl({ protocol: "openai", baseUrl: "https://127.0.0.1/v1" }))
      .rejects.toThrow(/blocked network/i);
  });

  it("rejects IPv4-mapped IPv6 loopback literals in hexadecimal form", async () => {
    process.env.AI_M_MODEL_DISCOVERY_HOST_ALLOWLIST = "::ffff:7f00:1";
    await expect(assertModelDiscoveryUrl({ protocol: "openai", baseUrl: "https://[::ffff:7f00:1]/v1" }))
      .rejects.toThrow(/blocked network/i);
  });

  it("allows an exact private host only behind the explicit compatibility switch", async () => {
    process.env.AI_M_MODEL_DISCOVERY_HOST_ALLOWLIST = "127.0.0.1";
    process.env.AI_M_MODEL_DISCOVERY_ALLOW_PRIVATE_HOSTS = "true";
    await expect(assertModelDiscoveryUrl({ protocol: "openai", baseUrl: "https://127.0.0.1/v1" }))
      .resolves.toMatchObject({ protocol: "https:" });
  });

  it("never allows link-local metadata targets", async () => {
    process.env.AI_M_MODEL_DISCOVERY_HOST_ALLOWLIST = "169.254.169.254";
    process.env.AI_M_MODEL_DISCOVERY_ALLOW_PRIVATE_HOSTS = "true";
    await expect(assertModelDiscoveryUrl({ protocol: "openai", baseUrl: "https://169.254.169.254/v1" }))
      .rejects.toThrow(/blocked network/i);
  });

  it("rejects HTTP unless it is explicitly enabled for an allowlisted host", async () => {
    process.env.AI_M_MODEL_DISCOVERY_HOST_ALLOWLIST = "allowed.example.com";
    process.env.AI_M_MODEL_DISCOVERY_PORT_ALLOWLIST = "80";
    await expect(assertModelDiscoveryUrl({ protocol: "openai", baseUrl: "http://allowed.example.com/v1" }))
      .rejects.toThrow(/requires HTTPS/i);
    process.env.AI_M_MODEL_DISCOVERY_ALLOW_HTTP = "true";
    await expect(assertModelDiscoveryUrl({ protocol: "openai", baseUrl: "http://allowed.example.com/v1" }))
      .resolves.toMatchObject({ protocol: "http:" });
  });
});
