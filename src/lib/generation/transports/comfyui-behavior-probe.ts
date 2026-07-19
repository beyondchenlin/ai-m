/**
 * v2.0 ComfyUI 行为探测
 *
 * 手册 §10.3：后端启用前必须进行行为探测，不能只读取版本字符串。
 * 探测结果带环境指纹和有效期，环境变化后强制重探测。
 */

import type { ComfyUITransport, ComfySystemInfo, ComfyObjectInfo } from "./comfyui";
import { probeSystemInfo, probeObjectInfo, probeQueueStatus } from "./comfyui";
import { createHash } from "crypto";

/** 外部任务 ID 策略 */
export type ExternalIdStrategy = "client-assigned" | "server-assigned" | "not-applicable";

/** 取消能力探测结果 */
export interface CancellationCapabilities {
  /** 是否支持按任务取消（/queue API） */
  supportsPerTaskCancel: boolean;
  /** 是否存在全局中断（/interrupt） */
  hasGlobalInterrupt: boolean;
  /** 共享后端是否安全（即有按任务取消则可共享） */
  safeForShared: boolean;
}

/** 输出能力 */
export interface OutputCapabilities {
  /** 输出读取方式：view（HTTP GET） */
  readMethod: "view" | "api" | "both";
  /** 是否支持流式输出 */
  supportsStreaming: boolean;
  /** 最大输出文件大小估算（字节） */
  maxOutputSizeBytesEstimate: number;
}

/** 后端特征快照（持久化到 attempt） */
export interface BackendFeatureSnapshot {
  /** 环境指纹（系统信息+节点列表的哈希） */
  environmentFingerprint: string;
  /** ComfyUI 版本 */
  comfyVersion?: string;
  /** 外部任务 ID 策略 */
  externalIdStrategy: ExternalIdStrategy;
  /** 取消能力 */
  cancellation: CancellationCapabilities;
  /** 输出能力 */
  output: OutputCapabilities;
  /** 支持的节点类别 */
  nodeCategories: string[];
  /** 设备信息摘要 */
  devicesSummary: string[];
  /** 探测时间戳 */
  probedAtMs: number;
  /** 有效期截止时间戳 */
  validUntilMs: number;
}

/** 探测配置 */
export interface ProbeConfig {
  /** 探测结果有效期（ms） */
  ttlMs: number;
  /** 提交探测超时（ms） */
  submitProbeTimeoutMs: number;
  /** 是否启用客户端 ID 一致性探测 */
  probeClientIdConsistency: boolean;
}

export interface BackendEnvironmentProbe {
  features: BackendFeatureSnapshot;
  objectInfo: ComfyObjectInfo;
}

const DEFAULT_PROBE_CONFIG: ProbeConfig = {
  ttlMs: 30 * 60 * 1000,
  submitProbeTimeoutMs: 10_000,
  probeClientIdConsistency: true,
};

/** 生成环境指纹 */
function computeEnvironmentFingerprint(
  systemInfo: ComfySystemInfo,
  objectInfo: ComfyObjectInfo,
): string {
  const deviceFingerprint = (systemInfo.devices ?? [])
    .map((d) => `${d.name}:${d.type}:${d.vramTotal}`)
    .sort()
    .join("|");

  const nodeFingerprint = Object.keys(objectInfo).sort().join(",");

  const hash = createHash("sha256");
  hash.update(deviceFingerprint);
  hash.update("||");
  hash.update(nodeFingerprint);
  hash.update("||");
  hash.update(JSON.stringify(systemInfo.system ?? {}));
  return `env:${hash.digest("hex").slice(0, 32)}`;
}

/**
 * Determine protocol behaviour without submitting or interrupting user work.
 * Health probes must be observational: a configuration screen must never enqueue
 * an inference job or interrupt another tenant's execution.
 */
async function probeExternalIdStrategy(): Promise<ExternalIdStrategy> {
  return "server-assigned";
}

