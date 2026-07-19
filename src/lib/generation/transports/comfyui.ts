/**
 * v2.0 ComfyUI 传输适配器
 *
 * 手册 §9、§10：HTTP 提交提示词 + WebSocket 监听进度。
 * 包括行为探测、提交关联、取消和断线重连。
 */

import { isEnabled, FF } from "@/lib/feature-flags";
import {
  canonicalizeSocketAddress,
  canonicalizeUrlHostname,
  validateBackendUrlResolved,
  type BackendAddressResolver,
} from "@/lib/security/network-policy";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import net from "node:net";
import tls from "node:tls";
import {
  Agent,
  buildConnector,
  fetch as undiciFetch,
  FormData as UndiciFormData,
  WebSocket as UndiciWebSocket,
} from "undici";
import type { ComfyUIWebSocketFactory } from "./comfyui-connection-manager";

const CREDENTIAL_IDENTITY_KEY = randomBytes(32);
const UNDICI_REQUEST_CREATE = channel("undici:request:create");
const UNDICI_REQUEST_BODY_SENT = channel("undici:request:bodySent");
const UNDICI_REQUEST_BODY_CHUNK_SENT = channel("undici:request:bodyChunkSent");

interface ComfyUIRequestContext {
  controller: AbortController;
  expectedMethod: string;
  expectedOrigin: string;
  expectedPath: string;
  trackedRequest?: object;
  requestBytesWritten: boolean;
}

const COMFYUI_REQUEST_CONTEXT = new AsyncLocalStorage<ComfyUIRequestContext>();
const COMFYUI_REQUESTS = new WeakMap<object, ComfyUIRequestContext>();

UNDICI_REQUEST_CREATE.subscribe((message: unknown) => {
  const context = COMFYUI_REQUEST_CONTEXT.getStore();
  const request = (message as { request?: unknown }).request;
  if (!context || context.trackedRequest || !request || typeof request !== "object") return;
  const candidate = request as { method?: unknown; origin?: unknown; path?: unknown };
  if (candidate.method !== context.expectedMethod
    || candidate.origin !== context.expectedOrigin
    || candidate.path !== context.expectedPath) return;
  context.trackedRequest = request;
  COMFYUI_REQUESTS.set(request, context);
});

const recordRequestBodyWrite = (message: unknown) => {
  const request = (message as { request?: unknown }).request;
  if (!request || typeof request !== "object") return;
  const context = COMFYUI_REQUESTS.get(request);
  if (context) context.requestBytesWritten = true;
};
UNDICI_REQUEST_BODY_SENT.subscribe(recordRequestBodyWrite);
UNDICI_REQUEST_BODY_CHUNK_SENT.subscribe(recordRequestBodyWrite);

export function isApprovedRemoteAddress(
  remoteAddress: string | undefined,
  approvedAddresses: readonly string[],
): boolean {
  if (!remoteAddress) return false;
  try {
    const approved = new Set(approvedAddresses.map(canonicalizeSocketAddress));
    return approved.has(canonicalizeSocketAddress(remoteAddress));
  } catch {
    return false;
  }
}

function canonicalEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

function credentialIdentity(headers: Readonly<Record<string, string>>): string {
  const canonical = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHmac("sha256", CREDENTIAL_IDENTITY_KEY).update(JSON.stringify(canonical)).digest("hex");
}

function closeAgentSafely(agent: Agent): void {
  try {
    void agent.close().catch(() => undefined);
  } catch {
    // Cleanup is best effort and must not mask the original WebSocket outcome.
  }
}

export interface ComfyUIEndpointPolicyOptions {
  policyRevision: string;
  resolver?: BackendAddressResolver;
  connectTimeoutMs?: number;
  operationTimeoutMs?: number;
  resolutionTimeoutMs?: number;
  probeTimeoutMs?: number;
  submitTimeoutMs?: number;
  uploadTimeoutMs?: number;
  downloadTimeoutMs?: number;
  lifecycleSignal?: AbortSignal;
  socketFactory?: (options: ComfyUIEndpointDialOptions) => net.Socket | tls.TLSSocket;
  /** @internal Test seam for HTTP agent cleanup coverage. */
  httpAgentFactory?: (connector: ReturnType<typeof buildConnector>) => Agent;
  /** @internal Test seam for synchronous constructor-failure coverage. */
  webSocketAgentFactory?: (connector: ReturnType<typeof buildConnector>) => Agent;
  /** @internal Test seam for synchronous constructor-failure coverage. */
  webSocketConstructor?: (
    url: string,
    init: { dispatcher: Agent; headers: Record<string, string> },
  ) => WebSocket;
}

export interface ComfyUIEndpointDialOptions {
  protocol: "http:" | "https:";
  address: string;
  port: number;
  family: 4 | 6;
  localAddress?: string;
  servername?: string;
}

