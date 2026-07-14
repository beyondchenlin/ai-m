import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { defaultBackendFeatures } from "@/lib/test-helpers/fake-comfyui";
import { ComfyUIExecutionOrchestrator } from "../comfyui-execution-orchestrator";
import { connectionManagerRegistry } from "../comfyui-connection-manager";
import { ComfyUIHttpTransport, isApprovedRemoteAddress } from "../comfyui";

const sockets = new Set<Socket>();

afterEach(() => {
  connectionManagerRegistry.closeAll();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
});

describe("ComfyUI WebSocket endpoint policy", () => {
  it("canonicalizes and verifies the actual socket remote address", () => {
    expect(isApprovedRemoteAddress("::ffff:127.0.0.1", ["127.0.0.1"])).toBe(true);
    expect(isApprovedRemoteAddress("127.0.0.1", ["::ffff:127.0.0.1"])).toBe(true);
    expect(isApprovedRemoteAddress("127.0.0.2", ["127.0.0.1"])).toBe(false);
    expect(isApprovedRemoteAddress(undefined, ["127.0.0.1"])).toBe(false);
  });

  it("makes the orchestrator dial the approved address with the approved authority and authentication", async () => {
    let upgradeHeaders: http.IncomingHttpHeaders | null = null;
    const server = http.createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "POST" && request.url === "/prompt") {
        response.end(JSON.stringify({ prompt_id: "pinned-prompt" }));
        return;
      }
      if (request.url === "/queue") {
        response.end(JSON.stringify({
          queue_running: [[0, "pinned-prompt", {}, {}, []]],
          queue_pending: [],
        }));
        return;
      }
      if (request.url === "/history/pinned-prompt") {
        response.end(JSON.stringify({
          "pinned-prompt": {
            promptId: "pinned-prompt",
            outputs: {},
            status: {
              statusStr: "error",
              completed: false,
              messages: [["execution_error", {}]],
            },
          },
        }));
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (request, socket) => {
      upgradeHeaders = request.headers;
      const key = request.headers["sec-websocket-key"] ?? "";
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const authority = `comfy.policy.test:${port}`;
      const transport = new ComfyUIHttpTransport(
        `http://${authority}`,
        { Authorization: "Bearer websocket-policy-test" },
        ["127.0.0.1"],
        { policyRevision: `sha256:${"a".repeat(64)}` },
      );
      const pinnedHttpPreflight = await transport.get("/queue");
      expect(pinnedHttpPreflight.ok).toBe(true);
      const orchestrator = new ComfyUIExecutionOrchestrator(
        transport,
        defaultBackendFeatures(),
        {},
        {
          queuedPollIntervalMs: 5,
          runningPollIntervalMs: 5,
          totalExecutionTimeoutMs: 500,
          approvedOutputs: [],
        },
      );

      await orchestrator.execute({});

      expect(upgradeHeaders).toMatchObject({
        authorization: "Bearer websocket-policy-test",
        host: authority,
        origin: `http://${authority}`,
      });
    } finally {
      connectionManagerRegistry.closeAll();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("derives a nonsecret registry identity from the canonical endpoint, credential, addresses, and policy revision", () => {
    type PolicyTransportConstructor = new (
      baseUrl: string,
      headers: Record<string, string>,
      addresses: readonly string[],
      options: { policyRevision: string },
    ) => ComfyUIHttpTransport;
    const Transport = ComfyUIHttpTransport as unknown as PolicyTransportConstructor;
    const tokenA = "raw-secret-token-a";
    const first = new Transport(
      "http://comfy.policy.test:8188/api/",
      { Authorization: `Bearer ${tokenA}`, "X-Tenant": "alpha" },
      ["127.0.0.1"],
      { policyRevision: "revision-1" },
    );
    const equivalent = new Transport(
      "http://COMFY.POLICY.TEST:8188/api",
      { "x-tenant": "alpha", authorization: `Bearer ${tokenA}` },
      ["::ffff:127.0.0.1"],
      { policyRevision: "revision-1" },
    );
    const rotatedCredential = new Transport(
      "http://comfy.policy.test:8188/api",
      { Authorization: "Bearer raw-secret-token-b", "X-Tenant": "alpha" },
      ["127.0.0.1"],
      { policyRevision: "revision-1" },
    );
    const revisedPolicy = new Transport(
      "http://comfy.policy.test:8188/api",
      { Authorization: `Bearer ${tokenA}`, "X-Tenant": "alpha" },
      ["127.0.0.1"],
      { policyRevision: "revision-2" },
    );
    const differentPath = new Transport(
      "http://comfy.policy.test:8188/other",
      { Authorization: `Bearer ${tokenA}`, "X-Tenant": "alpha" },
      ["127.0.0.1"],
      { policyRevision: "revision-1" },
    );
    try {
      const identity = first.getWebSocketFactory();
      expect(identity.registryKey).toBe(equivalent.getWebSocketFactory().registryKey);
      expect(identity.registryKey).not.toBe(rotatedCredential.getWebSocketFactory().registryKey);
      expect(identity.registryKey).not.toBe(revisedPolicy.getWebSocketFactory().registryKey);
      expect(identity.registryKey).not.toBe(differentPath.getWebSocketFactory().registryKey);
      expect(identity.registryKey).not.toContain(tokenA);
      expect(identity.canonicalEndpoint).toBe("http://comfy.policy.test:8188/api");
      expect(Object.isFrozen(identity)).toBe(true);
    } finally {
      first.close();
      equivalent.close();
      rotatedCredential.close();
      revisedPolicy.close();
      differentPath.close();
    }
  });

  it("does not follow an upgrade redirect to an alternate authority", async () => {
    let alternateUpgrades = 0;
    let alternateHttpHits = 0;
    const alternate = http.createServer((_request, response) => {
      alternateHttpHits++;
      response.end("alternate");
    });
    alternate.on("upgrade", (_request, socket) => {
      alternateUpgrades++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => alternate.listen(0, "127.0.0.1", resolve));
    const alternatePort = (alternate.address() as AddressInfo).port;

    const redirect = http.createServer((_request, response) => {
      response.writeHead(302, { Location: `http://127.0.0.1:${alternatePort}/alternate` });
      response.end();
    });
    redirect.on("upgrade", (_request, socket) => {
      socket.end([
        "HTTP/1.1 302 Found",
        `Location: ws://127.0.0.1:${alternatePort}/ws`,
        "Connection: close",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n"));
    });
    await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
    const redirectPort = (redirect.address() as AddressInfo).port;
    const transport = new ComfyUIHttpTransport(
      `http://redirect.policy.test:${redirectPort}`,
      { Authorization: "Bearer redirect-must-not-forward" },
      ["127.0.0.1"],
      { policyRevision: `sha256:${"b".repeat(64)}` },
    );

    try {
      const httpResponse = await transport.get("/queue");
      expect(httpResponse.status).toBe(302);
      expect(alternateHttpHits).toBe(0);
      const ws = transport.connectWebSocket();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("redirecting WebSocket did not terminate")), 1_000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        ws.onerror = done;
        ws.onclose = done;
      });
      expect(alternateUpgrades).toBe(0);
      expect(alternateHttpHits).toBe(0);
    } finally {
      transport.close();
      await Promise.all([
        new Promise<void>((resolve, reject) => redirect.close((error) => error ? reject(error) : resolve())),
        new Promise<void>((resolve, reject) => alternate.close((error) => error ? reject(error) : resolve())),
      ]);
    }
  });

});
