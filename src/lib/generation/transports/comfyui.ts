/**
 * v2.0 ComfyUI 传输适配器
 *
 * 手册 §9、§10：HTTP 提交提示词 + WebSocket 监听进度。
 * 包括行为探测、提交关联、取消和断线重连。
 */

import { isEnabled, FF } from "@/lib/feature-flags";
import { validateBackendUrl } from "@/lib/security/network-policy";

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
  | { type: "progress"; data: { node: string; value: number; max: number } }
  | { type: "executed"; data: { prompt_id: string; node: string; output: Record<string, unknown> } }
  | { type: "execution_error"; data: { prompt_id: string; node_id: string; node_type: string; exception_message: string; traceback: string[] } };

/** 传输适配器接口 */
export interface ComfyUITransport {
  /** 代理请求到 ComfyUI */
  post(path: string, body: unknown): Promise<Response>;
  /** 获取文件 */
  getFile(params: { filename: string; subfolder: string; type: string }): Promise<Response>;
  /** 建立 WebSocket 连接 */
  connectWebSocket(): WebSocket;
  /** 取消当前提示词 */
  cancel(): Promise<void>;
  /** 中断执行 */
  interrupt(): Promise<void>;
  /** 释放连接 */
  close(): void;
}

/** HTTP 传输实现 */
export class ComfyUIHttpTransport implements ComfyUITransport {
  private readonly baseUrl: string;
  private readonly controller: AbortController;
  private ws: WebSocket | null = null;
  private clientId: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.controller = new AbortController();
    this.clientId = this.generateClientId();
  }

  private generateClientId(): string {
    return `ai-m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async post(path: string, body: unknown): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: this.controller.signal,
    });
  }

  async getFile(params: { filename: string; subfolder: string; type: string }): Promise<Response> {
    const query = new URLSearchParams(params).toString();
    const url = `${this.baseUrl}/view?${query}`;
    return fetch(url, { signal: this.controller.signal });
  }

  connectWebSocket(): WebSocket {
    const wsUrl = this.baseUrl.replace(/^http/, "ws") + `/ws?clientId=${this.clientId}`;
    this.ws = new WebSocket(wsUrl);
    return this.ws;
  }

  async cancel(): Promise<void> {
    this.controller.abort();
  }

  async interrupt(): Promise<void> {
    await this.post("/interrupt", {});
  }

  close(): void {
    this.cancel();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  getClientId(): string {
    return this.clientId;
  }
}

/** 提交提示词 */
export async function submitPrompt(
  transport: ComfyUITransport,
  workflow: Record<string, unknown>,
  clientId: string,
): Promise<ComfyPromptResponse> {
  const response = await transport.post("/prompt", {
    prompt: workflow,
    client_id: clientId,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ComfyUI prompt submission failed (${response.status}): ${text}`);
  }

  const result = await response.json() as ComfyPromptResponse;

  if (result.nodeErrors && Object.keys(result.nodeErrors).length > 0) {
    const errors = Object.entries(result.nodeErrors)
      .map(([nodeId, err]) => `${nodeId}: ${err.errors.map((e) => e.details).join(", ")}`)
      .join("; ");
    throw new Error(`ComfyUI workflow validation errors: ${errors}`);
  }

  return result;
}

/** 行为探测：获取系统信息 */
export async function probeSystemInfo(transport: ComfyUITransport): Promise<ComfySystemInfo> {
  const response = await transport.post("/system_stats", {});
  if (!response.ok) {
    throw new Error(`ComfyUI system probe failed (${response.status})`);
  }
  return response.json() as Promise<ComfySystemInfo>;
}

/** 行为探测：获取节点对象信息 */
export async function probeObjectInfo(transport: ComfyUITransport): Promise<ComfyObjectInfo> {
  const response = await transport.post("/object_info", {});
  if (!response.ok) {
    throw new Error(`ComfyUI object_info probe failed (${response.status})`);
  }
  return response.json() as Promise<ComfyObjectInfo>;
}

/** 行为探测：获取队列状态 */
export async function probeQueueStatus(transport: ComfyUITransport): Promise<{
  queueRunning: Array<unknown>;
  queuePending: Array<unknown>;
}> {
  const response = await transport.post("/queue", {});
  if (!response.ok) {
    throw new Error(`ComfyUI queue probe failed (${response.status})`);
  }
  return response.json();
}

/** 行为探测：获取历史记录 */
export async function probeHistory(
  transport: ComfyUITransport,
  promptId: string,
): Promise<Record<string, ComfyExecutionResult>> {
  const response = await transport.post(`/history/${promptId}`, {});
  if (!response.ok) {
    throw new Error(`ComfyUI history probe failed (${response.status})`);
  }
  return response.json();
}

/** 下载输出文件 */
export async function downloadOutput(
  transport: ComfyUITransport,
  output: { filename: string; subfolder: string; type: string },
): Promise<ArrayBuffer> {
  const response = await transport.getFile(output);
  if (!response.ok) {
    throw new Error(`ComfyUI file download failed (${response.status}): ${output.filename}`);
  }
  return response.arrayBuffer();
}

/** 创建 ComfyUI 传输适配器（带地址校验） */
export async function createComfyUITransport(
  baseUrl: string,
  topology: string,
): Promise<ComfyUITransport> {
  if (!isEnabled(FF.V2_COMFYUI_TRANSPORT)) {
    throw new Error("v2.0 ComfyUI transport is not enabled");
  }

  // SSRF 防护
  const validation = validateBackendUrl(baseUrl, topology);
  if (!validation.valid) {
    throw new Error(`Invalid ComfyUI backend URL: ${validation.error}`);
  }

  return new ComfyUIHttpTransport(baseUrl);
}