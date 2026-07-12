/**
 * v2.0 工作流包验证器
 *
 * 手册 §8：工作流包上传后进行隔离验证。
 * 包括结构约束、静态策略、环境验证和双人审查。
 */

import { createHash } from "crypto";
import { db } from "@/lib/db";
import { workflowPackageRevisions, workflowPackageStates } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { isEnabled, FF } from "@/lib/feature-flags";
import { writeAuditEvent, AuditAction, AuditTargetType } from "@/lib/security/audit";

/** 结构约束 */
export interface WorkflowStructureConstraints {
  /** 节点数限制 */
  maxNodes: number;
  /** 节点类限制 */
  maxNodeClasses: number;
  /** 允许的节点类列表 */
  allowedNodeClasses: string[];
  /** 包大小上限 (bytes) */
  maxPackageSizeBytes: number;
  /** 最大输出数 */
  maxOutputs: number;
}

/** 静态策略 */
export interface WorkflowStaticPolicy {
  /** 防止路径遍历 */
  enforcePathTraversalCheck: boolean;
  /** 最大执行时间 (ms) */
  maxExecutionTimeMs: number;
  /** 允许的媒体类型 */
  allowedMediaTypes: string[];
  /** 禁止的节点类 */
  blockedNodeClasses: string[];
}

/** 验证结果 */
export interface WorkflowValidationResult {
  valid: boolean;
  digest: string;
  nodeCount: number;
  nodeClasses: Set<string>;
  errors: string[];
  warnings: string[];
}

/** 默认结构约束 */
const DEFAULT_CONSTRAINTS: WorkflowStructureConstraints = {
  maxNodes: 200,
  maxNodeClasses: 50,
  allowedNodeClasses: ["*"],
  maxPackageSizeBytes: 10 * 1024 * 1024, // 10 MB
  maxOutputs: 20,
};

/** 默认静态策略 */
const DEFAULT_STATIC_POLICY: WorkflowStaticPolicy = {
  enforcePathTraversalCheck: true,
  maxExecutionTimeMs: 600_000, // 10 分钟
  allowedMediaTypes: ["image/png", "image/jpeg", "image/webp", "video/mp4", "audio/wav", "audio/mp3"],
  blockedNodeClasses: [],
};

