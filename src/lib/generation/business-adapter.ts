/**
 * v2.0 业务适配层
 *
 * 手册 §19：原漫剧兼容与旧配置迁移
 * 将旧漫剧业务入口（角色图、分镜帧等）桥接到 v2 生成系统
 */

import { db } from "@/lib/db";
import {
  characters,
  shots,
  shotAssets,
  generationJobs,
  generationArtifacts,
  generationAttempts,
  businessTaskGenerationJobs,
  generationProfileRevisions,
  defaultGenerationProfilePointers,
} from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { createGenerationJob, getGenerationJob } from "./jobs/service";
import type { CreateGenerationJobInput } from "./contracts";
import { isEnabled, FF } from "@/lib/feature-flags";
import { id as genId } from "@/lib/id";
import { normalizeParameters, type InputParameters } from "./parameter-normalization";
import { processReferenceImages, type ReferenceImageInput } from "./reference-image-processor";
import { chunkText, type ChunkingConfig } from "./audio-chunking";
import { getVoiceProfile } from "./voice-profiles";

/** 业务上下文类型 */
export type BusinessContextKind =
  | "character-image"
  | "shot-frame"
  | "scene-frame"
  | "dialogue-audio";

/** 创建角色图生成任务 */
export async function createCharacterImageJob(
  characterId: string,
  projectId: string,
  userId: string,
  options: {
    prompt?: string;
    negativePrompt?: string;
    width?: number;
    height?: number;
    aspectRatio?: string;
    seed?: string;
    referenceImages?: ReferenceImageInput[];
    profileRevisionId?: string;
  } = {}
): Promise<{ jobId: string; profileRevisionId: string }> {
  if (!isEnabled(FF.V2_LOCAL_IMAGE)) {
    throw new Error("v2.0 local image generation is not enabled");
  }

  // 查询角色信息
  const [character] = await db
    .select()
    .from(characters)
    .where(eq(characters.id, characterId));

  if (!character) {
    throw new Error(`Character not found: ${characterId}`);
  }

  // 解析生成配置
  const profileRevisionId = options.profileRevisionId || await resolveDefaultProfile("image");
  if (!profileRevisionId) {
    throw new Error("No image generation profile configured");
  }

  // 构建提示词
  const prompt = options.prompt || character.visualHint || character.description || "";
  if (!prompt) {
    throw new Error("No prompt available for character image generation");
  }

  // 规范化参数
  const inputParams: InputParameters = {
    prompt,
    negativePrompt: options.negativePrompt,
    width: options.width,
    height: options.height,
    aspectRatio: options.aspectRatio,
    seed: options.seed,
  };

  const normalized = normalizeParameters(inputParams);

  // 创建生成任务
  const input: CreateGenerationJobInput = {
    capability: "image",
    profileRevisionId,
    projectId,
    request: {
      prompt: normalized.prompt,
      negativePrompt: normalized.negativePrompt,
      width: normalized.width,
      height: normalized.height,
      seed: normalized.seed,
    },
    businessContext: {
      kind: "character-image",
      id: characterId,
    },
  };

  const job = await createGenerationJob(input, { userId, roles: ["user"] });

  // 处理参考图（如果有）
  if (options.referenceImages && options.referenceImages.length > 0) {
    const processedRefs = await processReferenceImages(
      options.referenceImages,
      {},
      job.id
    );

    // 将参考图信息附加到任务元数据
    await db
      .update(generationJobs)
      .set({
        metadataJson: {
          ...(job.metadataJson as Record<string, unknown> || {}),
          referenceImages: processedRefs.map(ref => ({
            artifactId: ref.artifactId,
            strength: ref.strength,
            semanticLabel: ref.semanticLabel,
          })),
        },
      })
      .where(eq(generationJobs.id, job.id));
  }

  return { jobId: job.id, profileRevisionId };
}

