/**
 * v2.0 ComfyUI 共享实时连接管理器
 *
 * 手册 §10.5：每个后端只维护一个共享实时连接管理器。
 * - 按外部任务编号分派事件
 * - 事件去重
 * - 断线指数退避和随机抖动
 * - 连接代次编号，防止旧连接事件污染新连接
 * - 事件只更新进度快照，不直接决定最终成功
 * - 高频进度合并写入
 */

import type { ComfyWSMessage } from "./comfyui";

/** 连接状态 */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "closing";

/** 进度快照（由事件更新，非最终事实） */
export interface ProgressSnapshot {
  promptId: string;
  currentNode: string | null;
  progressValue: number;
  progressMax: number;
  executedNodes: Set<string>;
  lastEventAtMs: number;
  status: "queued" | "running" | "executed" | "error" | "unknown";
}

/** 连接事件监听 */
export type ConnectionEventListener = (event: ConnectionEvent) => void;

export type ConnectionEvent =
  | { type: "state_change"; state: ConnectionState; generation: number }
  | { type: "message"; data: ComfyWSMessage; generation: number }
  | { type: "error"; error: string; generation: number }
  | { type: "reconnecting"; attempt: number; delayMs: number; generation: number };

/** 任务事件回调 */
export type TaskEventHandler = (msg: ComfyWSMessage, snapshot: ProgressSnapshot) => void;

/** 重连配置 */
export interface ReconnectConfig {
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  jitterFactor: number;
  maxAttempts: number;
}

export interface ComfyUIWebSocketFactory {
  readonly canonicalEndpoint: string;
  readonly registryKey: string;
  open(): WebSocket;
}

const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  backoffFactor: 2,
  jitterFactor: 0.3,
  maxAttempts: 5,
};

/**
 * 共享 WebSocket 连接管理器
 *
 * 每个后端一个实例，按 prompt_id 多路复用事件。
 * 使用连接代次（generation）防止旧连接的延迟消息污染。
 */
export class ComfyUIConnectionManager {
  private readonly createWebSocket: () => WebSocket;
  private readonly config: ReconnectConfig;

  private ws: WebSocket | null = null;
  private state: ConnectionState = "disconnected";
  private generation = 0;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  private listeners = new Set<ConnectionEventListener>();
  private taskHandlers = new Map<string, Set<TaskEventHandler>>();
  private progressSnapshots = new Map<string, ProgressSnapshot>();

  private lastProgressWriteMs = 0;
  private readonly progressWriteIntervalMs = 2_000;

  constructor(createWebSocket: () => WebSocket, config: Partial<ReconnectConfig> = {}) {
    this.createWebSocket = createWebSocket;
    this.config = { ...DEFAULT_RECONNECT_CONFIG, ...config };
  }

  getState(): ConnectionState {
    return this.state;
  }

  getGeneration(): number {
    return this.generation;
  }

