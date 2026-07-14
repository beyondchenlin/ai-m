/**
 * 视觉主体管理模块
 * 
 * 手册 §28.2：视觉主体
 * - 身份锚点（identity anchors）：核心视觉特征
 * - 可变槽位（variable slots）：可调整的属性
 * - 禁止特征（forbidden features）：不允许出现的特征
 * - 多角度参考包（multi-angle reference packs）：多个角度的参考图
 * - 不可变版本（immutable versions）：版本快照
 */

import { db } from "@/lib/db";
import { visualSubjects, visualSubjectVersions, characters } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { id as genId } from "@/lib/id";

/** Decode Drizzle JSON values and the accidentally double-encoded legacy rows. */
function decodeJsonArray<T>(value: unknown, field: string): T[] {
  let decoded = value;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded) as unknown;
    } catch {
      throw new Error(`Invalid legacy JSON in ${field}`);
    }
  }
  if (!Array.isArray(decoded)) {
    throw new Error(`Expected an array in ${field}`);
  }
  return decoded as T[];
}

/** 视觉主体类型 */
export type VisualSubjectType = 
  | "human"           // 人类
  | "animal"          // 动物
  | "cartoon"         // 卡通
  | "mascot"          // 吉祥物
  | "robot"           // 机器人
  | "fantasy";        // 幻想生物

/** 身份锚点（核心视觉特征） */
export interface IdentityAnchor {
  /** 锚点 ID */
  id: string;
  /** 锚点名称（如：脸部特征、体型特征） */
  name: string;
  /** 锚点描述 */
  description: string;
  /** 参考图工件 ID 列表 */
  referenceArtifactIds: string[];
  /** 权重（0-1） */
  weight: number;
  /** 是否必需 */
  required: boolean;
}

/** 可变槽位（可调整的属性） */
export interface VariableSlot {
  /** 槽位 ID */
  id: string;
  /** 槽位名称（如：服装、表情、姿势） */
  name: string;
  /** 槽位类型 */
  type: "clothing" | "expression" | "pose" | "accessory" | "background" | "custom";
  /** 默认值 */
  defaultValue: string;
  /** 可选值列表 */
  options: string[];
  /** 当前值 */
  currentValue: string;
}

/** 禁止特征 */
export interface ForbiddenFeature {
  /** 特征 ID */
  id: string;
  /** 特征描述（如：不能戴眼镜、不能有胡子） */
  description: string;
  /** 严重程度：high/medium/low */
  severity: "high" | "medium" | "low";
  /** 是否启用 */
  enabled: boolean;
}

/** 多角度参考图 */
export interface MultiAngleReference {
  /** 参考图 ID */
  id: string;
  /** 角度（front/side/back/top/bottom/45-degree） */
  angle: "front" | "side" | "back" | "top" | "bottom" | "45-degree";
  /** 工件 ID */
  artifactId: string;
  /** 文件路径 */
  filePath: string;
  /** 是否为主要参考 */
  isPrimary: boolean;
}

/** 视觉主体输入 */
export interface VisualSubjectInput {
  /** 主体名称 */
  name: string;
  /** 主体类型 */
  type: VisualSubjectType;
  /** 主体描述 */
  description: string;
  /** 项目 ID */
  projectId: string;
  /** 用户 ID */
  userId: string;
  /** 关联的角色 ID（可选，用于从漫剧角色导入） */
  characterId?: string;
  /** 身份锚点列表 */
  identityAnchors?: Omit<IdentityAnchor, "id">[];
  /** 可变槽位列表 */
  variableSlots?: Omit<VariableSlot, "id">[];
  /** 禁止特征列表 */
  forbiddenFeatures?: Omit<ForbiddenFeature, "id">[];
  /** 多角度参考图列表 */
  multiAngleReferences?: Omit<MultiAngleReference, "id">[];
}

