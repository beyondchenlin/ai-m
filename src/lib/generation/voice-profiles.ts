/**
 * 音色档案管理模块
 * 
 * 负责音色样本的上传、存储、查询和验证
 */

import { db } from "@/lib/db";
import { voiceProfiles } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { promises as fs } from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { genId } from "@/lib/utils/id";

/** 音色档案配置 */
export interface VoiceProfileConfig {
  /** 最大文件大小（字节） */
  maxFileSizeBytes: number;
  /** 允许的音频格式 */
  allowedMimeTypes: string[];
  /** 最小时长（秒） */
  minDurationSeconds: number;
  /** 最大时长（秒） */
  maxDurationSeconds: number;
  /** 允许的采样率 */
  allowedSampleRates: number[];
}

/** 默认音色档案配置 */
const DEFAULT_VOICE_CONFIG: VoiceProfileConfig = {
  maxFileSizeBytes: 50 * 1024 * 1024, // 50MB
  allowedMimeTypes: ["audio/wav", "audio/mp3", "audio/mpeg", "audio/ogg"],
  minDurationSeconds: 3,
  maxDurationSeconds: 60,
  allowedSampleRates: [16000, 22050, 44100],
};

/** 音色档案输入 */
export interface VoiceProfileInput {
  /** 档案名称 */
  name: string;
  /** 档案描述 */
  description?: string;
  /** 音频文件路径 */
  audioFilePath: string;
  /** 用户 ID */
  userId: string;
  /** 语言代码 */
  language?: string;
}

/** 处理后的音色档案 */
export interface ProcessedVoiceProfile {
  /** 档案 ID */
  id: string;
  /** 档案名称 */
  name: string;
  /** 档案描述 */
  description: string | null;
  /** 存储路径 */
  storagePath: string;
  /** SHA256 摘要 */
  sha256: string;
  /** 文件大小 */
  sizeBytes: number;
  /** MIME 类型 */
  mimeType: string;
  /** 时长（秒） */
  durationSeconds: number;
  /** 采样率 */
  sampleRate: number;
  /** 语言代码 */
  language: string | null;
  /** 用户 ID */
  userId: string;
  /** 创建时间 */
  createdAt: Date;
}

/**
 * 校验音色档案文件
 */
async function validateVoiceProfileFile(
  filePath: string,
  config: VoiceProfileConfig
): Promise<{ valid: boolean; error?: string }> {
  try {
    const stats = await fs.stat(filePath);

    // 检查文件大小
    if (stats.size > config.maxFileSizeBytes) {
      return {
        valid: false,
        error: `文件大小 ${stats.size} 超过限制 ${config.maxFileSizeBytes}`,
      };
    }

    // 检查文件是否存在
    if (!stats.isFile()) {
      return { valid: false, error: "路径不是文件" };
    }

    // 检查文件扩展名
    const ext = path.extname(filePath).toLowerCase();
    const allowedExts = [".wav", ".mp3", ".ogg"];
    if (!allowedExts.includes(ext)) {
      return {
        valid: false,
        error: `不支持的文件格式: ${ext}，支持: ${allowedExts.join(", ")}`,
      };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, error: `文件不存在: ${filePath}` };
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
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
  };
  return mimeMap[ext] || "application/octet-stream";
}

/**
 * 估算音频时长（简化版本）
 * 实际生产环境应该使用 ffprobe 或类似工具
 */
async function estimateAudioDuration(
  filePath: string,
  mimeType: string
): Promise<number> {
  // 简化估算：基于文件大小和比特率
  const stats = await fs.stat(filePath);
  
  // 假设比特率
  let bitrate = 128000; // 128 kbps
  if (mimeType === "audio/wav") {
    bitrate = 1411200; // 16-bit, 44.1kHz, stereo
  } else if (mimeType === "audio/mpeg") {
    bitrate = 128000; // 128 kbps
  }
  
  // 估算时长（秒）
  const durationSeconds = (stats.size * 8) / bitrate;
  return Math.round(durationSeconds * 10) / 10; // 保留一位小数
}

/**
 * 处理音色档案
 */