export function parseComfyUIOperationTimeouts(
  networkPolicy: unknown,
): Pick<ComfyUIEndpointPolicyOptions,
  "resolutionTimeoutMs" | "probeTimeoutMs" | "submitTimeoutMs" | "uploadTimeoutMs" | "downloadTimeoutMs"> {
  if (!networkPolicy || typeof networkPolicy !== "object" || Array.isArray(networkPolicy)) return {};
  const raw = (networkPolicy as Record<string, unknown>).comfyuiOperationTimeouts;
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("comfyuiOperationTimeouts must be an object");
  }
  const record = raw as Record<string, unknown>;
  const mapping = {
    resolutionMs: "resolutionTimeoutMs",
    probeMs: "probeTimeoutMs",
    submitMs: "submitTimeoutMs",
    uploadMs: "uploadTimeoutMs",
    downloadMs: "downloadTimeoutMs",
  } as const;
  const unknown = Object.keys(record).filter((key) => !(key in mapping));
  if (unknown.length) throw new Error(`Unknown ComfyUI timeout setting: ${unknown.join(", ")}`);
  const result: Record<string, number> = {};
  for (const [source, target] of Object.entries(mapping)) {
    const value = record[source];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 30 * 60_000) {
      throw new Error(`ComfyUI ${source} must be an integer between 1 and 1800000`);
    }
    result[target] = value as number;
  }
  return result;
}

export type ComfyUISubmissionDisposition =
  | "definitely-not-submitted"
  | "submission-uncertain"
  | "definitely-submitted";

export interface ComfyUIOperationOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class ComfyUIOperationError extends Error {
  readonly code: string = "comfyui_operation_failed";
  constructor(message: string, readonly submissionDisposition: ComfyUISubmissionDisposition, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ComfyUIOperationError";
  }
}

export class ComfyUIOperationDeadlineError extends ComfyUIOperationError {
  override readonly code = "comfyui_operation_deadline";
  constructor(submissionDisposition: ComfyUISubmissionDisposition) {
    super("ComfyUI operation deadline exceeded", submissionDisposition);
    this.name = "ComfyUIOperationDeadlineError";
  }
}

/** ComfyUI 提示词提交请求 */
export interface ComfyPromptRequest {
  /** 工作流 API JSON */
  workflow: Record<string, unknown>;
  /** 客户端编号（用于关联） */
  clientId: string;
  /** 额外数据 */
  extraData?: Record<string, unknown>;
}

/** ComfyUI 提示词提交响应 */
export interface ComfyPromptResponse {
  /** 提示词编号 */
  promptId: string;
  /** 外部队列编号 */
  number?: number;
  /** 队列剩余 */
  queueRemaining?: number;
  /** 节点错误 */
  nodeErrors?: Record<string, { classType: string; errors: { details: string }[] }>;
}

/** ComfyUI 执行进度 */
export interface ComfyProgress {
  /** 当前节点 */
  node: string;
  /** 最大值 */
  max: number;
  /** 当前值 */
  value: number;
  /** 百分比 */
  percent: number;
}

/** ComfyUI 执行结果 */
export interface ComfyExecutionResult {
  /** 提示词编号 */
  promptId: string;
  /** 输出文件映射 (nodeId → outputs) */
  outputs: Record<string, {
    images?: Array<{ filename: string; subfolder: string; type: string }>;
    gifs?: Array<{ filename: string; subfolder: string; type: string }>;
    audio?: Array<{ filename: string; subfolder: string; type: string }>;
  }>;
  /** 状态 */
  status: {
    statusStr: string;
    completed: boolean;
    messages?: Array<[string, Record<string, unknown>]>;
  };
}

export type ComfyHistoryOutcome = "completed" | "cancelled" | "failed" | "unknown";

/** Classifies ComfyUI history using the queue's actual status/message contract. */
export function classifyComfyHistory(result: ComfyExecutionResult | undefined): ComfyHistoryOutcome {
  if (!result) return "unknown";

  const status = result.status.statusStr.trim().toLowerCase();
  const messages = new Set((result.status.messages ?? []).map(([type]) => type.trim().toLowerCase()));
  const interrupted = messages.has("execution_interrupted");
  const executionFailed = messages.has("execution_error") || messages.has("execution_failed");

  if (status === "success" && result.status.completed === true && !interrupted && !executionFailed) {
    return "completed";
  }
  if (status === "error" && result.status.completed === false && interrupted && !executionFailed) {
    return "cancelled";
  }
  if (status === "error" && result.status.completed === false && executionFailed && !interrupted) {
    return "failed";
  }
  if (["failed", "failure"].includes(status) && result.status.completed === false
    && !interrupted) {
    return "failed";
  }
  return "unknown";
}

/** ComfyUI 系统信息 */
export interface ComfySystemInfo {
  system?: Record<string, unknown>;
  devices?: Array<{ name: string; type: string; index: number; vramTotal: number }>;
}

/** ComfyUI 对象信息 */
export interface ComfyObjectInfo {
  [className: string]: {
    input: { required?: Record<string, unknown>; optional?: Record<string, unknown> };
    output: unknown[];
    output_is_list: boolean[];
    output_name: string[];
    name: string;
    display_name: string;
    description: string;
    category: string;
    output_node: boolean;
  };
}