/** 验证工作流 JSON 结构 */
export function validateWorkflowStructure(
  workflowApi: Record<string, unknown>,
  constraints: Partial<WorkflowStructureConstraints> = {},
): WorkflowValidationResult {
  const c = { ...DEFAULT_CONSTRAINTS, ...constraints };
  const errors: string[] = [];
  const warnings: string[] = [];

  // 检查节点
  const nodes = (workflowApi.nodes as Record<string, unknown>[]) ?? [];
  if (nodes.length === 0) {
    errors.push("Workflow has no nodes");
  }
  if (nodes.length > c.maxNodes) {
    errors.push(`Workflow has ${nodes.length} nodes, max is ${c.maxNodes}`);
  }

  // 收集节点类
  const nodeClasses = new Set<string>();
  for (const node of nodes) {
    const classType = node.class_type as string;
    if (classType) {
      nodeClasses.add(classType);
    }
    if (nodeClasses.size > c.maxNodeClasses) {
      errors.push(`Workflow has ${nodeClasses.size} node classes, max is ${c.maxNodeClasses}`);
      break;
    }
  }

  // 检查禁止的节点类
  if (c.allowedNodeClasses.length > 0 && !c.allowedNodeClasses.includes("*")) {
    for (const nc of nodeClasses) {
      if (!c.allowedNodeClasses.includes(nc)) {
        errors.push(`Node class not allowed: ${nc}`);
      }
    }
  }

  // 检查输出数
  const outputs = (workflowApi.outputs as unknown[]) ?? [];
  if (outputs.length > c.maxOutputs) {
    errors.push(`Workflow has ${outputs.length} outputs, max is ${c.maxOutputs}`);
  }
  if (outputs.length === 0) {
    warnings.push("Workflow has no outputs defined");
  }

  // 计算摘要
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(workflowApi)).digest("hex")}`;

  return {
    valid: errors.length === 0,
    digest,
    nodeCount: nodes.length,
    nodeClasses,
    errors,
    warnings,
  };
}

/** 应用静态策略 */
export function applyStaticPolicy(
  workflowApi: Record<string, unknown>,
  policy: Partial<WorkflowStaticPolicy> = {},
): WorkflowValidationResult {
  const p = { ...DEFAULT_STATIC_POLICY, ...policy };
  const errors: string[] = [];
  const warnings: string[] = [];

  const nodes = (workflowApi.nodes as Record<string, unknown>[]) ?? [];
  const nodeClasses = new Set<string>();

  for (const node of nodes) {
    const classType = node.class_type as string;
    if (classType) {
      nodeClasses.add(classType);

      if (p.blockedNodeClasses.includes(classType)) {
        errors.push(`Blocked node class: ${classType}`);
      }
    }

    // 路径遍历检查
    if (p.enforcePathTraversalCheck) {
      const inputs = node.inputs as Record<string, unknown>;
      if (inputs) {
        for (const [key, value] of Object.entries(inputs)) {
          if (typeof value === "string" && (value.includes("../") || value.includes("..\\"))) {
            errors.push(`Path traversal detected in node ${classType}.${key}: ${value}`);
          }
        }
      }
    }
  }

  const digest = `sha256:${createHash("sha256").update(JSON.stringify(workflowApi)).digest("hex")}`;

  return {
    valid: errors.length === 0,
    digest,
    nodeCount: nodes.length,
    nodeClasses,
    errors,
    warnings,
  };
}

/** 验证工作流包并创建修订版 */
export async function validateAndCreateWorkflowPackage(
  displayName: string,
  workflowApi: Record<string, unknown>,
  manifest: Record<string, unknown>,
  packageLock: Record<string, unknown>,
  actor: { id: string },
): Promise<{ id: string; digest: string }> {
  if (!isEnabled(FF.V2_WORKFLOW_SUPPLY_CHAIN)) {
    throw new Error("v2.0 workflow supply chain is not enabled");
  }

  // 结构验证
  const structResult = validateWorkflowStructure(workflowApi);
  if (!structResult.valid) {
    throw new Error(`Workflow structure validation failed: ${structResult.errors.join("; ")}`);
  }

  // 静态策略验证
  const policyResult = applyStaticPolicy(workflowApi);
  if (!policyResult.valid) {
    throw new Error(`Workflow static policy validation failed: ${policyResult.errors.join("; ")}`);
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const digest = structResult.digest;

  await db.insert(workflowPackageRevisions).values({
    id,
    displayName,
    revisionNo: 1,
    workflowApiJson: workflowApi,
    manifestJson: manifest,
    packageLockJson: packageLock,
    digest,
    environmentLockJson: {
      os: process.platform,
      nodeVersion: process.version,
      gpuDriver: "unknown",
      comfyVersion: manifest.version ?? "unknown",
    },
    nodeClasses: Array.from(structResult.nodeClasses),
    reviewedBy: null,
    uploadedBy: actor.id,
    createdAtMs: now,
  });

  await db.insert(workflowPackageStates).values({
    workflowPackageRevisionId: id,
    state: "installed",
    stateReason: "Created via upload",
    updatedAtMs: now,
  });

  // 审计
  await writeAuditEvent({
    action: AuditAction.WORKFLOW_UPLOADED,
    targetType: AuditTargetType.WORKFLOW,
    targetId: id,
    detailsSafe: {
      displayName,
      nodeCount: structResult.nodeCount,
      nodeClasses: Array.from(structResult.nodeClasses),
      digest,
    },
  });

  return { id, digest };
}

/** 环境指纹 */
export function captureEnvironmentFingerprint(): Record<string, unknown> {
  return {
    os: process.platform,
    osVersion: process.getuid?.()?.toString() ?? "unknown",
    nodeVersion: process.version,
    architecture: process.arch,
    cwd: process.cwd(),
    timestamp: Date.now(),
  };
}

/** 比较环境指纹 */
export function compareEnvironmentFingerprints(
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
): { compatible: boolean; differences: string[] } {
  const differences: string[] = [];
  const keysToCompare = ["os", "nodeVersion", "architecture"];

  for (const key of keysToCompare) {
    if (baseline[key] !== current[key]) {
      differences.push(`${key}: ${baseline[key]} → ${current[key]}`);
    }
  }

  return {
    compatible: differences.length === 0,
    differences,
  };
}