  /** 添加连接级事件监听 */
  addListener(listener: ConnectionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 注册任务事件处理器（按 prompt_id 分派） */
  registerTaskHandler(promptId: string, handler: TaskEventHandler): () => void {
    let handlers = this.taskHandlers.get(promptId);
    if (!handlers) {
      handlers = new Set();
      this.taskHandlers.set(promptId, handlers);
    }
    handlers.add(handler);

    if (!this.progressSnapshots.has(promptId)) {
      this.progressSnapshots.set(promptId, {
        promptId,
        currentNode: null,
        progressValue: 0,
        progressMax: 0,
        executedNodes: new Set(),
        lastEventAtMs: Date.now(),
        status: "queued",
      });
    }

    return () => {
      handlers!.delete(handler);
      if (handlers!.size === 0) {
        this.taskHandlers.delete(promptId);
      }
    };
  }

  /** 获取任务进度快照 */
  getProgressSnapshot(promptId: string): ProgressSnapshot | undefined {
    return this.progressSnapshots.get(promptId);
  }

  /** 连接 */
  connect(): void {
    if (this.state === "connected" || this.state === "connecting") {
      return;
    }

    this.shouldReconnect = true;
    this.doConnect();
  }

  private doConnect(): void {
    if (this.ws) this.retireSocket(this.ws, true);
    this.generation++;
    const currentGen = this.generation;
    this.setState("connecting");

    try {
      this.ws = this.createWebSocket();
    } catch (err) {
      this.handleConnectionError(`Failed to create WebSocket: ${err}`);
      return;
    }

    const socket = this.ws;
    let active = true;

    socket.onopen = () => {
      if (!active || currentGen !== this.generation) return;
      this.setState("connected");
    };

    socket.onmessage = (event) => {
      if (!active || currentGen !== this.generation) return;
      this.handleMessage(event.data, currentGen);
    };

    socket.onerror = () => {
      if (!active || currentGen !== this.generation) return;
      active = false;
      this.retireSocket(socket, true);
      this.handleConnectionError("WebSocket error");
    };

    socket.onclose = () => {
      if (!active || currentGen !== this.generation) return;
      active = false;
      this.retireSocket(socket, false);
      this.setState("disconnected");
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };
  }

  private handleMessage(rawData: unknown, generation: number): void {
    let msg: ComfyWSMessage;
    try {
      msg = JSON.parse(typeof rawData === "string" ? rawData : "") as ComfyWSMessage;
    } catch {
      return;
    }

    this.emit({ type: "message", data: msg, generation });

    const promptId = this.extractPromptId(msg);
    if (!promptId) return;

    const snapshot = this.getOrCreateSnapshot(promptId);
    this.updateSnapshot(snapshot, msg);

    const handlers = this.taskHandlers.get(promptId);
    if (handlers && handlers.size > 0) {
      const now = Date.now();
      const shouldThrottle =
        msg.type === "progress" && now - this.lastProgressWriteMs < this.progressWriteIntervalMs;

      if (!shouldThrottle) {
        this.lastProgressWriteMs = now;
        for (const handler of handlers) {
          try {
            handler(msg, snapshot);
          } catch {
            // 忽略单个 handler 错误，不影响其他任务
          }
        }
      }
    }
  }

  private extractPromptId(msg: ComfyWSMessage): string | null {
    switch (msg.type) {
      case "execution_start":
      case "execution_cached":
      case "executing":
      case "progress":
      case "executed":
      case "execution_error":
        return msg.data.prompt_id as string;
      case "status":
        return null;
      default:
        return null;
    }
  }

  private getOrCreateSnapshot(promptId: string): ProgressSnapshot {
    let snap = this.progressSnapshots.get(promptId);
    if (!snap) {
      snap = {
        promptId,
        currentNode: null,
        progressValue: 0,
        progressMax: 0,
        executedNodes: new Set(),
        lastEventAtMs: Date.now(),
        status: "queued",
      };
      this.progressSnapshots.set(promptId, snap);
    }
    return snap;
  }

  private updateSnapshot(snap: ProgressSnapshot, msg: ComfyWSMessage): void {
    snap.lastEventAtMs = Date.now();

    switch (msg.type) {
      case "execution_start":
        snap.status = "running";
        break;
      case "executing":
        snap.currentNode = msg.data.node;
        if (msg.data.node) {
          snap.status = "running";
        }
        break;
      case "progress":
        snap.currentNode = msg.data.node;
        snap.progressValue = msg.data.value;
        snap.progressMax = msg.data.max;
        break;
      case "executed":
        snap.executedNodes.add(msg.data.node);
        break;
      case "execution_error":
        snap.status = "error";
        break;
      case "execution_cached":
        for (const n of msg.data.nodes) {
          snap.executedNodes.add(n);
        }
        break;
    }
  }

  private handleConnectionError(error: string): void {
    this.emit({ type: "error", error, generation: this.generation });
    this.setState("disconnected");
    if (this.shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.config.maxAttempts) return;

    this.reconnectAttempts++;
    const baseDelay =
      this.config.initialDelayMs *
      Math.pow(this.config.backoffFactor, this.reconnectAttempts - 1);
    const cappedDelay = Math.min(baseDelay, this.config.maxDelayMs);
    const jitter = cappedDelay * this.config.jitterFactor * (Math.random() * 2 - 1);
    const delay = Math.max(this.config.initialDelayMs, Math.round(cappedDelay + jitter));

    this.emit({
      type: "reconnecting",
      attempt: this.reconnectAttempts,
      delayMs: delay,
      generation: this.generation,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this.doConnect();
      }
    }, delay);
  }

  /**
   * 断开连接（递增代次，防止旧消息污染）
   */
  disconnect(): void {
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.generation++;

    if (this.ws) {
      this.setState("closing");
      this.retireSocket(this.ws, true);
    }

    this.setState("disconnected");
  }

  private retireSocket(socket: WebSocket, close: boolean): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (this.ws === socket) this.ws = null;
    if (!close) return;
    try {
      socket.close();
    } catch {
      // Ownership and event handlers are already detached; closing is best effort.
    }
  }

  /** 重置进度快照（任务完成后清理） */
  clearTaskSnapshot(promptId: string): void {
    this.progressSnapshots.delete(promptId);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit({ type: "state_change", state, generation: this.generation });
  }

  private emit(event: ConnectionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 忽略单个 listener 错误
      }
    }
  }
}

/**
 * 连接管理器注册表
 * 每个后端 URL 对应一个共享连接管理器
 */
class ConnectionManagerRegistry {
  private managers = new Map<string, ComfyUIConnectionManager>();
  private activeKeyByEndpoint = new Map<string, string>();

  getOrCreate(factory: ComfyUIWebSocketFactory): ComfyUIConnectionManager {
    let mgr = this.managers.get(factory.registryKey);
    if (!mgr) {
      const previousKey = this.activeKeyByEndpoint.get(factory.canonicalEndpoint);
      if (previousKey && previousKey !== factory.registryKey) {
        this.managers.get(previousKey)?.disconnect();
        this.managers.delete(previousKey);
      }
      mgr = new ComfyUIConnectionManager(() => factory.open());
      this.managers.set(factory.registryKey, mgr);
      this.activeKeyByEndpoint.set(factory.canonicalEndpoint, factory.registryKey);
    }
    return mgr;
  }

  getAll(): ComfyUIConnectionManager[] {
    return Array.from(this.managers.values());
  }

  closeAll(): void {
    for (const mgr of this.managers.values()) {
      mgr.disconnect();
    }
    this.managers.clear();
    this.activeKeyByEndpoint.clear();
  }
}

export const connectionManagerRegistry = new ConnectionManagerRegistry();