export async function processVoiceProfile(
  input: VoiceProfileInput,
  config: Partial<VoiceProfileConfig> = {}
): Promise<ProcessedVoiceProfile> {
  const cfg = { ...DEFAULT_VOICE_CONFIG, ...config };

  // 1. 校验文件
  const validation = await validateVoiceProfileFile(input.audioFilePath, cfg);
  if (!validation.valid) {
    throw new Error(`音色档案校验失败: ${validation.error}`);
  }

  // 2. 计算文件摘要
  const sha256 = await calculateFileSha256(input.audioFilePath);

  // 3. 获取文件信息
  const stats = await fs.stat(input.audioFilePath);
  const mimeType = inferMimeType(input.audioFilePath);

  // 4. 检查 MIME 类型
  if (!cfg.allowedMimeTypes.includes(mimeType)) {
    throw new Error(
      `不支持的音频格式: ${mimeType}，支持: ${cfg.allowedMimeTypes.join(", ")}`
    );
  }

  // 5. 估算时长
  const durationSeconds = await estimateAudioDuration(input.audioFilePath, mimeType);

  // 6. 检查时长限制
  if (durationSeconds < cfg.minDurationSeconds) {
    throw new Error(
      `音频时长 ${durationSeconds}秒 小于最小限制 ${cfg.minDurationSeconds}秒`
    );
  }

  if (durationSeconds > cfg.maxDurationSeconds) {
    throw new Error(
      `音频时长 ${durationSeconds}秒 超过最大限制 ${cfg.maxDurationSeconds}秒`
    );
  }

  // 7. 复制文件到音色档案目录
  const profileId = genId();
  const voiceProfileDir = path.resolve(process.cwd(), "data", "voice-profiles");
  await fs.mkdir(voiceProfileDir, { recursive: true });
  const ext = path.extname(input.audioFilePath);
  const storagePath = path.join(voiceProfileDir, `${profileId}${ext}`);
  await fs.copyFile(input.audioFilePath, storagePath);

  // 8. 写入数据库记录
  const now = new Date();
  await db.insert(voiceProfiles).values({
    id: profileId,
    name: input.name,
    description: input.description || null,
    storagePath,
    sha256,
    sizeBytes: stats.size,
    mimeType,
    durationSeconds,
    sampleRate: 22050, // 默认采样率
    language: input.language || null,
    userId: input.userId,
    createdAt: now,
    updatedAt: now,
  });

  return {
    id: profileId,
    name: input.name,
    description: input.description || null,
    storagePath,
    sha256,
    sizeBytes: stats.size,
    mimeType,
    durationSeconds,
    sampleRate: 22050,
    language: input.language || null,
    userId: input.userId,
    createdAt: now,
  };
}

/**
 * 查询音色档案
 */
export async function getVoiceProfile(
  profileId: string
): Promise<ProcessedVoiceProfile | null> {
  const [profile] = await db
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.id, profileId))
    .limit(1);

  if (!profile) {
    return null;
  }

  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    storagePath: profile.storagePath,
    sha256: profile.sha256,
    sizeBytes: profile.sizeBytes,
    mimeType: profile.mimeType,
    durationSeconds: profile.durationSeconds,
    sampleRate: profile.sampleRate,
    language: profile.language,
    userId: profile.userId,
    createdAt: profile.createdAt,
  };
}

/**
 * 查询用户的所有音色档案
 */
export async function listVoiceProfiles(
  userId: string
): Promise<ProcessedVoiceProfile[]> {
  const profiles = await db
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.userId, userId));

  return profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    description: profile.description,
    storagePath: profile.storagePath,
    sha256: profile.sha256,
    sizeBytes: profile.sizeBytes,
    mimeType: profile.mimeType,
    durationSeconds: profile.durationSeconds,
    sampleRate: profile.sampleRate,
    language: profile.language,
    userId: profile.userId,
    createdAt: profile.createdAt,
  }));
}

/**
 * 删除音色档案
 */
export async function deleteVoiceProfile(profileId: string): Promise<void> {
  const profile = await getVoiceProfile(profileId);
  if (!profile) {
    throw new Error(`音色档案不存在: ${profileId}`);
  }

  // 删除文件
  try {
    await fs.unlink(profile.storagePath);
  } catch (err) {
    console.warn(`删除音色文件失败: ${profile.storagePath}`, err);
  }

  // 删除数据库记录
  await db.delete(voiceProfiles).where(eq(voiceProfiles.id, profileId));
}

/**
 * 验证音色档案配置
 */
export function validateVoiceConfig(
  config: Partial<VoiceProfileConfig>
): { valid: boolean; errors: string[] } {
  const cfg = { ...DEFAULT_VOICE_CONFIG, ...config };
  const errors: string[] = [];

  if (cfg.maxFileSizeBytes <= 0) {
    errors.push("maxFileSizeBytes 必须大于 0");
  }

  if (cfg.minDurationSeconds < 0) {
    errors.push("minDurationSeconds 必须 >= 0");
  }

  if (cfg.maxDurationSeconds <= cfg.minDurationSeconds) {
    errors.push("maxDurationSeconds 必须大于 minDurationSeconds");
  }

  if (cfg.allowedMimeTypes.length === 0) {
    errors.push("allowedMimeTypes 不能为空");
  }

  if (cfg.allowedSampleRates.length === 0) {
    errors.push("allowedSampleRates 不能为空");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