/** WebSocket 消息类型 */
export type ComfyWSMessage =
  | { type: "status"; data: { status: { exec_info: { queue_remaining: number } } } }
  | { type: "execution_start"; data: { prompt_id: string } }
  | { type: "execution_cached"; data: { prompt_id: string; nodes: string[] } }
  | { type: "executing"; data: { node: string | null; prompt_id: string } }
  | { type: "progress"; data: { prompt_id: string; node: string; value: number; max: number } }
  | { type: "executed"; data: { prompt_id: string; node: string; output: Record<string, unknown> } }
  | { type: "execution_error"; data: { prompt_id: string; node_id: string; node_type: string; exception_message: string; traceback: string[] } };

/** 传输适配器接口 */
export interface ComfyUITransport {
  /** Read one allow-listed ComfyUI resource. */
  get(path: string, options?: ComfyUIOperationOptions): Promise<Response>;
  /** Mutate one allow-listed ComfyUI resource. */
  post(path: string, body: unknown, options?: ComfyUIOperationOptions): Promise<Response>;
  /** Upload a bounded image into the ComfyUI input namespace. */
  uploadImage(input: { filename: string; bytes: Uint8Array; mimeType: string; subfolder?: string }, options?: ComfyUIOperationOptions): Promise<{
    name: string;
    subfolder: string;
    type: string;
    cleanup?: () => Promise<void>;
  }>;
  /** 获取文件 */
  getFile(params: { filename: string; subfolder: string; type: string }, options?: ComfyUIOperationOptions): Promise<Response>;
  /** 建立 WebSocket 连接 */
  /** Immutable identity and constructor for the shared realtime connection. */
  getWebSocketFactory(): ComfyUIWebSocketFactory;
  /** 取消当前提示词 */
  cancel(): Promise<void>;
  /** 中断执行 */
  interrupt(): Promise<void>;
  /** 释放连接 */
  close(): void;
}

function assertSafeComfyFilePart(value: string, field: string, allowEmpty = false): void {
  if (allowEmpty && value === "") return;
  if (!value || value.includes("\0") || value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw new Error(`Invalid ComfyUI ${field}`);
  }
  if (value.length > 255) throw new Error(`ComfyUI ${field} is too long`);
}

function assertSafeSubfolder(value: string): void {
  if (!value) return;
  if (value.includes("\0") || value.startsWith("/") || value.startsWith("\\")) throw new Error("Invalid ComfyUI subfolder");
  const parts = value.replace(/\\/g, "/").split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.length > 120)) throw new Error("Invalid ComfyUI subfolder");
}

/** HTTP 传输实现 */
export class ComfyUIHttpTransport implements ComfyUITransport {
  private readonly baseUrl: string;
  private readonly controller: AbortController;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly probeTimeoutMs: number;
  private readonly submitTimeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly dispatcher: Agent;
  private readonly removeLifecycleListener?: () => void;
  private readonly webSocketFactory: ComfyUIWebSocketFactory;

