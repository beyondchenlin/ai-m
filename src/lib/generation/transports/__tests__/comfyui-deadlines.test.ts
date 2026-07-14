import http from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  ComfyUIHttpTransport,
  ComfyUIOperationDeadlineError,
  probeSystemInfo,
  submitPrompt,
} from "../comfyui";

const resources: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

async function startServer(
  handler: http.RequestListener,
): Promise<{ baseUrl: string; closedSockets: () => number }> {
  const sockets = new Set<Socket>();
  let closed = 0;
  const server = http.createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      closed++;
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  resources.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    baseUrl: `http://comfy.deadline.test:${(server.address() as AddressInfo).port}`,
    closedSockets: () => closed,
  };
}

function transport(baseUrl: string): ComfyUIHttpTransport {
  const instance = new ComfyUIHttpTransport(
    baseUrl,
    {},
    ["127.0.0.1"],
    {
      policyRevision: "revision-operation-deadline",
      connectTimeoutMs: 1_000,
      operationTimeoutMs: 40,
    } as unknown as ConstructorParameters<typeof ComfyUIHttpTransport>[3],
  );
  resources.push(() => instance.close());
  return instance;
}

async function expectOperationDeadline(operation: Promise<unknown>): Promise<void> {
  await captureOperationDeadline(operation);
}

async function captureOperationDeadline(operation: Promise<unknown>): Promise<ComfyUIOperationDeadlineError> {
  const guard = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("test_guard_expired")), 500);
  });
  try {
    await Promise.race([operation, guard]);
  } catch (error) {
    expect(error).toBeInstanceOf(ComfyUIOperationDeadlineError);
    expect((error as Error).message).toMatch(/operation deadline/i);
    return error as ComfyUIOperationDeadlineError;
  }
  throw new Error("operation unexpectedly completed");
}

async function captureOperationFailure(operation: Promise<unknown>): Promise<Error & { outcome?: string }> {
  try {
    await operation;
  } catch (error) {
    return error as Error & { outcome?: string };
  }
  throw new Error("operation unexpectedly completed");
}

async function expectSocketClosed(closedSockets: () => number): Promise<void> {
  const end = Date.now() + 300;
  while (closedSockets() === 0 && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(closedSockets()).toBeGreaterThan(0);
}

describe("ComfyUI absolute operation deadlines", () => {
  it("aborts a probe while response headers are stalled", async () => {
    const server = await startServer(() => {
      // Deliberately never send response headers.
    });

    await expectOperationDeadline(probeSystemInfo(transport(server.baseUrl)));
    await expectSocketClosed(server.closedSockets);
  });

  it("classifies a submitted prompt with a slow response body as uncertain and closes the socket", async () => {
    const server = await startServer((request, response) => {
      request.resume();
      request.once("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"prompt_id":"accepted-but');
      });
    });

    const error = await captureOperationDeadline(submitPrompt(transport(server.baseUrl), {}, "deadline-client"));
    expect(error.outcome).toBe("submission-uncertain");
    await expectSocketClosed(server.closedSockets);
  });

  it("classifies a deadline before request bytes are written as definitely not submitted", async () => {
    const blackhole = new net.Socket();
    const client = new ComfyUIHttpTransport(
      "http://comfy.deadline.test:8188",
      {},
      ["127.0.0.1"],
      {
        policyRevision: "revision-prewrite-deadline",
        connectTimeoutMs: 1_000,
        operationTimeoutMs: 40,
        socketFactory: () => blackhole,
      },
    );
    resources.push(() => client.close());

    const error = await captureOperationDeadline(submitPrompt(client, {}, "prewrite-client"));
    expect(error.outcome).toBe("definitely-not-submitted");
    expect(blackhole.destroyed).toBe(true);
  });

  it("classifies a refused connection before request bytes are written as definitely not submitted", async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://comfy.deadline.test:${(server.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const client = transport(baseUrl);

    const error = await captureOperationFailure(submitPrompt(client, {}, "refused-client"));
    expect(error).toMatchObject({ outcome: "definitely-not-submitted" });
  });

  it("classifies a reset after prompt bytes are written as submission uncertain", async () => {
    const server = await startServer((request) => {
      request.resume();
      request.once("end", () => request.socket.destroy());
    });

    const error = await captureOperationFailure(submitPrompt(transport(server.baseUrl), {}, "reset-client"));
    expect(error).toMatchObject({ outcome: "submission-uncertain" });
  });

  it("isolates request-write evidence between concurrent submissions", async () => {
    const server = await startServer((request, response) => {
      request.resume();
      request.once("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"prompt_id":"accepted-but');
      });
    });
    const port = Number(new URL(server.baseUrl).port);
    const blackhole = new net.Socket();
    let dialCount = 0;
    const client = new ComfyUIHttpTransport(
      server.baseUrl,
      {},
      ["127.0.0.1"],
      {
        policyRevision: "revision-concurrent-evidence",
        connectTimeoutMs: 1_000,
        operationTimeoutMs: 80,
        socketFactory: () => {
          dialCount++;
          return dialCount === 1 ? blackhole : net.connect(port, "127.0.0.1");
        },
      },
    );
    resources.push(() => client.close());

    const preWrite = captureOperationDeadline(submitPrompt(client, {}, "prewrite-concurrent"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const postWrite = captureOperationDeadline(submitPrompt(client, {}, "postwrite-concurrent"));

    const [preWriteError, postWriteError] = await Promise.all([preWrite, postWrite]);
    expect(preWriteError.outcome).toBe("definitely-not-submitted");
    expect(postWriteError.outcome).toBe("submission-uncertain");
    expect(blackhole.destroyed).toBe(true);
  });

  it("aborts an upload while its response body is stalled", async () => {
    const server = await startServer((request, response) => {
      request.resume();
      request.once("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"name":"input.png"');
      });
    });
    const client = transport(server.baseUrl);

    await expectOperationDeadline(client.uploadImage({
      filename: "input.png",
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
    }));
    await expectSocketClosed(server.closedSockets);
  });

  it("keeps the download deadline active until the response body is consumed", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.write(Buffer.from([1, 2, 3]));
    });
    const client = transport(server.baseUrl);
    const response = await client.getFile({ filename: "output.png", subfolder: "", type: "output" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    await expectOperationDeadline(response.arrayBuffer());
    await expectSocketClosed(server.closedSockets);
  });

  it("combines an operation AbortSignal with the body lifetime", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.write(Buffer.from([1, 2, 3]));
    });
    const client = transport(server.baseUrl);
    const controller = new AbortController();
    const response = await client.getFile(
      { filename: "output.png", subfolder: "", type: "output" },
      { timeoutMs: 1_000, signal: controller.signal },
    );

    controller.abort(new Error("execution lifecycle ended"));

    await expect(response.arrayBuffer()).rejects.toThrow();
    await expectSocketClosed(server.closedSockets);
  });
});
