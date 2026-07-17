import http from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import { channel } from "node:diagnostics_channel";
import { Agent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComfyUIHttpTransport,
  ComfyUIOperationDeadlineError,
  createComfyUITransport,
  parseComfyUIOperationTimeouts,
  probeSystemInfo,
  probeQueueStatus,
  submitPrompt,
} from "../comfyui";

const resources: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

async function startServer(
  handler: http.RequestListener,
): Promise<{ baseUrl: string; closedSockets: () => number; acceptedSockets: () => number }> {
  const sockets = new Set<Socket>();
  let closed = 0;
  let accepted = 0;
  const server = http.createServer(handler);
  server.on("connection", (socket) => {
    accepted++;
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
    acceptedSockets: () => accepted,
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

async function captureOperationFailure(operation: Promise<unknown>): Promise<Error & { submissionDisposition?: string }> {
  try {
    await operation;
  } catch (error) {
    return error as Error & { submissionDisposition?: string };
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
  it("rejects invalid operation-class timeout configuration", () => {
    expect(() => new ComfyUIHttpTransport(
      "http://comfy.deadline.test:8188",
      {},
      ["127.0.0.1"],
      { policyRevision: "revision-invalid-timeouts", uploadTimeoutMs: 0 },
    )).toThrow(/upload timeout/i);
  });

  it("parses only fail-closed production operation timeout policy", () => {
    expect(parseComfyUIOperationTimeouts({
      comfyuiOperationTimeouts: {
        resolutionMs: 2_000,
        probeMs: 3_000,
        submitMs: 4_000,
        uploadMs: 180_000,
        downloadMs: 240_000,
      },
    })).toEqual({
      resolutionTimeoutMs: 2_000,
      probeTimeoutMs: 3_000,
      submitTimeoutMs: 4_000,
      uploadTimeoutMs: 180_000,
      downloadTimeoutMs: 240_000,
    });
    expect(() => parseComfyUIOperationTimeouts({
      comfyuiOperationTimeouts: { uploadMs: "slow" },
    })).toThrow(/uploadMs/i);
    expect(() => parseComfyUIOperationTimeouts({
      comfyuiOperationTimeouts: { unknownMs: 10_000 },
    })).toThrow(/unknown/i);
  });

  it("bounds and cancels stalled backend DNS resolution", async () => {
    const previousFlag = process.env.FF_V2_COMFYUI_TRANSPORT;
    const previousAllowlist = process.env.AI_M_CONTAINER_HOST_ALLOWLIST;
    process.env.FF_V2_COMFYUI_TRANSPORT = "1";
    process.env.AI_M_CONTAINER_HOST_ALLOWLIST = "comfy.deadline.test";
    let resolverAborted = false;
    try {
      const creation = createComfyUITransport(
        "http://comfy.deadline.test:8188",
        "container-to-host",
        {},
        [],
        {
          policyRevision: "revision-stalled-resolution",
          resolutionTimeoutMs: 40,
          resolver: (_hostname, signal) => new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              resolverAborted = true;
              reject(signal.reason);
            }, { once: true });
          }),
        },
      );
      const guard = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("test_guard_expired")), 500);
      });

      await expect(Promise.race([creation, guard])).rejects.toMatchObject({
        code: "comfyui_operation_deadline",
        submissionDisposition: "definitely-not-submitted",
      });
      expect(resolverAborted).toBe(true);
    } finally {
      if (previousFlag === undefined) delete process.env.FF_V2_COMFYUI_TRANSPORT;
      else process.env.FF_V2_COMFYUI_TRANSPORT = previousFlag;
      if (previousAllowlist === undefined) delete process.env.AI_M_CONTAINER_HOST_ALLOWLIST;
      else process.env.AI_M_CONTAINER_HOST_ALLOWLIST = previousAllowlist;
    }
  });

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
    expect(error.submissionDisposition).toBe("submission-uncertain");
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
    expect(error.submissionDisposition).toBe("definitely-not-submitted");
    expect(blackhole.destroyed).toBe(true);
  });

  it("classifies a refused connection before request bytes are written as definitely not submitted", async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://comfy.deadline.test:${(server.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const client = transport(baseUrl);

    const error = await captureOperationFailure(submitPrompt(client, {}, "refused-client"));
    expect(error).toMatchObject({ submissionDisposition: "definitely-not-submitted" });
  });

  it("classifies a reset after prompt bytes are written as submission uncertain", async () => {
    const server = await startServer((request) => {
      request.resume();
      request.once("end", () => request.socket.destroy());
    });

    const error = await captureOperationFailure(submitPrompt(transport(server.baseUrl), {}, "reset-client"));
    expect(error).toMatchObject({ submissionDisposition: "submission-uncertain" });
  });

  it.each([
    ["invalid JSON", "not-json"],
    ["oversized JSON", `{"prompt_id":"${"x".repeat(2 * 1024 * 1024)}"}`],
    ["invalid prompt id", '{"prompt_id":"contains spaces"}'],
  ])("keeps a 2xx submitted prompt uncertain after %s", async (_label, body) => {
    const server = await startServer((request, response) => {
      request.resume();
      request.once("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(body);
      });
    });

    const error = await captureOperationFailure(submitPrompt(
      transport(server.baseUrl), {}, "invalid-response-client", undefined, { timeoutMs: 2_000 },
    ));

    expect(error).toMatchObject({ submissionDisposition: "submission-uncertain" });
  });

  it("does not expose a rejected prompt response body in the submission error", async () => {
    const server = await startServer((request, response) => {
      request.resume();
      request.once("end", () => {
        response.writeHead(500, { "Content-Type": "text/plain" });
        response.end("Authorization: Bearer backend-secret");
      });
    });

    const error = await captureOperationFailure(submitPrompt(
      transport(server.baseUrl), {}, "safe-error-client", undefined, { timeoutMs: 1_000 },
    ));

    expect(error.message).not.toContain("backend-secret");
    expect(error).toMatchObject({ submissionDisposition: "definitely-not-submitted" });
  });

  it("does not let a reentrant diagnostics subscriber steal prompt write evidence", async () => {
    const server = await startServer((request, response) => {
      request.resume();
      request.once("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"prompt_id":"accepted-but');
      });
    });
    const client = transport(server.baseUrl);
    const requestCreate = channel("undici:request:create");
    let reentered = false;
    const apmSubscriber = () => {
      if (reentered) return;
      reentered = true;
      requestCreate.publish({ request: {} });
    };
    requestCreate.subscribe(apmSubscriber);
    try {
      const error = await captureOperationDeadline(submitPrompt(client, {}, "reentrant-client"));
      expect(error.submissionDisposition).toBe("submission-uncertain");
    } finally {
      requestCreate.unsubscribe(apmSubscriber);
    }
  });

  it("reuses one pinned HTTP agent for sequential probes", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    });
    const agentFactory = vi.fn((connector) => new Agent({ connect: connector }));
    const client = new ComfyUIHttpTransport(server.baseUrl, {}, ["127.0.0.1"], {
      policyRevision: "revision-agent-reuse",
      operationTimeoutMs: 1_000,
      httpAgentFactory: agentFactory,
    });
    resources.push(() => client.close());

    await (await client.get("/queue")).arrayBuffer();
    await (await client.get("/queue")).arrayBuffer();

    expect(agentFactory).toHaveBeenCalledOnce();
  });

  it("drains a status-only error response before reusing the pinned connection", async () => {
    let requests = 0;
    const server = await startServer((_request, response) => {
      requests++;
      response.writeHead(requests === 1 ? 503 : 200, { "Content-Type": "application/json" });
      response.end(requests === 1 ? '{"error":"busy"}' : '{"queue_running":[],"queue_pending":[]}');
    });
    const client = transport(server.baseUrl);

    await expect(probeQueueStatus(client)).rejects.toThrow(/503/);
    await expect(probeQueueStatus(client)).resolves.toMatchObject({ queueRunning: [], queuePending: [] });

    expect(server.closedSockets()).toBe(0);
    expect(server.acceptedSockets()).toBeLessThanOrEqual(4);
  });

  it("consumes the status-only direct interrupt acknowledgement", async () => {
    let bodyFinished = false;
    let pulls = 0;
    const acknowledgement = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) controller.enqueue(new TextEncoder().encode("{}"));
        else {
          controller.close();
          bodyFinished = true;
        }
      },
      cancel() { bodyFinished = true; },
    }), { status: 200 });
    class InterruptTransport extends ComfyUIHttpTransport {
      override async post(): Promise<Response> { return acknowledgement; }
    }
    const client = new InterruptTransport(
      "http://comfy.deadline.test:8188", {}, ["127.0.0.1"], { policyRevision: "revision-interrupt-body" },
    );
    resources.push(() => client.close());

    await client.interrupt();

    expect(bodyFinished).toBe(true);
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
    expect(preWriteError.submissionDisposition).toBe("definitely-not-submitted");
    expect(postWriteError.submissionDisposition).toBe("submission-uncertain");
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
    expect(response.url).toContain("/view?");
    expect(response.redirected).toBe(false);
    expect(response.type).toBe("basic");
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
