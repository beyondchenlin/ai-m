import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { ModelDiscoveryTarget } from "../model-discovery-policy";
import { requestPinnedJson } from "../pinned-json-request";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function targetFor(handler: http.RequestListener): Promise<ModelDiscoveryTarget> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: new URL(`http://model-gateway.example:${port}/v1/models`),
    hostname: "model-gateway.example",
    addresses: [{ address: "127.0.0.1", family: 4 }],
  };
}

describe("pinned JSON request", () => {
  it("connects to the policy-approved address while preserving the HTTP host", async () => {
    const target = await targetFor((request, response) => {
      expect(request.headers.host).toMatch(/^model-gateway\.example:/);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "model-a" }] }));
    });
    await expect(requestPinnedJson(target)).resolves.toMatchObject({
      status: 200,
      body: { data: [{ id: "model-a" }] },
    });
  });

  it("rejects a response that exceeds the configured limit", async () => {
    const target = await targetFor((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ value: "x".repeat(2048) }));
    });
    await expect(requestPinnedJson(target, { maxBytes: 128 })).rejects.toThrow(/too large/i);
  });
});
