/**
 * v2.0 命名词典
 *
 * 统一领域术语，防止业务代码、数据库字段、接口参数和文档之间的命名漂移。
 * 所有新代码必须使用此处定义的术语，禁止混用。
 */

/** 能力类型 */
export const Capability = {
  TEXT: "text",
  IMAGE: "image",
  VIDEO: "video",
  SPEECH: "speech",
  UTILITY: "utility",
} as const;
export type Capability = (typeof Capability)[keyof typeof Capability];

/** 执行后端拓扑 */
export const Topology = {
  SAME_HOST: "same-host",
  CONTAINER_TO_HOST: "container-to-host",
  SAME_HOST_CONTAINER: "same-host-container",
  LAN_REMOTE: "lan-remote",
} as const;
export type Topology = (typeof Topology)[keyof typeof Topology];

/** 后端共享模式 */
export const SharingMode = {
  DEDICATED: "dedicated",
  SHARED: "shared",
} as const;
export type SharingMode = (typeof SharingMode)[keyof typeof SharingMode];

/** 认证类型 */
export const AuthType = {
  NONE: "none",
  BEARER: "bearer",
  HEADER_TOKEN: "header-token",
  BASIC: "basic",
  MTLS: "mtls",
} as const;
export type AuthType = (typeof AuthType)[keyof typeof AuthType];

/** 工作流包状态 */
export const WorkflowPackageState = {
  INSTALLED: "installed",
  VALIDATING: "validating",
  REVIEWED: "reviewed",
  ACTIVE: "active",
  DEPRECATED: "deprecated",
  REVOKED: "revoked",
  INVALID: "invalid",
} as const;
export type WorkflowPackageState = (typeof WorkflowPackageState)[keyof typeof WorkflowPackageState];

/** 生成配置可见性 */
export const ProfileVisibility = {
  ADMIN: "admin",
  WORKSPACE: "workspace",
  PROJECT: "project",
} as const;
export type ProfileVisibility = (typeof ProfileVisibility)[keyof typeof ProfileVisibility];

/** 逻辑任务状态 */
export const JobStatus = {
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  CANCEL_REQUESTED: "CANCEL_REQUESTED",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  NEEDS_ATTENTION: "NEEDS_ATTENTION",
} as const;
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

/** 执行尝试阶段 */
export const AttemptPhase = {
  CREATED: "CREATED",
  LEASED: "LEASED",
  PREPARING: "PREPARING",
  SUBMITTING: "SUBMITTING",
  SUBMISSION_UNKNOWN: "SUBMISSION_UNKNOWN",
  EXTERNAL_QUEUED: "EXTERNAL_QUEUED",
  EXTERNAL_RUNNING: "EXTERNAL_RUNNING",
  COLLECTING: "COLLECTING",
  COMMITTING: "COMMITTING",
  RETRY_WAIT: "RETRY_WAIT",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCEL_REQUESTED: "CANCEL_REQUESTED",
  CANCELLED: "CANCELLED",
  ORPHANED: "ORPHANED",
} as const;
export type AttemptPhase = (typeof AttemptPhase)[keyof typeof AttemptPhase];

/** 外部任务编号策略 */
export const ExternalIdStrategy = {
  CLIENT_ASSIGNED: "client-assigned",
  SERVER_ASSIGNED: "server-assigned",
  NOT_APPLICABLE: "not-applicable",
} as const;
export type ExternalIdStrategy = (typeof ExternalIdStrategy)[keyof typeof ExternalIdStrategy];

/** 工件状态 */
export const ArtifactStatus = {
  STAGING: "STAGING",
  COMMITTED: "COMMITTED",
  QUARANTINED: "QUARANTINED",
  DELETED: "DELETED",
} as const;
export type ArtifactStatus = (typeof ArtifactStatus)[keyof typeof ArtifactStatus];

/** 工件可见性 */
export const ArtifactVisibility = {
  PRIVATE_ORIGINAL: "private-original",
  PROJECT: "project",
  EXPORT: "export",
} as const;
export type ArtifactVisibility = (typeof ArtifactVisibility)[keyof typeof ArtifactVisibility];

/** 工件类型 */
export const ArtifactKind = {
  IMAGE: "image",
  VIDEO: "video",
  AUDIO: "audio",
  TEXT: "text",
  ARCHIVE: "archive",
} as const;
export type ArtifactKind = (typeof ArtifactKind)[keyof typeof ArtifactKind];

/** 错误分类 */
export const ErrorClass = {
  PERMANENT_INPUT: "PERMANENT_INPUT",
  WORKFLOW_CONTRACT: "WORKFLOW_CONTRACT",
  ENVIRONMENT_INCOMPATIBLE: "ENVIRONMENT_INCOMPATIBLE",
  TRANSIENT_CONNECTION: "TRANSIENT_CONNECTION",
  SUBMISSION_UNKNOWN: "SUBMISSION_UNKNOWN",
  EXTERNAL_EXECUTION: "EXTERNAL_EXECUTION",
  OUTPUT_COLLECTION: "OUTPUT_COLLECTION",
  ARTIFACT_COMMIT: "ARTIFACT_COMMIT",
  PERMISSION_SECURITY: "PERMISSION_SECURITY",
} as const;
export type ErrorClass = (typeof ErrorClass)[keyof typeof ErrorClass];

/** 术语到正确定义的映射，用于代码审查检查 */
export const TERM_MAP: Record<string, string> = {
  /** 能力：文本、图片、视频、语音等业务能力，不是供应商名字 */
  Capability: "文本、图片、视频、语音等业务能力。不应混用为供应商名字。",
  /** 供应商适配器：实现一种协议的代码，不是具体后端地址 */
  ProviderAdapter: "实现一种协议的代码。不应混用为具体后端地址。",
  /** 执行后端：地址、认证、网络策略和资源池配置 */
  ExecutionBackend: "地址、认证、网络策略和资源池配置。不应混用为工作流或模型。",
  /** 工作流包修订版：不可变工作流、清单、绑定和锁文件 */
  WorkflowPackageRevision: "不可变工作流、清单、绑定和锁文件。不应混用为可随意编辑的模板。",
  /** 生成配置修订版：用户可选的完整生成方案 */
  GenerationProfileRevision: "用户可选的完整生成方案。不应混用为单个权重文件。",
  /** 生成任务：用户期望得到一个工件的逻辑请求 */
  GenerationJob: "用户期望得到一个工件的逻辑请求。不应混用为某次网络调用。",
  /** 执行尝试：一次具体外部执行或收集尝试 */
  GenerationAttempt: "一次具体外部执行或收集尝试。不应混用为逻辑任务全部历史。",
  /** 工件：已校验并归档的不可变媒体文件 */
  Artifact: "已校验并归档的不可变媒体文件。不应混用为外部临时路径。",
  /** 资源池：一组共享显卡或互斥资源 */
  ResourcePool: "一组共享显卡或互斥资源。不应混用为单个工作进程。",
  /** 租约：有期限的持有权 */
  Lease: "有期限的持有权。不应混用为进程内锁。",
  /** 防旧写令牌：单调递增、阻止过期工作器写入的序号 */
  FencingToken: "单调递增、阻止过期工作器写入的序号。不应混用为随机锁编号。",
  /** 执行快照：任务创建时冻结的全部执行输入 */
  ExecutionSnapshot: "任务创建时冻结的全部执行输入。不应混用为实时默认设置。",
};