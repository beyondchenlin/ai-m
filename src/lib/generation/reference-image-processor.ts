/**
 * 参考图处理模块
 *
 * 手册 §18.3：工作流能力
 * - 是否支持参考图
 * - 参考图数量
 * - 参考图语义
 *
 * 本模块负责：
 * - 参考图上传和校验
 * - 参考图注入工作流
 * - 参考图语义处理
 */

import { promises as fs } from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { db } from "@/lib/db";
import { generationArtifacts } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/** 参考图配置 */
export interface ReferenceImageConfig {
  /** 最大参考图数量 */
  maxReferenceImages: number;
  /** 允许的文件类型 */
  allowedMimeTypes: string[];
  /** 最大文件大小（字节） */
  maxFileSizeBytes: number;
  /** 参考图强度默认值 */
  defaultStrength: number;
  /** 参考图强度范围 */
  strengthRange: { min: number; max: number };
}

/** 默认参考图配置 */
const DEFAULT_REFERENCE_CONFIG: ReferenceImageConfig = {
  maxReferenceImages: 3,
  allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
  maxFileSizeBytes: 10 * 1024 * 1024, // 10MB
  defaultStrength: 0.7,
  strengthRange: { min: 0.0, max: 1.0 },
};

/** 参考图输入 */
export interface ReferenceImageInput {
  /** 参考图文件路径或 URL */
  source: string;
  /** 参考图强度 */
  strength?: number;
  /** 参考图语义标签 */
  semanticLabel?: string;
}

/** 处理后的参考图 */
export interface ProcessedReferenceImage {
  /** 工件 ID */
  artifactId: string;
  /** 文件路径 */
  filePath: string;
  /** SHA256 摘要 */
  sha256: string;
  /** 文件大小 */
  sizeBytes: number;
  /** MIME 类型 */
  mimeType: string;
  /** 参考图强度 */
  strength: number;
  /** 语义标签 */
  semanticLabel?: string;
}

/**
 * 校验参考图文件
 */
async function validateReferenceImage(
  filePath: string,
  config: ReferenceImageConfig
): Promise<{ valid: boolean; error?: string }> {
  try {
    const stats = await fs.stat(filePath);

    // 检查文件大小
    if (stats.size > config.maxFileSizeBytes) {
      return {
        valid: false,
        error: `File size ${stats.size} exceeds limit ${config.maxFileSizeBytes}`,
      };
    }

    // 检查文件是否存在
    if (!stats.isFile()) {
      return { valid: false, error: "Path is not a file" };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, error: `File not found: ${filePath}` };
  }
}

/**
 * 计算文件 SHA256
 */
async function calculateFileSha256(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * 推断 MIME 类型
 */
function inferMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };
  return mimeMap[ext] || "application/octet-stream";
}

/**
 * 处理单个参考图
 */