  constructor(
    baseUrl: string,
    headers: Record<string, string> = {},
    approvedAddresses: readonly string[] = [],
    options: ComfyUIEndpointPolicyOptions,
  ) {
    if (!/^sha256:[a-f0-9]{64}$/.test(options.policyRevision) && !/^revision-[A-Za-z0-9._-]+$/.test(options.policyRevision)) {
      throw new Error("ComfyUI endpoint policy revision is invalid");
    }
    this.baseUrl = canonicalEndpoint(baseUrl);
    this.controller = new AbortController();
    this.headers = Object.freeze({ ...headers });
    const canonicalAddresses = [...new Set(approvedAddresses.map(canonicalizeSocketAddress))];
    const addresses = canonicalAddresses.map((address) => ({
      address, family: net.isIP(address) as 4 | 6,
    }));
    if (addresses.length === 0) throw new Error("ComfyUI transport requires approved backend addresses");
    const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs < 1 || connectTimeoutMs > 60_000) {
      throw new Error("ComfyUI connect timeout must be between 1 and 60000 milliseconds");
    }
    const legacyTimeoutMs = options.operationTimeoutMs;
    const operationTimeout = (name: string, value: number | undefined, fallback: number) => {
      const timeout = value ?? legacyTimeoutMs ?? fallback;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30 * 60_000) {
        throw new Error(`ComfyUI ${name} timeout must be between 1 and 1800000 milliseconds`);
      }
      return timeout;
    };
    this.probeTimeoutMs = operationTimeout("probe", options.probeTimeoutMs, 30_000);
    this.submitTimeoutMs = operationTimeout("submit", options.submitTimeoutMs, 30_000);
    this.uploadTimeoutMs = operationTimeout("upload", options.uploadTimeoutMs, 5 * 60_000);
    this.downloadTimeoutMs = operationTimeout("download", options.downloadTimeoutMs, 5 * 60_000);
    if (options.lifecycleSignal) {
      const abortLifecycle = () => this.controller.abort(options.lifecycleSignal?.reason);
      if (options.lifecycleSignal.aborted) abortLifecycle();
      else {
        options.lifecycleSignal.addEventListener("abort", abortLifecycle, { once: true });
        this.removeLifecycleListener = () => options.lifecycleSignal?.removeEventListener("abort", abortLifecycle);
      }
    }
    const authorityHostname = canonicalizeUrlHostname(new URL(this.baseUrl).hostname);
    let nextAddress = 0;
    const createConnector = (): ReturnType<typeof buildConnector> => (connectOptions, callback) => {
      const operationSignal = COMFYUI_REQUEST_CONTEXT.getStore()?.controller.signal;
      const port = Number(connectOptions.port) || (connectOptions.protocol === "https:" ? 443 : 80);
      const startIndex = nextAddress++ % addresses.length;
      const candidates = addresses.map((_, index) => addresses[(startIndex + index) % addresses.length]);
      let callbackPending = true;
      const deadline = Date.now() + connectTimeoutMs;
      const connectorState: {
        timeout?: ReturnType<typeof setTimeout>;
        currentSocket?: net.Socket | tls.TLSSocket;
        cancelCurrent?: () => void;
      } = {};
      let abortListener: (() => void) | undefined;
      const finish = (error: Error | null, socket: net.Socket | tls.TLSSocket | null) => {
        if (!callbackPending) return;
        callbackPending = false;
        if (connectorState.timeout) clearTimeout(connectorState.timeout);
        if (abortListener && operationSignal) operationSignal.removeEventListener("abort", abortListener);
        connectorState.cancelCurrent?.();
        if (error) connectorState.currentSocket?.destroy();
        if (error) callback(error, null);
        else if (socket) callback(null, socket);
        else callback(new Error("Backend connector returned no socket"), null);
      };
      const requestedServername = canonicalizeUrlHostname(connectOptions.servername || authorityHostname);
      const servername = net.isIP(requestedServername) === 0 ? requestedServername : undefined;
      let candidateIndex = 0;
      const tryNext = (lastError?: Error): void => {
        if (!callbackPending) return;
        const remainingMs = deadline - Date.now();
        if (candidateIndex >= candidates.length || remainingMs <= 0) {
          finish(lastError ?? new Error(`Backend connection timed out after ${connectTimeoutMs}ms`), null);
          return;
        }
        const approved = candidates[candidateIndex++];
        const dialOptions: ComfyUIEndpointDialOptions = {
          protocol: connectOptions.protocol === "https:" ? "https:" : "http:",
          address: approved.address,
          port,
          family: approved.family,
          localAddress: connectOptions.localAddress ?? undefined,
          servername,
        };
        let socket: net.Socket | tls.TLSSocket;
        try {
          socket = options.socketFactory?.(dialOptions) ?? (connectOptions.protocol === "https:"
            ? tls.connect(port, approved.address, { servername })
            : net.connect({
                host: approved.address,
                port,
                family: approved.family,
                localAddress: connectOptions.localAddress ?? undefined,
              }));
        } catch (error) {
          tryNext(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        connectorState.currentSocket = socket;
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 60_000);
        const eventName = connectOptions.protocol === "https:" ? "secureConnect" : "connect";
        const attemptState: { timer?: ReturnType<typeof setTimeout> } = {};
        const cleanupAttempt = () => {
          if (attemptState.timer) clearTimeout(attemptState.timer);
          socket.removeListener("error", onError);
          socket.removeListener(eventName, onConnect);
          if (connectorState.cancelCurrent === cleanupAttempt) connectorState.cancelCurrent = undefined;
        };
        const failAttempt = (error: Error) => {
          cleanupAttempt();
          socket.destroy();
          if (connectorState.currentSocket === socket) connectorState.currentSocket = undefined;
          tryNext(error);
        };
        const onError = (error: Error) => failAttempt(error);
        const onConnect = () => {
          cleanupAttempt();
          if (!isApprovedRemoteAddress(socket.remoteAddress, canonicalAddresses)) {
            socket.destroy();
            if (connectorState.currentSocket === socket) connectorState.currentSocket = undefined;
            tryNext(new Error("Backend socket remote address is outside the approved endpoint policy"));
            return;
          }
          connectorState.currentSocket = undefined;
          finish(null, socket);
        };
        connectorState.cancelCurrent = cleanupAttempt;
        socket.once("error", onError);
        socket.once(eventName, onConnect);
        const attemptsRemaining = candidates.length - candidateIndex + 1;
        const attemptBudgetMs = Math.max(1, Math.floor(remainingMs / attemptsRemaining));
        attemptState.timer = setTimeout(
          () => failAttempt(new Error(`Backend connection timed out after ${connectTimeoutMs}ms`)),
          attemptBudgetMs,
        );
      };
      connectorState.timeout = setTimeout(() => {
        const error = new Error(`Backend connection timed out after ${connectTimeoutMs}ms`);
        finish(error, null);
      }, connectTimeoutMs);
      if (operationSignal) {
        abortListener = () => {
          const reason = operationSignal.reason instanceof Error
            ? operationSignal.reason
            : new Error("ComfyUI operation aborted");
          finish(reason, null);
        };
        if (operationSignal.aborted) {
          abortListener();
          return;
        }
        operationSignal.addEventListener("abort", abortListener, { once: true });
      }
      tryNext();
    };
    const connector = createConnector();
    this.dispatcher = options.httpAgentFactory?.(connector) ?? new Agent({
      connect: connector,
      connections: 4,
      pipelining: 1,
    });
    const policyDigest = createHash("sha256").update(JSON.stringify({
      endpoint: this.baseUrl,
      addresses: [...canonicalAddresses].sort(),
      revision: options.policyRevision,
    })).digest("hex");
    const registryKey = `${this.baseUrl}#credential=${credentialIdentity(this.headers)}&policy=${policyDigest}`;
    this.webSocketFactory = Object.freeze({
      canonicalEndpoint: this.baseUrl,
      registryKey,
      open: (clientId: string) => {
        const dispatcher = options.webSocketAgentFactory?.(connector) ?? new Agent({ connect: connector });
        const wsUrl = this.baseUrl.replace(/^http/, "ws") + `/ws?clientId=${encodeURIComponent(clientId)}`;
        const origin = new URL(this.baseUrl).origin;
        try {
          const ws = options.webSocketConstructor?.(wsUrl, {
            dispatcher,
            headers: { ...this.headers, Origin: origin },
          }) ?? new UndiciWebSocket(wsUrl, {
            dispatcher,
            headers: { ...this.headers, Origin: origin },
          }) as unknown as WebSocket;
          ws.addEventListener("close", () => closeAgentSafely(dispatcher), { once: true });
          return ws;
        } catch (error) {
          closeAgentSafely(dispatcher);
          throw error;
        }
      },
    });
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async request(
    url: string,
    init: NonNullable<Parameters<typeof undiciFetch>[1]>,
    submissionDisposition: ComfyUISubmissionDisposition,
    defaultTimeoutMs: number,
    options: ComfyUIOperationOptions = {},
  ): Promise<Response> {
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000) {
      throw new Error("ComfyUI operation timeout must be between 1 and 1800000 milliseconds");
    }
    const controller = new AbortController();
    const requestUrl = new URL(url);
    const context: ComfyUIRequestContext = {
      controller,
      expectedMethod: String(init.method ?? "GET").toUpperCase(),
      expectedOrigin: requestUrl.origin,
      expectedPath: `${requestUrl.pathname}${requestUrl.search}`,
      requestBytesWritten: false,
    };
    const tracksSubmission = submissionDisposition === "submission-uncertain";
    const sources = [this.controller.signal, options.signal].filter((signal): signal is AbortSignal => Boolean(signal));
    const removeListeners: Array<() => void> = [];
    let deadlineError: ComfyUIOperationDeadlineError | undefined;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      for (const remove of removeListeners) remove();
    };
    const forwardAbort = (signal: AbortSignal) => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    for (const signal of sources) {
      if (signal.aborted) {
        forwardAbort(signal);
        break;
      }
      const listener = () => forwardAbort(signal);
      signal.addEventListener("abort", listener, { once: true });
      removeListeners.push(() => signal.removeEventListener("abort", listener));
    }
    const deadlineDisposition = (): ComfyUISubmissionDisposition => {
      if (!tracksSubmission) return submissionDisposition;
      return context.trackedRequest && !context.requestBytesWritten
        ? "definitely-not-submitted"
        : "submission-uncertain";
    };
    const classifyFailure = (error: unknown): unknown => {
      if (deadlineError) return deadlineError;
      if (!tracksSubmission || error instanceof ComfyUIOperationError) return error;
      return new ComfyUIOperationError("ComfyUI submission operation failed", deadlineDisposition(), error);
    };
    const timer = setTimeout(() => {
      deadlineError = new ComfyUIOperationDeadlineError(deadlineDisposition());
      controller.abort(deadlineError);
      cleanup();
    }, timeoutMs);
    try {
      const response = await COMFYUI_REQUEST_CONTEXT.run(
        context,
        () => undiciFetch(url, {
          ...init,
          signal: controller.signal,
          dispatcher: this.dispatcher,
        }),
      );
      if (!response.body) {
        cleanup();
        return response as unknown as Response;
      }
      const reader = response.body.getReader();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        cleanup();
        reader.releaseLock();
      };
      const body = new ReadableStream<Uint8Array>({
        async pull(streamController) {
          try {
            const result = await reader.read();
            if (result.done) {
              release();
              streamController.close();
            } else {
              streamController.enqueue(result.value);
            }
          } catch (error) {
            release();
            streamController.error(classifyFailure(error));
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            release();
          }
        },
      });
      const wrapped = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers.entries()),
      });
      Object.defineProperties(wrapped, {
        url: { value: response.url, enumerable: true },
        redirected: { value: response.redirected, enumerable: true },
        type: { value: response.type, enumerable: true },
      });
      return wrapped;
    } catch (error) {
      cleanup();
      throw classifyFailure(error);
    }
  }

  async get(path: string, options: ComfyUIOperationOptions = {}): Promise<Response> {
    const allowed = path === "/system_stats" || path === "/object_info" || path === "/queue"
      || /^\/history\/[A-Za-z0-9._:-]+$/.test(path)
      || /^\/models\/[A-Za-z0-9._-]+$/.test(path);
    if (!allowed) throw new Error(`ComfyUI GET endpoint is not allowed: ${path}`);
    return this.request(this.url(path), {
      method: "GET",
      headers: this.headers,
      redirect: "manual",
    }, "definitely-not-submitted", this.probeTimeoutMs, options);
  }

  async post(path: string, body: unknown, options: ComfyUIOperationOptions = {}): Promise<Response> {
    const allowed = path === "/prompt" || path === "/interrupt" || path === "/queue" || path === "/free";
    if (!allowed) throw new Error(`ComfyUI POST endpoint is not allowed: ${path}`);
    return this.request(this.url(path), {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
    }, path === "/prompt" ? "submission-uncertain" : "definitely-not-submitted",
    path === "/prompt" ? this.submitTimeoutMs : this.probeTimeoutMs, options);
  }

  async uploadImage(input: { filename: string; bytes: Uint8Array; mimeType: string; subfolder?: string }, options: ComfyUIOperationOptions = {}): Promise<{ name: string; subfolder: string; type: string }> {
    assertSafeComfyFilePart(input.filename, "upload filename");
    assertSafeSubfolder(input.subfolder ?? "");
    if (!/^image\/(png|jpeg|webp)$/.test(input.mimeType)) throw new Error("Unsupported ComfyUI upload MIME type");
    if (input.bytes.byteLength <= 0 || input.bytes.byteLength > 20 * 1024 * 1024) throw new Error("ComfyUI upload size is invalid");
    const form = new UndiciFormData();
    // Copy to an owned ArrayBuffer so callers cannot mutate an in-flight body.
    const uploadBytes = Uint8Array.from(input.bytes);
    form.set("image", new Blob([uploadBytes.buffer], { type: input.mimeType }), input.filename);
    form.set("type", "input");
    form.set("overwrite", "false");
    if (input.subfolder) form.set("subfolder", input.subfolder);
    const response = await this.request(this.url("/upload/image"), {
      method: "POST", headers: this.headers, body: form, redirect: "manual",
    }, "submission-uncertain", this.uploadTimeoutMs, options);
    if (!response.ok) {
      await discardResponseBody(response);
      throw new Error(`ComfyUI image upload failed (${response.status})`);
    }
    const result = await readJsonLimited<Record<string, unknown>>(response, 256 * 1024);
    const name = typeof result.name === "string" ? result.name : "";
    const subfolder = typeof result.subfolder === "string" ? result.subfolder : "";
    const type = typeof result.type === "string" ? result.type : "";
    assertSafeComfyFilePart(name, "uploaded filename");
    assertSafeSubfolder(subfolder);
    if (type !== "input") throw new Error("ComfyUI image upload returned an unexpected storage type");
    return { name, subfolder, type };
  }

  async getFile(params: { filename: string; subfolder: string; type: string }, options: ComfyUIOperationOptions = {}): Promise<Response> {
    assertSafeComfyFilePart(params.filename, "output filename");
    assertSafeSubfolder(params.subfolder);
    if (!new Set(["output", "temp", "input"]).has(params.type)) throw new Error("Invalid ComfyUI output type");
    const query = new URLSearchParams(params).toString();
    return this.request(this.url(`/view?${query}`), {
      method: "GET",
      headers: this.headers,
      redirect: "manual",
    }, "definitely-submitted", this.downloadTimeoutMs, options);
  }

  getWebSocketFactory(): ComfyUIWebSocketFactory {
    return this.webSocketFactory;
  }

  async cancel(): Promise<void> {
    this.controller.abort();
  }

  async interrupt(): Promise<void> {
    const response = await this.post("/interrupt", {});
    await discardResponseBody(response);
    if (!response.ok) throw new Error(`ComfyUI interrupt failed (${response.status})`);
  }

  close(): void {
    this.cancel();
    this.removeLifecycleListener?.();
    closeAgentSafely(this.dispatcher);
  }

}


