/**
 * v2.0 生成服务接口
 *
 * 手册 §16.2、附录 A：业务层只依赖这些接口，不直接调用供应商。
 */

import type { Capability } from "../naming";
import type { ImageRequest, TextRequest, VideoRequest, SpeechRequest } from "./providers";

/** 生成任务创建输入 */
export interface CreateGenerationJobInput {
  capability: Capability;
  profileRevisionId: string;
  projectId: string;
  request: ImageRequest | TextRequest | VideoRequest | SpeechRequest;
  /** Caller-generated operation key. Reusing it returns the existing job. */
  idempotencyKey?: string;
  businessContext?: {
    kind: string;
    id: string;
  };
  /** Immutable safe metadata required by the worker before external submission. */
  metadata?: Record<string, unknown>;
  /** Immutable user-owned source inputs captured as durable job references. */
  sourceAssets?: Array<{ id: string; role: string }>;
}

/** 生成任务视图（安全字段，不返回密钥和内部地址） */
export interface GenerationJobView {
  id: string;
  capability: Capability;
  status: string;
  phase?: string;
  progress?: number;
  errorMessageSafe?: string;
  artifacts?: ArtifactRef[];
  canCancel: boolean;
  needsAttention: boolean;
  needsAttentionReason?: string;
  createdAtMs: number;
  completedAtMs?: number;
}

export interface ArtifactRef {
  id: string;
  kind: string;
  /** Same-origin authorized download URL. Internal storage keys are never exposed. */
  url: string;
  mimeType: string;
  width?: number;
  height?: number;
  durationMs?: number;
  sizeBytes: number;
}

/** 重试模式 */
export type RetryMode = "retry_full";

/** 生成任务服务 */
export interface GenerationJobService {
  /** 创建生成任务 */
  create(input: CreateGenerationJobInput, actor: Actor): Promise<GenerationJobView>;
  /** 取消任务 */
  cancel(jobId: string, actor: Actor): Promise<GenerationJobView>;
  /** 重试任务 */
  retry(jobId: string, actor: Actor, mode: RetryMode): Promise<GenerationJobView>;
  /** 查询任务状态 */
  get(jobId: string, actor: Actor): Promise<GenerationJobView>;
}

/** 工作流编译器 */
export interface WorkflowCompiler {
  /** 编译工作流包：语义选择器 → 固定节点绑定 */
  compile(input: WorkflowPackageSource, policy: WorkflowSecurityPolicy): Promise<CompiledWorkflowPackage>;
}

export interface WorkflowPackageSource {
  workflowApi: Record<string, unknown>;
  manifest: Record<string, unknown>;
  packageLock: Record<string, unknown>;
}

export interface WorkflowSecurityPolicy {
  allowedNodeClasses: string[];
  maxExecutionTimeMs: number;
  maxOutputCount: number;
  maxOutputSizeBytes: number;
  allowedMediaTypes: string[];
}

export interface CompiledWorkflowPackage {
  digest: string;
  workflowSha256: string;
  compiledBindings: Record<string, unknown>;
  environmentLockDigest: string;
}

/** 工件提交器 */
export interface ArtifactCommitter {
  /** 流式提交工件：边读边校验边写 */
  commit(input: ArtifactCommitInput): Promise<CommittedArtifact>;
}

export interface ArtifactCommitInput {
  attemptId: string;
  logicalName: string;
  kind: string;
  stream: ReadableStream<Uint8Array>;
  expectedMimeType: string;
  visibility: string;
  parentArtifactId?: string;
}

export interface CommittedArtifact {
  id: string;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

/** 操作者 */
export interface Actor {
  userId: string;
  roles: string[];
}