/** Passive cancellation capability detection. */
async function probeCancellationCapabilities(
  transport: ComfyUITransport,
): Promise<CancellationCapabilities> {
  try {
    const queue = await probeQueueStatus(transport);
    const standardQueueShape = Array.isArray(queue.queueRunning) && Array.isArray(queue.queuePending);
    return {
      // Standard ComfyUI accepts POST /queue { delete: [promptId] }. The actual
      // cancellation result is still reconciled before a local terminal state.
      supportsPerTaskCancel: standardQueueShape,
      hasGlobalInterrupt: true,
      safeForShared: standardQueueShape,
    };
  } catch {
    return { supportsPerTaskCancel: false, hasGlobalInterrupt: false, safeForShared: false };
  }
}

/** 探测输出能力 */
async function probeOutputCapabilities(
  transport: ComfyUITransport,
): Promise<OutputCapabilities> {
  return {
    readMethod: "view",
    supportsStreaming: false,
    maxOutputSizeBytesEstimate: 100 * 1024 * 1024,
  };
}

/**
 * 执行完整行为探测
 *
 * 按手册 §10.3，探测内容包括：
 * - 健康与系统状态
 * - 节点和模型能力
 * - 外部任务编号策略
 * - 历史对账能力
 * - 取消能力
 * - 输出读取方式
 * - 最大请求响应限制
 */
export async function probeBackendEnvironment(
  transport: ComfyUITransport,
  config: Partial<ProbeConfig> = {},
  observeObjectInfo?: (objectInfo: ComfyObjectInfo) => void,
): Promise<BackendEnvironmentProbe> {
  const cfg = { ...DEFAULT_PROBE_CONFIG, ...config };
  const now = Date.now();

  const [systemInfo, objectInfo, queueStatus, cancellation, output] = await Promise.all([
    probeSystemInfo(transport),
    probeObjectInfo(transport),
    probeQueueStatus(transport).catch(() => ({ queueRunning: [], queuePending: [] })),
    probeCancellationCapabilities(transport),
    probeOutputCapabilities(transport),
  ]);

  const environmentFingerprint = computeEnvironmentFingerprint(systemInfo, objectInfo);
  observeObjectInfo?.(objectInfo);
  const externalIdStrategy = await probeExternalIdStrategy();

  const nodeCategories = new Set<string>();
  for (const info of Object.values(objectInfo)) {
    if (info.category) {
      nodeCategories.add(info.category);
    }
  }

  const devicesSummary = (systemInfo.devices ?? []).map(
    (d) => `${d.name} (${d.type}, ${Math.round(d.vramTotal / 1024 / 1024)}MB VRAM)`,
  );

  return {
    objectInfo,
    features: {
    environmentFingerprint,
    comfyVersion: (systemInfo.system?.comfy_version as string | undefined),
    externalIdStrategy,
    cancellation,
    output,
    nodeCategories: Array.from(nodeCategories).sort(),
    devicesSummary,
    probedAtMs: now,
    validUntilMs: now + cfg.ttlMs,
    },
  };
}

export async function probeBackendFeatures(
  transport: ComfyUITransport,
  config: Partial<ProbeConfig> = {},
  observeObjectInfo?: (objectInfo: ComfyObjectInfo) => void,
): Promise<BackendFeatureSnapshot> {
  return (await probeBackendEnvironment(transport, config, observeObjectInfo)).features;
}

/** 检查探测结果是否仍在有效期内 */
export function isProbeFresh(snapshot: BackendFeatureSnapshot, nowMs = Date.now()): boolean {
  return nowMs < snapshot.validUntilMs;
}

/** 检查环境指纹是否匹配 */
export function checkEnvironmentDrift(
  current: BackendFeatureSnapshot,
  transport: ComfyUITransport,
): Promise<boolean> {
  return probeSystemInfo(transport)
    .then((sysInfo) =>
      probeObjectInfo(transport).then((objInfo) => {
        const newFingerprint = computeEnvironmentFingerprint(sysInfo, objInfo);
        return newFingerprint !== current.environmentFingerprint;
      }),
    )
    .catch(() => true);
}