/** 处理后的视觉主体 */
export interface ProcessedVisualSubject {
  /** 主体 ID */
  id: string;
  /** 主体名称 */
  name: string;
  /** 主体类型 */
  type: VisualSubjectType;
  /** 主体描述 */
  description: string;
  /** 项目 ID */
  projectId: string;
  /** 用户 ID */
  userId: string;
  /** 关联的角色 ID */
  characterId: string | null;
  /** 身份锚点列表 */
  identityAnchors: IdentityAnchor[];
  /** 可变槽位列表 */
  variableSlots: VariableSlot[];
  /** 禁止特征列表 */
  forbiddenFeatures: ForbiddenFeature[];
  /** 多角度参考图列表 */
  multiAngleReferences: MultiAngleReference[];
  /** 当前版本号 */
  currentVersion: number;
  /** 创建时间 */
  createdAt: Date;
  /** 更新时间 */
  updatedAt: Date;
}

/** 创建视觉主体 */
export async function createVisualSubject(
  input: VisualSubjectInput
): Promise<ProcessedVisualSubject> {
  const now = new Date();
  const subjectId = genId();

  // 处理身份锚点
  const identityAnchors: IdentityAnchor[] = (input.identityAnchors || []).map((anchor) => ({
    id: genId(),
    ...anchor,
  }));

  // 处理可变槽位
  const variableSlots: VariableSlot[] = (input.variableSlots || []).map((slot) => ({
    id: genId(),
    ...slot,
  }));

  // 处理禁止特征
  const forbiddenFeatures: ForbiddenFeature[] = (input.forbiddenFeatures || []).map((feature) => ({
    id: genId(),
    ...feature,
  }));

  // 处理多角度参考图
  const multiAngleReferences: MultiAngleReference[] = (input.multiAngleReferences || []).map(
    (ref) => ({
      id: genId(),
      ...ref,
    })
  );

  // 写入数据库
  await db.insert(visualSubjects).values({
    id: subjectId,
    name: input.name,
    type: input.type,
    description: input.description,
    projectId: input.projectId,
    userId: input.userId,
    characterId: input.characterId || null,
    identityAnchorsJson: identityAnchors,
    variableSlotsJson: variableSlots,
    forbiddenFeaturesJson: forbiddenFeatures,
    multiAngleReferencesJson: multiAngleReferences,
    currentVersion: 1,
    createdAt: now,
    updatedAt: now,
  });

  // 创建初始版本快照
  await db.insert(visualSubjectVersions).values({
    id: genId(),
    visualSubjectId: subjectId,
    version: 1,
    snapshotJson: {
      name: input.name,
      type: input.type,
      description: input.description,
      identityAnchors,
      variableSlots,
      forbiddenFeatures,
      multiAngleReferences,
    },
    createdBy: input.userId,
    createdAt: now,
  });

  return {
    id: subjectId,
    name: input.name,
    type: input.type,
    description: input.description,
    projectId: input.projectId,
    userId: input.userId,
    characterId: input.characterId || null,
    identityAnchors,
    variableSlots,
    forbiddenFeatures,
    multiAngleReferences,
    currentVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/** 查询视觉主体 */
export async function getVisualSubject(
  subjectId: string
): Promise<ProcessedVisualSubject | null> {
  const [subject] = await db
    .select()
    .from(visualSubjects)
    .where(eq(visualSubjects.id, subjectId))
    .limit(1);

  if (!subject) {
    return null;
  }

  return {
    id: subject.id,
    name: subject.name,
    type: subject.type as VisualSubjectType,
    description: subject.description,
    projectId: subject.projectId,
    userId: subject.userId,
    characterId: subject.characterId,
    identityAnchors: decodeJsonArray<IdentityAnchor>(subject.identityAnchorsJson, "identity_anchors_json"),
    variableSlots: decodeJsonArray<VariableSlot>(subject.variableSlotsJson, "variable_slots_json"),
    forbiddenFeatures: decodeJsonArray<ForbiddenFeature>(subject.forbiddenFeaturesJson, "forbidden_features_json"),
    multiAngleReferences: decodeJsonArray<MultiAngleReference>(subject.multiAngleReferencesJson, "multi_angle_references_json"),
    currentVersion: subject.currentVersion,
    createdAt: subject.createdAt,
    updatedAt: subject.updatedAt,
  };
}

/** 更新视觉主体（创建新版本） */
export async function updateVisualSubject(
  subjectId: string,
  updates: Partial<VisualSubjectInput>,
  userId: string
): Promise<ProcessedVisualSubject | null> {
  const existing = await getVisualSubject(subjectId);
  if (!existing) {
    return null;
  }

  const now = new Date();
  const newVersion = existing.currentVersion + 1;

  // 合并更新
  const identityAnchors = updates.identityAnchors
    ? updates.identityAnchors.map((a) => ({ id: genId(), ...a }))
    : existing.identityAnchors;

  const variableSlots = updates.variableSlots
    ? updates.variableSlots.map((s) => ({ id: genId(), ...s }))
    : existing.variableSlots;

  const forbiddenFeatures = updates.forbiddenFeatures
    ? updates.forbiddenFeatures.map((f) => ({ id: genId(), ...f }))
    : existing.forbiddenFeatures;

  const multiAngleReferences = updates.multiAngleReferences
    ? updates.multiAngleReferences.map((r) => ({ id: genId(), ...r }))
    : existing.multiAngleReferences;

  // 更新主表
  await db
    .update(visualSubjects)
    .set({
      name: updates.name || existing.name,
      type: updates.type || existing.type,
      description: updates.description || existing.description,
      identityAnchorsJson: identityAnchors,
      variableSlotsJson: variableSlots,
      forbiddenFeaturesJson: forbiddenFeatures,
      multiAngleReferencesJson: multiAngleReferences,
      currentVersion: newVersion,
      updatedAt: now,
    })
    .where(eq(visualSubjects.id, subjectId));

  // 创建新版本快照
  await db.insert(visualSubjectVersions).values({
    id: genId(),
    visualSubjectId: subjectId,
    version: newVersion,
    snapshotJson: {
      name: updates.name || existing.name,
      type: updates.type || existing.type,
      description: updates.description || existing.description,
      identityAnchors,
      variableSlots,
      forbiddenFeatures,
      multiAngleReferences,
    },
    createdBy: userId,
    createdAt: now,
  });

  return {
    ...existing,
    name: updates.name || existing.name,
    type: updates.type || existing.type,
    description: updates.description || existing.description,
    identityAnchors,
    variableSlots,
    forbiddenFeatures,
    multiAngleReferences,
    currentVersion: newVersion,
    updatedAt: now,
  };
}

/** 查询项目的视觉主体列表 */
export async function listVisualSubjects(
  projectId: string
): Promise<ProcessedVisualSubject[]> {
  const subjects = await db
    .select()
    .from(visualSubjects)
    .where(eq(visualSubjects.projectId, projectId));

  return subjects.map((subject) => ({
    id: subject.id,
    name: subject.name,
    type: subject.type as VisualSubjectType,
    description: subject.description,
    projectId: subject.projectId,
    userId: subject.userId,
    characterId: subject.characterId,
    identityAnchors: decodeJsonArray<IdentityAnchor>(subject.identityAnchorsJson, "identity_anchors_json"),
    variableSlots: decodeJsonArray<VariableSlot>(subject.variableSlotsJson, "variable_slots_json"),
    forbiddenFeatures: decodeJsonArray<ForbiddenFeature>(subject.forbiddenFeaturesJson, "forbidden_features_json"),
    multiAngleReferences: decodeJsonArray<MultiAngleReference>(subject.multiAngleReferencesJson, "multi_angle_references_json"),
    currentVersion: subject.currentVersion,
    createdAt: subject.createdAt,
    updatedAt: subject.updatedAt,
  }));
}

/** 从漫剧角色导入视觉主体（手册 §28.2：原漫剧角色通过快照导入，不双向自动同步） */
export async function importFromCharacter(
  characterId: string,
  projectId: string,
  userId: string
): Promise<ProcessedVisualSubject> {
  // 从 characters 表读取真实角色数据
  const [character] = await db
    .select()
    .from(characters)
    .where(eq(characters.id, characterId))
    .limit(1);

  if (!character) {
    throw new Error(`Character not found: ${characterId}`);
  }

  // 从角色字段构建身份锚点
  const identityAnchors: Omit<IdentityAnchor, "id">[] = [];

  // 脸部特征（来自 visualHint 或 description）
  if (character.visualHint || character.description) {
    identityAnchors.push({
      name: "脸部与外观特征",
      description: character.visualHint || character.description || "",
      referenceArtifactIds: character.referenceImage ? [character.referenceImage] : [],
      weight: 1.0,
      required: true,
    });
  }

  // 体型特征（来自 heightCm 和 bodyType）
  if (character.heightCm || character.bodyType) {
    const bodyDesc = [
      character.heightCm ? `${character.heightCm}cm` : null,
      character.bodyType ? `体型: ${character.bodyType}` : null,
    ].filter(Boolean).join("，");
    identityAnchors.push({
      name: "体型特征",
      description: bodyDesc,
      referenceArtifactIds: [],
      weight: 0.8,
      required: true,
    });
  }

  // 如果没有提取到任何锚点，至少保留角色名作为描述
  if (identityAnchors.length === 0) {
    identityAnchors.push({
      name: "整体外观",
      description: character.name,
      referenceArtifactIds: character.referenceImage ? [character.referenceImage] : [],
      weight: 1.0,
      required: true,
    });
  }

  // 从角色参考图历史构建多角度参考
  const multiAngleReferences: Omit<MultiAngleReference, "id">[] = [];
  if (character.referenceImage) {
    multiAngleReferences.push({
      angle: "front",
      artifactId: character.referenceImage,
      filePath: character.referenceImage,
      isPrimary: true,
    });
  }

  // 解析历史参考图
  try {
    const history: string[] = JSON.parse(character.referenceImageHistory || "[]");
    for (let i = 0; i < history.length; i++) {
      multiAngleReferences.push({
        angle: i === 0 ? "side" : i === 1 ? "back" : "45-degree",
        artifactId: history[i],
        filePath: history[i],
        isPrimary: false,
      });
    }
  } catch {
    // 历史解析失败，忽略
  }

  return createVisualSubject({
    name: character.name,
    type: "human",
    description: character.description || `从漫剧角色「${character.name}」导入`,
    projectId,
    userId,
    characterId,
    identityAnchors,
    variableSlots: [],
    forbiddenFeatures: [],
    multiAngleReferences,
  });
}

/** 生成视觉主体的负面提示词 */
export function generateNegativePrompt(subject: ProcessedVisualSubject): string {
  const enabledForbidden = subject.forbiddenFeatures.filter((f) => f.enabled);
  if (enabledForbidden.length === 0) {
    return "";
  }

  return enabledForbidden.map((f) => f.description).join(", ");
}

/** 生成视觉主体的参考图配置（用于工作流注入） */
export function generateReferenceConfig(
  subject: ProcessedVisualSubject
): {
  primaryReferenceId: string | null;
  allReferenceIds: string[];
  anchorWeights: Record<string, number>;
} {
  const primaryRef = subject.multiAngleReferences.find((r) => r.isPrimary);
  const allRefIds = subject.multiAngleReferences.map((r) => r.artifactId);
  const anchorWeights: Record<string, number> = {};

  for (const anchor of subject.identityAnchors) {
    anchorWeights[anchor.id] = anchor.weight;
  }

  return {
    primaryReferenceId: primaryRef?.artifactId || null,
    allReferenceIds: allRefIds,
    anchorWeights,
  };
}
