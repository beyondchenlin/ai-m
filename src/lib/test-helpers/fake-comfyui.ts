/**
 * PR-11 假 ComfyUI 后端
 *
 * 实现 ComfyUITransport 接口，支持构造各种边界场景：
 * - 提交成功 / 失败 / 超时
 * - 历史记录存在 / 不存在
 * - 队列运行中 / 排队中
 * - 文件下载
 */

import type {
  ComfyUITransport,
  ComfyExecutionResult,
  ComfySystemInfo,
  ComfyObjectInfo,
} from "@/lib/generation/transports/comfyui";
import type { BackendFeatureSnapshot } from "@/lib/generation/transports/comfyui-behavior-probe";

export interface FakeTransportScenario {
  /** 提交 /prompt 时抛出的错误，优先级最高 */
  submitError?: Error;
  /** 提交返回的 promptId */
  promptId?: string;
  /** 提交返回的 HTTP 状态码 */
  submitStatus?: number;
  /** 提交返回的 nodeErrors */
  nodeErrors?: Record<string, { classType: string; errors: { details: string }[] }>;
  /** 历史记录 */
  history?: Record<string, ComfyExecutionResult>;
  /** 运行中队列 */
  queueRunning?: Array<{ prompt_id: string; client_id?: string; correlation_id?: string }>;
  /** 排队中队列 */
  queuePending?: Array<{ prompt_id: string; client_id?: string; correlation_id?: string }>;
  /** /view 返回的文件字节 */
  fileBytes?: ArrayBuffer;
  /** /view 返回的状态码 */
  fileStatus?: number;
  /** /system_stats 返回内容 */
  systemInfo?: ComfySystemInfo;
  /** /object_info 返回内容 */
  objectInfo?: ComfyObjectInfo;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function emptyResponse(status = 200): Response {
  return new Response(null, { status });
}

export class FakeComfyUITransport implements ComfyUITransport {
  scenario: FakeTransportScenario;
  /** 提交时传入的 client_id / correlation_id 与 prompt_id 的关联映射 */
  private correlationMap = new Map<string, string>();

  constructor(scenario: FakeTransportScenario = {}) {
    this.scenario = scenario;
  }

  private registerCorrelation(body: unknown, promptId: string): void {
    const b = body as Record<string, unknown> | undefined;
    const clientId = b?.client_id as string | undefined;
    const extra = b?.extra_data as Record<string, unknown> | undefined;
    const correlationId = extra?.correlation_id as string | undefined;

    if (clientId) this.correlationMap.set(`client:${clientId}`, promptId);
    if (correlationId) this.correlationMap.set(`corr:${correlationId}`, promptId);
  }

  private resolveCorrelation(body: unknown): string | undefined {
    const b = body as Record<string, unknown> | undefined;
    const clientId = b?.client_id as string | undefined;
    const correlationId = b?.correlation_id as string | undefined;
    return (
      (correlationId ? this.correlationMap.get(`corr:${correlationId}`) : undefined) ??
      (clientId ? this.correlationMap.get(`client:${clientId}`) : undefined)
    );
  }

  async get(path: string): Promise<Response> {
    if (path === "/system_stats") {
      return jsonResponse(this.scenario.systemInfo ?? {
        system: { comfy_version: "0.0.1" },
        devices: [{ name: "Fake GPU", type: "cuda", index: 0, vramTotal: 8 * 1024 * 1024 * 1024 }],
      });
    }
    if (path === "/object_info") {
      return jsonResponse(this.scenario.objectInfo ?? {
        CheckpointLoaderSimple: {
          input: { required: { ckpt_name: ["test.safetensors"] } }, output: ["MODEL", "CLIP", "VAE"],
          output_is_list: [false, false, false], output_name: ["MODEL", "CLIP", "VAE"],
          name: "CheckpointLoaderSimple", display_name: "Load Checkpoint", description: "", category: "loaders", output_node: false,
        },
      });
    }
    if (path === "/queue") return jsonResponse({ queue_running: this.scenario.queueRunning ?? [], queue_pending: this.scenario.queuePending ?? [] });
    if (path.startsWith("/history/")) {
      const id = path.split("/")[2];
      return jsonResponse(id && this.scenario.history?.[id] ? { [id]: this.scenario.history[id] } : {});
    }
    return emptyResponse(404);
  }