async function processSingleReferenceImage(
  input: ReferenceImageInput,
  config: ReferenceImageConfig,
  attemptId: string
): Promise<ProcessedReferenceImage> {
  // 1. 校验文件
  const validation = await validateReferenceImage(input.source, config);
  if (!validation.valid) {
    throw new Error(`Reference image validation failed: ${validation.error}`);
  }

  // 2. 计算文件摘要
  const sha256 = await calculateFileSha256(input.source);

  // 3. 获取文件信息
  const stats = await fs.stat(input.source);
  const mimeType = inferMimeType(input.source);

  // 4. 检查 MIME 类型
  if (!config.allowedMimeTypes.includes(mimeType)) {
    throw new Error(
      `MIME type ${mimeType} not allowed. Allowed: ${config.allowedMimeTypes.join(", ")}`
    );
  }

  // 5. 规范化强度
  const strength = Math.max(
    config.strengthRange.min,
    Math.min(
      config.strengthRange.max,
      input.strength ?? config.defaultStrength
    )
  );

  // 6. 复制文件到工件目录
  const artifactId = `ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const artifactDir = path.resolve(process.cwd(), "data", "artifacts");
  await fs.mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, artifactId);
  await fs.copyFile(input.source, artifactPath);

  // 7. 写入数据库记录
  const now = Date.now();
  await db.insert(generationArtifacts).values({
    id: artifactId,
    attemptId,
    kind: "reference_image",
    storageKey: artifactPath,
    mimeType,
    sizeBytes: stats.size,
    sha256,
    status: "COMMITTED",
    visibility: "private-original",
    width: null,
    height: null,
    parentArtifactId: null,
    createdAtMs: now,
  });

  return {
    artifactId,
    filePath: artifactPath,
    sha256,
    sizeBytes: stats.size,
    mimeType,
    strength,
    semanticLabel: input.semanticLabel,
  };
}

/**
 * 处理多个参考图
 */
export async function processReferenceImages(
  inputs: ReferenceImageInput[],
  config: Partial<ReferenceImageConfig> = {},
  attemptId: string
): Promise<ProcessedReferenceImage[]> {
  const cfg = { ...DEFAULT_REFERENCE_CONFIG, ...config };

  // 1. 检查数量限制
  if (inputs.length > cfg.maxReferenceImages) {
    throw new Error(
      `Too many reference images: ${inputs.length} > ${cfg.maxReferenceImages}`
    );
  }

  // 2. 处理每个参考图
  const processed: ProcessedReferenceImage[] = [];
  for (const input of inputs) {
    const result = await processSingleReferenceImage(input, cfg, attemptId);
    processed.push(result);
  }

  return processed;
}

/**
 * 将参考图注入工作流
 *
 * 手册 §18.3：参考图语义
 * - 参考图通过特定节点注入
 * - 参考图强度控制影响程度
 */
export function injectReferenceImagesIntoWorkflow(
  workflow: Record<string, unknown>,
  references: ProcessedReferenceImage[]
): Record<string, unknown> {
  if (references.length === 0) {
    return workflow;
  }

  // 深拷贝工作流
  const updated = JSON.parse(JSON.stringify(workflow)) as Record<string, unknown>;

  // 查找需要注入参考图的节点
  const nodes = updated.nodes as Record<string, Record<string, unknown>> | undefined;
  if (!nodes) {
    return workflow;
  }

  // 准备参考图数据
  const referenceData = references.map((ref) => ({
    artifact_id: ref.artifactId,
    file_path: ref.filePath,
    strength: ref.strength,
    semantic_label: ref.semanticLabel || "general",
  }));

  // 注入到所有支持参考图的节点
  for (const [nodeId, node] of Object.entries(nodes)) {
    const inputs = node.inputs as Record<string, unknown> | undefined;
    if (!inputs) continue;

    // 检查节点是否支持参考图
    if (inputs.reference_images !== undefined) {
      inputs.reference_images = JSON.stringify(referenceData);
    }

    // 如果有参考图强度字段，使用第一个参考图的强度
    if (inputs.reference_strength !== undefined && references.length > 0) {
      inputs.reference_strength = references[0].strength;
    }
  }

  return updated;
}

/**
 * 验证参考图配置
 */
export function validateReferenceConfig(
  config: Partial<ReferenceImageConfig>
): { valid: boolean; errors: string[] } {
  const cfg = { ...DEFAULT_REFERENCE_CONFIG, ...config };
  const errors: string[] = [];

  if (cfg.maxReferenceImages < 0) {
    errors.push("maxReferenceImages must be >= 0");
  }

  if (cfg.maxFileSizeBytes <= 0) {
    errors.push("maxFileSizeBytes must be > 0");
  }

  if (cfg.strengthRange.min >= cfg.strengthRange.max) {
    errors.push("strengthRange.min must be < strengthRange.max");
  }

  if (cfg.defaultStrength < cfg.strengthRange.min || cfg.defaultStrength > cfg.strengthRange.max) {
    errors.push(`defaultStrength ${cfg.defaultStrength} out of range [${cfg.strengthRange.min}, ${cfg.strengthRange.max}]`);
  }

  if (cfg.allowedMimeTypes.length === 0) {
    errors.push("allowedMimeTypes cannot be empty");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
