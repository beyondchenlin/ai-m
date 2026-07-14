import { describe, expect, it } from "vitest";
import { readJsonBodyLimited, readJsonResponseLimited } from "../request-validation";

describe("PR-12 bounded JSON request bodies", () => {
  it("parses a valid bounded UTF-8 JSON body", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
      headers: { "content-type": "application/json" },
    });
    await expect(readJsonBodyLimited(request, 64)).resolves.toEqual({ ok: true });
  });

  it("rejects an oversized Content-Length before reading", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: "{}",
      headers: { "content-length": "100" },
    });
    await expect(readJsonBodyLimited(request, 16)).rejects.toMatchObject({ status: 413 });
  });

  it("rejects a streamed body that exceeds the limit", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: "{\"value\":\"0123456789\"}",
    });
    await expect(readJsonBodyLimited(request, 8)).rejects.toMatchObject({ status: 413 });
  });

  it("rejects malformed JSON", async () => {
    const request = new Request("http://localhost", { method: "POST", body: "{" });
    await expect(readJsonBodyLimited(request, 64)).rejects.toThrow(/valid UTF-8 JSON/i);
  });
});


describe("bounded upstream JSON responses", () => {
  it("parses a bounded JSON response", async () => {
    const response = new Response(JSON.stringify({ data: [{ id: "model" }] }), {
      headers: { "content-type": "application/json" },
    });
    await expect(readJsonResponseLimited(response, 128)).resolves.toEqual({ data: [{ id: "model" }] });
  });

  it("rejects oversized upstream bodies without buffering them completely", async () => {
    const response = new Response(JSON.stringify({ value: "0123456789" }));
    await expect(readJsonResponseLimited(response, 8)).rejects.toThrow(/too large/i);
  });
});