/** 创建分镜帧生成任务 */
export async function createShotFrameJob(
  shotId: string,
  projectId: string,
  userId: string,
  options: {
    frameType: "start" | "end" | "keyframe";
    prompt?: string;
    negativePrompt?: string;
    width?: number;
    height?: number;
    seed?: string;
  }
): Promise<{ jobId: string; profileRevisionId: string }> {
  if (!isEnabled(FF.V2_LOCAL_IMAGE)) {
    throw new Error("v2.0 local image generation is not enabled");
  }

  // 查询分镜信息
  const [shot] = await db.select().from(shots).where(eq(shots.id, shotId));

  if (!shot) {
    throw new Error(`Shot not found: ${shotId}`);
  }

  // 解析默认生成配置
  const profileRevisionId = await resolveDefaultProfile("image");
  if (!profileRevisionId) {
    throw new Error("No default image generation profile configured");
  }

  // 构建提示词
  let prompt = options.prompt || "";
  if (!prompt) {
    switch (options.frameType) {
      case "start":
        prompt = shot.startFrameDesc || shot.videoPrompt || "";
        break;
      case "end":
        prompt = shot.endFrameDesc || shot.videoPrompt || "";
        break;
      case "keyframe":
        prompt = shot.videoPrompt || "";
        break;
    }
  }

  if (!prompt) {
    throw new Error("No prompt available for shot frame generation");
  }

  // 创建生成任务
  const input: CreateGenerationJobInput = {
    capability: "image",
    profileRevisionId,
    projectId,
    request: {
      prompt,
      negativePrompt: options.negativePrompt || "",
      width: options.width || 1024,
      height: options.height || 1024,
      seed: options.seed,
    },
    businessContext: {
      kind: "shot-frame",
      id: shotId,
    },
  };

  const job = await createGenerationJob(input, { userId, roles: ["user"] });

  return { jobId: job.id, profileRevisionId };
}

/** 创建对话音频生成任务 */
export async function createDialogueAudioJob(
  dialogueId: string,
  projectId: string,
  userId: string,
  options: {
    text?: string;
    voiceProfileId?: string;
    speed?: number;
    chunkingConfig?: Partial<ChunkingConfig>;
  } = {}
): Promise<{ jobId: string; profileRevisionId: string; chunkCount: number }> {
  if (!isEnabled(FF.V2_LOCAL_AUDIO)) {
    throw new Error("v2.0 local audio generation is not enabled");
  }

  // 解析生成配置
  const profileRevisionId = await resolveDefaultProfile("audio");
  if (!profileRevisionId) {
    throw new Error("No default audio generation profile configured");
  }

  // 验证音色档案（如果提供）
  if (options.voiceProfileId) {
    const voiceProfile = await getVoiceProfile(options.voiceProfileId);
    if (!voiceProfile) {
      throw new Error(`Voice profile not found: ${options.voiceProfileId}`);
    }
  }

  // 构建文本
  const text = options.text || "";
  if (!text) {
    throw new Error("No text provided for dialogue audio generation");
  }

  // 文本分块
  const chunkingResult = chunkText(text, options.chunkingConfig);

  // 创建生成任务（使用第一个块作为主任务）
  const input: CreateGenerationJobInput = {
    capability: "audio",
    profileRevisionId,
    projectId,
    request: {
      text: chunkingResult.chunks[0]?.text || text,
      voiceProfileId: options.voiceProfileId,
      speed: options.speed || 1.0,
    },
    businessContext: {
      kind: "dialogue-audio",
      id: dialogueId,
    },
  };

  const job = await createGenerationJob(input, { userId, roles: ["user"] });

  // 将分块信息附加到任务元数据
  if (chunkingResult.chunkCount > 1) {
    await db
      .update(generationJobs)
      .set({
        metadataJson: {
          ...(job.metadataJson as Record<string, unknown> || {}),
          audioChunks: {
            totalChunks: chunkingResult.chunkCount,
            chunks: chunkingResult.chunks.map(chunk => ({
              index: chunk.index,
              text: chunk.text,
              estimatedDuration: chunk.estimatedDuration,
            })),
            totalEstimatedDuration: chunkingResult.totalEstimatedDuration,
          },
        },
      })
      .where(eq(generationJobs.id, job.id));
  }

  return { 
    jobId: job.id, 
    profileRevisionId,
    chunkCount: chunkingResult.chunkCount,
  };
}