export async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`ComfyUI response exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

async function readJsonLimited<T>(response: Response, maxBytes: number): Promise<T> {
  const text = await readTextLimited(response, maxBytes);
  try {
    return JSON.parse(text || "null") as T;
  } catch {
    throw new Error(`ComfyUI returned invalid JSON (${Math.min(text.length, maxBytes)} bytes)`);
  }
}

/** 提交提示词 */
export async function submitPrompt(
  transport: ComfyUITransport,
  workflow: Record<string, unknown>,
  clientId: string,
  correlationId?: string,
  options: ComfyUIOperationOptions = {},
): Promise<ComfyPromptResponse> {
  const body: Record<string, unknown> = {
    prompt: workflow,
    client_id: clientId,
  };
  if (correlationId) {
    body.extra_data = { correlation_id: correlationId };
  }
  const response = await transport.post("/prompt", body, options);

  if (!response.ok) {
    await readTextLimited(response, 64 * 1024);
    throw new ComfyUIOperationError(
      `ComfyUI prompt submission failed (${response.status})`,
      "submission-uncertain",
    );
  }

  try {
    const raw = await readJsonLimited<Record<string, unknown>>(response, 2 * 1024 * 1024);

  // ComfyUI 原生返回 snake_case，统一映射到本地 camelCase 类型
  const promptId = typeof raw.prompt_id === "string"
    ? raw.prompt_id
    : typeof raw.promptId === "string" ? raw.promptId : "";
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(promptId)) {
    throw new Error("ComfyUI prompt submission returned an invalid prompt_id");
  }
  const number = typeof raw.number === "number" && Number.isFinite(raw.number) ? raw.number : undefined;
  const queueRemaining = typeof raw.queue_remaining === "number" && Number.isFinite(raw.queue_remaining)
    ? raw.queue_remaining
    : undefined;
  const nodeErrorsValue = raw.node_errors ?? raw.nodeErrors;
  const nodeErrorsRaw = nodeErrorsValue && typeof nodeErrorsValue === "object" && !Array.isArray(nodeErrorsValue)
    ? nodeErrorsValue as Record<string, unknown>
    : {};
  if (Object.keys(nodeErrorsRaw).length > 0) {
    const errors = Object.entries(nodeErrorsRaw).map(([nodeId, value]) => {
      const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const details = Array.isArray(record.errors)
        ? record.errors.map((entry) => {
            if (entry && typeof entry === "object" && !Array.isArray(entry)) {
              const detail = (entry as Record<string, unknown>).details;
              if (typeof detail === "string") return detail.slice(0, 500);
            }
            return "validation error";
          })
        : ["validation error"];
      return `${nodeId.slice(0, 80)}: ${details.join(", ")}`;
    }).join("; ");
    throw new Error(`ComfyUI workflow validation errors: ${errors}`);
  }

    const result: ComfyPromptResponse = { promptId, number, queueRemaining };

    return result;
  } catch (error) {
    if (error instanceof ComfyUIOperationError) throw error;
    throw new ComfyUIOperationError(
      "ComfyUI accepted the submission but returned an invalid acknowledgement",
      "submission-uncertain",
      error,
    );
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await readTextLimited(response, 64 * 1024);
  } catch {
    await response.body?.cancel().catch(() => undefined);
  }
}

/** 行为探测：获取系统信息 */
export async function probeSystemInfo(transport: ComfyUITransport, options: ComfyUIOperationOptions = {}): Promise<ComfySystemInfo> {
  const response = await transport.get("/system_stats", options);
  if (!response.ok) {
    await discardResponseBody(response);
    throw new Error(`ComfyUI system probe failed (${response.status})`);
  }
  const result = await readJsonLimited<unknown>(response, 1024 * 1024);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("ComfyUI system probe returned an invalid payload");
  return result as ComfySystemInfo;
}

/** 行为探测：获取节点对象信息 */
export async function probeObjectInfo(transport: ComfyUITransport, options: ComfyUIOperationOptions = {}): Promise<ComfyObjectInfo> {
  const response = await transport.get("/object_info", options);
  if (!response.ok) {
    await discardResponseBody(response);
    throw new Error(`ComfyUI object_info probe failed (${response.status})`);
  }
  const result = await readJsonLimited<unknown>(response, 16 * 1024 * 1024);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("ComfyUI object_info probe returned an invalid payload");
  return result as ComfyObjectInfo;
}

/** Return the exact model filenames exposed by one allow-listed ComfyUI model folder. */
export async function probeModelFolder(transport: ComfyUITransport, folder: string, options: ComfyUIOperationOptions = {}): Promise<string[]> {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(folder)) throw new Error("Invalid ComfyUI model folder");
  const response = await transport.get(`/models/${folder}`, options);
  if (!response.ok) {
    await discardResponseBody(response);
    throw new Error(`ComfyUI model probe failed (${response.status})`);
  }
  const result = await readJsonLimited<unknown>(response, 4 * 1024 * 1024);
  if (!Array.isArray(result) || result.length > 100_000) throw new Error("ComfyUI model probe returned an invalid payload");
  const models = result.map((value) => {
    if (typeof value !== "string" || value.length < 1 || value.length > 1024 || value.includes("\0")) {
      throw new Error("ComfyUI model probe returned an unsafe filename");
    }
    return value.replace(/\\/g, "/");
  });
  return [...new Set(models)];
}

export interface ComfyQueueEntry {
  promptId: string;
  correlationId?: string;
  queueNumber?: number;
  raw: unknown;
}

function normalizeQueueEntry(value: unknown): ComfyQueueEntry | null {
  if (Array.isArray(value)) {
    const promptId = typeof value[1] === "string" ? value[1] : "";
    if (!promptId) return null;
    const extra = value[3] && typeof value[3] === "object" && !Array.isArray(value[3])
      ? value[3] as Record<string, unknown>
      : {};
    const nested = extra.extra_data && typeof extra.extra_data === "object" && !Array.isArray(extra.extra_data)
      ? extra.extra_data as Record<string, unknown>
      : {};
    const correlationId = typeof extra.correlation_id === "string"
      ? extra.correlation_id
      : typeof nested.correlation_id === "string" ? nested.correlation_id : undefined;
    return { promptId, correlationId, queueNumber: typeof value[0] === "number" ? value[0] : undefined, raw: value };
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const promptId = typeof record.prompt_id === "string"
      ? record.prompt_id
      : typeof record.promptId === "string" ? record.promptId : typeof record.id === "string" ? record.id : "";
    if (!promptId) return null;
    const correlationId = typeof record.correlation_id === "string"
      ? record.correlation_id
      : typeof record.correlationId === "string" ? record.correlationId : undefined;
    return { promptId, correlationId, queueNumber: typeof record.number === "number" ? record.number : undefined, raw: value };
  }
  return null;
}

/** 行为探测：获取队列状态 */
export async function probeQueueStatus(
  transport: ComfyUITransport,
  correlationId?: string,
  options: ComfyUIOperationOptions = {},
): Promise<{
  queueRunning: ComfyQueueEntry[];
  queuePending: ComfyQueueEntry[];
}> {
  const response = await transport.get("/queue", options);
  if (!response.ok) {
    await discardResponseBody(response);
    throw new Error(`ComfyUI queue probe failed (${response.status})`);
  }
  const data = await readJsonLimited<Record<string, unknown>>(response, 8 * 1024 * 1024);
  void correlationId;
  const runningRaw = Array.isArray(data.queue_running) ? data.queue_running : [];
  const pendingRaw = Array.isArray(data.queue_pending) ? data.queue_pending : [];
  return {
    queueRunning: runningRaw.map(normalizeQueueEntry).filter((item): item is ComfyQueueEntry => Boolean(item)),
    queuePending: pendingRaw.map(normalizeQueueEntry).filter((item): item is ComfyQueueEntry => Boolean(item)),
  };
}

/** 行为探测：获取历史记录 */
export async function probeHistory(
  transport: ComfyUITransport,
  promptId: string,
  correlationId?: string,
  options: ComfyUIOperationOptions = {},
): Promise<Record<string, ComfyExecutionResult>> {
  if (!/^[A-Za-z0-9._:-]+$/.test(promptId)) throw new Error("Invalid ComfyUI prompt ID");
  const response = await transport.get(`/history/${promptId}`, options);
  if (!response.ok) {
    await discardResponseBody(response);
    throw new Error(`ComfyUI history probe failed (${response.status})`);
  }
  void correlationId;
  return readJsonLimited<Record<string, ComfyExecutionResult>>(response, 16 * 1024 * 1024);
}

/** 创建 ComfyUI 传输适配器（带地址校验） */
export async function createComfyUITransport(
  baseUrl: string,
  topology: string,
  headers: Record<string, string> = {},
  expectedResolvedAddresses: readonly string[] = [],
  options: ComfyUIEndpointPolicyOptions,
): Promise<ComfyUITransport> {
  if (!isEnabled(FF.V2_COMFYUI_TRANSPORT)) {
    throw new Error("v2.0 ComfyUI transport is not enabled");
  }

  // SSRF 防护
  const resolutionTimeoutMs = options.resolutionTimeoutMs ?? options.operationTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(resolutionTimeoutMs) || resolutionTimeoutMs < 1 || resolutionTimeoutMs > 30 * 60_000) {
    throw new Error("ComfyUI resolution timeout must be between 1 and 1800000 milliseconds");
  }
  const resolutionController = new AbortController();
  let resolutionDeadline: ComfyUIOperationDeadlineError | undefined;
  const abortResolution = () => resolutionController.abort(options.lifecycleSignal?.reason);
  if (options.lifecycleSignal?.aborted) abortResolution();
  else options.lifecycleSignal?.addEventListener("abort", abortResolution, { once: true });
  const resolutionTimer = setTimeout(() => {
    resolutionDeadline = new ComfyUIOperationDeadlineError("definitely-not-submitted");
    resolutionController.abort(resolutionDeadline);
  }, resolutionTimeoutMs);
  let validation: Awaited<ReturnType<typeof validateBackendUrlResolved>>;
  try {
    validation = await validateBackendUrlResolved(
      baseUrl,
      topology as import("@/lib/security/network-policy").BackendTopology,
      options.resolver,
      resolutionController.signal,
    );
  } catch (error) {
    throw resolutionDeadline ?? error;
  } finally {
    clearTimeout(resolutionTimer);
    options.lifecycleSignal?.removeEventListener("abort", abortResolution);
  }
  if (!validation.valid) {
    throw new Error(`Invalid ComfyUI backend URL: ${validation.errors.join("; ")}`);
  }
  if (expectedResolvedAddresses.length) {
    const expected = [...new Set(expectedResolvedAddresses.map(canonicalizeSocketAddress))].sort();
    const actual = [...new Set(validation.resolvedAddresses.map(canonicalizeSocketAddress))].sort();
    if (expected.length !== actual.length || expected.some((address, index) => address !== actual[index])) {
      throw new Error("ComfyUI backend DNS resolution differs from the approved backend revision");
    }
  }

  return new ComfyUIHttpTransport(baseUrl, headers, validation.resolvedAddresses, options);
}