  async post(path: string, body: unknown): Promise<Response> {
    if (path === "/prompt") {
      if (this.scenario.submitError) {
        // 即使提交响应丢失，也记录关联映射，供对账发现
        if (this.scenario.promptId) {
          this.registerCorrelation(body, this.scenario.promptId);
        }
        throw this.scenario.submitError;
      }
      if (this.scenario.submitStatus && this.scenario.submitStatus >= 400) {
        return new Response(JSON.stringify({ error: "bad request" }), {
          status: this.scenario.submitStatus,
          headers: { "Content-Type": "application/json" },
        });
      }
      const promptId = this.scenario.promptId ?? "fake-prompt-id";
      this.registerCorrelation(body, promptId);
      return jsonResponse({
        prompt_id: promptId,
        number: 1,
        nodeErrors: this.scenario.nodeErrors,
      });
    }

    if (path === "/system_stats") {
      return jsonResponse(
        this.scenario.systemInfo ?? {
          system: { comfy_version: "0.0.1" },
          devices: [{ name: "Fake GPU", type: "cuda", index: 0, vramTotal: 8 * 1024 * 1024 * 1024 }],
        },
      );
    }

    if (path === "/object_info") {
      return jsonResponse(
        this.scenario.objectInfo ?? {
          CheckpointLoaderSimple: {
            input: { required: { ckpt_name: ["test.safetensors"] } },
            output: ["MODEL", "CLIP", "VAE"],
            output_is_list: [false, false, false],
            output_name: ["MODEL", "CLIP", "VAE"],
            name: "CheckpointLoaderSimple",
            display_name: "Load Checkpoint",
            description: "",
            category: "loaders",
            output_node: false,
          },
        },
      );
    }

    if (path === "/queue") {
      const payload = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
      const deletions = Array.isArray(payload.delete) ? payload.delete.filter((item): item is string => typeof item === "string") : [];
      if (deletions.length) {
        this.scenario.queueRunning = (this.scenario.queueRunning ?? []).filter((item) => !deletions.includes(item.prompt_id));
        this.scenario.queuePending = (this.scenario.queuePending ?? []).filter((item) => !deletions.includes(item.prompt_id));
        return emptyResponse(200);
      }
      const correlatedPromptId = this.resolveCorrelation(body);
      const running = this.scenario.queueRunning ?? [];
      const pending = this.scenario.queuePending ?? [];
      // 若请求体带有 correlation_id/client_id，优先返回关联的任务；否则返回全部
      const filteredRunning = correlatedPromptId
        ? running.filter((q) => q.prompt_id === correlatedPromptId)
        : running;
      const filteredPending = correlatedPromptId
        ? pending.filter((q) => q.prompt_id === correlatedPromptId)
        : pending;
      return jsonResponse({
        queue_running: filteredRunning,
        queue_pending: filteredPending,
      });
    }

    if (path.startsWith("/history/")) {
      const id = path.split("/")[2];
      // 允许通过 correlation_id/client_id 发现对应 prompt_id 的历史
      const correlatedPromptId = id ? undefined : this.resolveCorrelation(body);
      const resolvedId = id || correlatedPromptId;
      return jsonResponse(
        resolvedId && this.scenario.history?.[resolvedId]
          ? { [resolvedId]: this.scenario.history[resolvedId] }
          : {},
      );
    }

    if (path === "/interrupt") {
      return emptyResponse(200);
    }

    if (path.startsWith("/queue/")) {
      // per-task cancel delete endpoint
      return emptyResponse(200);
    }

    return emptyResponse(404);
  }

  async uploadImage(input: { filename: string; bytes: Uint8Array; mimeType: string; subfolder?: string }): Promise<{ name: string; subfolder: string; type: string }> {
    if (input.bytes.byteLength === 0) throw new Error("empty upload");
    return { name: input.filename, subfolder: input.subfolder ?? "", type: "input" };
  }

  async getFile(): Promise<Response> {
    const bytes = this.scenario.fileBytes ?? new ArrayBuffer(0);
    return new Response(bytes, { status: this.scenario.fileStatus ?? 200 });
  }

  connectWebSocket(): WebSocket {
    return new FakeWebSocket();
  }

  async cancel(): Promise<void> {}

  async interrupt(): Promise<void> {}

  close(): void {}
}

/**
 * 最小化的 WebSocket mock，避免测试中真实发起网络连接。
 */
export class FakeWebSocket implements WebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = 0;
  url = "";
  protocol = "";
  extensions = "";
  bufferedAmount = 0;
  binaryType: BinaryType = "blob";

  onopen: ((this: WebSocket, ev: Event) => void) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => void) | null = null;
  onerror: ((this: WebSocket, ev: Event) => void) | null = null;
  onclose: ((this: WebSocket, ev: CloseEvent) => void) | null = null;

  constructor(url?: string | URL, _protocols?: string | string[]) {
    this.url = String(url ?? "");
    // 异步触发 open，让注册代码有机会设置回调
    Promise.resolve().then(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    });
  }

  send(): void {}
  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000 } as CloseEvent);
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }
}

/**
 * 将 FakeWebSocket 注入为全局 WebSocket，供编排器连接阶段使用。
 */
export function installFakeWebSocket(): () => void {
  const original = globalThis.WebSocket;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.WebSocket = FakeWebSocket as any;
  return () => {
    globalThis.WebSocket = original;
  };
}

/**
 * 默认的 backend feature snapshot，用于编排器构造。
 */
export function defaultBackendFeatures(): BackendFeatureSnapshot {
  return {
    environmentFingerprint: "env:test",
    externalIdStrategy: "server-assigned",
    cancellation: {
      supportsPerTaskCancel: true,
      hasGlobalInterrupt: true,
      safeForShared: true,
    },
    output: {
      readMethod: "view",
      supportsStreaming: false,
      maxOutputSizeBytesEstimate: 100 * 1024 * 1024,
    },
    nodeCategories: ["loaders"],
    devicesSummary: ["Fake GPU (cuda, 8192MB VRAM)"],
    probedAtMs: Date.now(),
    validUntilMs: Date.now() + 3600_000,
  };
}