/** 查询业务任务关联的生成任务 */
export async function getBusinessTaskJobs(
  businessTaskId: string,
  kind: BusinessContextKind
): Promise<Array<{ jobId: string; status: string; artifactId?: string }>> {
  const rows = await db
    .select({
      jobId: businessTaskGenerationJobs.generationJobId,
      status: generationJobs.status,
      artifactId: generationJobs.currentArtifactId,
    })
    .from(businessTaskGenerationJobs)
    .innerJoin(
      generationJobs,
      eq(businessTaskGenerationJobs.generationJobId, generationJobs.id)
    )
    .where(
      and(
        eq(businessTaskGenerationJobs.businessTaskId, businessTaskId),
        eq(businessTaskGenerationJobs.relationKind, kind)
      )
    )
    .orderBy(desc(businessTaskGenerationJobs.createdAtMs));

  return rows.map((r) => ({
    jobId: r.jobId,
    status: r.status,
    artifactId: r.artifactId || undefined,
  }));
}

/** 将工件链接到业务实体 */
export async function linkArtifactToBusinessEntity(
  jobId: string,
  artifactId: string
): Promise<void> {
  // 查询任务的业务上下文
  const [job] = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.id, jobId));

  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  // 查询业务关联
  const [businessLink] = await db
    .select()
    .from(businessTaskGenerationJobs)
    .where(eq(businessTaskGenerationJobs.generationJobId, jobId));

  if (!businessLink) {
    return; // 没有业务上下文，跳过
  }

  const kind = businessLink.relationKind;
  const entityId = businessLink.businessTaskId;

  // 根据业务类型链接工件
  switch (kind) {
    case "character-image": {
      // 更新角色的参考图
      const [artifact] = await db
        .select()
        .from(generationArtifacts)
        .where(eq(generationArtifacts.id, artifactId));

      if (artifact) {
        // 构建存储路径（相对于项目上传目录）
        const imagePath = `/projects/${job.projectId}/characters/${entityId}/${artifactId}.png`;

        // 更新角色参考图
        await db
          .update(characters)
          .set({
            referenceImage: imagePath,
            referenceImageHistory: JSON.stringify([imagePath]),
          })
          .where(eq(characters.id, entityId));
      }
      break;
    }

    case "shot-frame": {
      // 创建分镜资产记录
      const [artifact] = await db
        .select()
        .from(generationArtifacts)
        .where(eq(generationArtifacts.id, artifactId));

      if (artifact) {
        const assetId = genId();
        const imagePath = `/projects/${job.projectId}/shots/${entityId}/${assetId}.png`;

        // 插入资产版本
        await db.insert(shotAssets).values({
          id: assetId,
          shotId: entityId,
          assetType: "keyframe",
          assetPath: imagePath,
          version: 1,
          isActive: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      break;
    }

    default:
      console.warn(`Unknown business context kind: ${kind}`);
  }
}

/** 解析默认生成配置 */
async function resolveDefaultProfile(
  capability: "image" | "video" | "text"
): Promise<string | null> {
  // 查询全局默认配置
  const [pointer] = await db
    .select()
    .from(defaultGenerationProfilePointers)
    .where(
      and(
        eq(defaultGenerationProfilePointers.scopeType, "global"),
        eq(defaultGenerationProfilePointers.scopeId, "default"),
        eq(defaultGenerationProfilePointers.capability, capability)
      )
    );

  if (pointer) {
    return pointer.generationProfileRevisionId;
  }

  // 回退：查询任何已启用的配置
  const [profile] = await db
    .select({ id: generationProfileRevisions.id })
    .from(generationProfileRevisions)
    .where(eq(generationProfileRevisions.capability, capability))
    .limit(1);

  return profile?.id || null;
}

/** 获取任务的工件下载 URL */
export async function getJobArtifactUrl(
  jobId: string
): Promise<string | null> {
  const [job] = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.id, jobId));

  if (!job || !job.currentArtifactId) {
    return null;
  }

  // 返回 API 路由路径
  return `/api/generation/artifacts/${job.currentArtifactId}`;
}
