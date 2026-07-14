import { afterEach, describe, expect, it } from "vitest";
import { assertTrustedRequestOrigin } from "../request-origin";

describe("request origin guard", () => {
  afterEach(() => { delete process.env.AI_M_ALLOWED_ORIGINS; });

  it("rejects explicit cross-site browser requests", () => {
    const request = new Request("http://localhost/api/source-assets/a", {
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(() => assertTrustedRequestOrigin(request)).toThrow(/cross-site/i);
  });

  it("rejects an untrusted Origin header", () => {
    const request = new Request("http://localhost/api/source-assets/a", {
      headers: { origin: "https://attacker.example" },
    });
    expect(() => assertTrustedRequestOrigin(request)).toThrow(/cross-origin/i);
  });

  it("accepts the request origin and configured external origins", () => {
    expect(() => assertTrustedRequestOrigin(new Request("http://localhost/api/source-assets/a", {
      headers: { origin: "http://localhost" },
    }))).not.toThrow();
    process.env.AI_M_ALLOWED_ORIGINS = "https://studio.example";
    expect(() => assertTrustedRequestOrigin(new Request("http://internal:3000/api/source-assets/a", {
      headers: { origin: "https://studio.example" },
    }))).not.toThrow();
  });

  it("keeps non-browser service clients usable when browser metadata is absent", () => {
    expect(() => assertTrustedRequestOrigin(new Request("http://localhost/api/source-assets/a"))).not.toThrow();
  });
});
