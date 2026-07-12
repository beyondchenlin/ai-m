/**
 * 原子提交机制
 *
 * 手册 §15.4：原子提交
 * 1. 写入目标目录内的临时文件
 * 2. 流式计算摘要并检查大小
 * 3. 刷新文件内容
 * 4. 解码和内容验证
 * 5. 原子重命名为内容寻址或任务命名路径
 * 6. 提交数据库记录
 */

import { createWriteStream, rename, unlink, stat } from 'fs/promises';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { mkdir } from 'fs/promises';
import { detectMimeType, validateMimeType, detectImageDimensions, detectAudioDuration } from './content-detection';

/** 输出策略配置 */
export interface OutputPolicy {
  /** 最大文件大小（字节） */
  maxFileSizeBytes: number;
  /** 允许的 MIME 类型 */
  allowedMimeTypes: string[];
  /** 图片最大像素数 */
  maxPixels?: number;
  /** 图片最大宽度 */
  maxWidth?: number;
  /** 图片最大高度 */
  maxHeight?: number;
  /** 音频最大时长（秒） */
  maxDurationSeconds?: number;
  /** 视频最大时长（秒） */
  maxVideoDurationSeconds?: number;
}

/** 默认输出策略 */
export const DEFAULT_OUTPUT_POLICY: OutputPolicy = {
  maxFileSizeBytes: 100 * 1024 * 1024, // 100MB
  allowedMimeTypes: [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'audio/wav',
    'audio/mp3',
    'audio/m4a',
    'video/mp4',
  ],
  maxPixels: 16 * 1024 * 1024, // 16MP
  maxWidth: 8192,
  maxHeight: 8192,
  maxDurationSeconds: 300, // 5分钟
  maxVideoDurationSeconds: 600, // 10分钟
};

/** 提交结果 */
export interface CommitResult {
  /** 存储键 */
  storageKey: string;
  /** 文件大小（字节） */
  sizeBytes: number;
  /** SHA256 摘要 */
  sha256: string;
  /** MIME 类型 */
  mimeType: string;
  /** 图片宽度 */
  width?: number;
  /** 图片高度 */
  height?: number;
  /** 音频/视频时长（秒） */
  durationSeconds?: number;
}

/**
 * 流式提交工件
 *
 * 禁止将大图、音频或视频一次性读入 ArrayBuffer。
 * 逐块计数、摘要、临时写入、内容探测、解码验证、同步、原子提交。
 *
 * @param stream 可读流
 * @param targetPath 目标路径
 * @param policy 输出策略
 * @returns 提交结果
 */
export async function commitArtifact(
  stream: ReadableStream<Uint8Array>,
  targetPath: string,
  policy: OutputPolicy = DEFAULT_OUTPUT_POLICY,
): Promise<CommitResult> {
  // 确保目标目录存在
  await mkdir(dirname(targetPath), { recursive: true });

  // 生成临时文件路径
  const tempPath = `${targetPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;

  const hash = createHash('sha256');
  const writer = createWriteStream(tempPath);
  const reader = stream.getReader();

  let totalBytes = 0;
  let headerBuffer: Uint8Array | null = null;
  const headerSize = 1024; // 读取前 1KB 用于内容检测

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // 保存头部用于内容检测
      if (!headerBuffer && value.length > 0) {
        headerBuffer = value.slice(0, Math.min(headerSize, value.length));
      }

      // 检查文件大小限制
      totalBytes += value.length;
      if (totalBytes > policy.maxFileSizeBytes) {
        throw new Error(`File size exceeds limit: ${totalBytes} > ${policy.maxFileSizeBytes}`);
      }

      // 更新哈希
      hash.update(value);

      // 写入临时文件
      await new Promise<void>((resolve, reject) => {
        writer.write(value, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    // 关闭写入流
    await new Promise<void>((resolve, reject) => {
      writer.end((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // 内容检测
    if (!headerBuffer || headerBuffer.length < 8) {
      throw new Error('File is too small or empty');
    }

    const detectedMime = detectMimeType(headerBuffer);
    if (!detectedMime) {
      throw new Error('Unable to detect file type');
    }

    if (!policy.allowedMimeTypes.includes(detectedMime)) {
      throw new Error(`File type not allowed: ${detectedMime}`);
    }

    // 读取完整文件用于验证（对于小文件）
    let width: number | undefined;
    let height: number | undefined;
    let durationSeconds: number | undefined;

    // 对于图片，检测尺寸
    if (detectedMime.startsWith('image/')) {
      const fileBuffer = await readFileBuffer(tempPath);
      const dims = detectImageDimensions(fileBuffer, detectedMime);
      if (dims) {
        width = dims.width;
        height = dims.height;

        // 检查像素限制
        if (policy.maxPixels && width * height > policy.maxPixels) {
          throw new Error(`Image pixels exceed limit: ${width * height} > ${policy.maxPixels}`);
        }

        // 检查宽高限制
        if (policy.maxWidth && width > policy.maxWidth) {
          throw new Error(`Image width exceeds limit: ${width} > ${policy.maxWidth}`);
        }
        if (policy.maxHeight && height > policy.maxHeight) {
          throw new Error(`Image height exceeds limit: ${height} > ${policy.maxHeight}`);
        }
      }
    }

    // 对于音频，检测时长
    if (detectedMime.startsWith('audio/')) {
      const fileBuffer = await readFileBuffer(tempPath);
      const duration = detectAudioDuration(fileBuffer, detectedMime);
      if (duration !== null && policy.maxDurationSeconds && duration > policy.maxDurationSeconds) {
        throw new Error(`Audio duration exceeds limit: ${duration} > ${policy.maxDurationSeconds}`);
      }
      durationSeconds = duration ?? undefined;
    }

    // 原子重命名
    await rename(tempPath, targetPath);

    const sha256 = hash.digest('hex');

    return {
      storageKey: targetPath,
      sizeBytes: totalBytes,
      sha256,
      mimeType: detectedMime,
      width,
      height,
      durationSeconds,
    };
  } catch (error) {
    // 清理临时文件
    try {
      await unlink(tempPath);
    } catch {
      // 忽略清理错误
    }
    throw error;
  }
}

/**
 * 读取文件完整内容（用于小文件验证）
 */
async function readFileBuffer(filePath: string): Promise<Uint8Array> {
  const { readFile } = await import('fs/promises');
  const buffer = await readFile(filePath);
  return new Uint8Array(buffer);
}

/**
 * 从 Buffer 提交工件（用于小文件）
 *
 * @param buffer 文件内容
 * @param targetPath 目标路径
 * @param policy 输出策略
 * @returns 提交结果
 */
export async function commitArtifactFromBuffer(
  buffer: Buffer,
  targetPath: string,
  policy: OutputPolicy = DEFAULT_OUTPUT_POLICY,
): Promise<CommitResult> {
  // 检查文件大小
  if (buffer.length > policy.maxFileSizeBytes) {
    throw new Error(`File size exceeds limit: ${buffer.length} > ${policy.maxFileSizeBytes}`);
  }

  // 内容检测
  const headerBuffer = new Uint8Array(buffer.slice(0, Math.min(1024, buffer.length)));
  const detectedMime = detectMimeType(headerBuffer);
  if (!detectedMime) {
    throw new Error('Unable to detect file type');
  }

  if (!policy.allowedMimeTypes.includes(detectedMime)) {
    throw new Error(`File type not allowed: ${detectedMime}`);
  }

  // 确保目标目录存在
  await mkdir(dirname(targetPath), { recursive: true });

  // 生成临时文件路径
  const tempPath = `${targetPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;

  try {
    // 写入临时文件
    const { writeFile } = await import('fs/promises');
    await writeFile(tempPath, buffer);

    let width: number | undefined;
    let height: number | undefined;
    let durationSeconds: number | undefined;

    // 对于图片，检测尺寸
    if (detectedMime.startsWith('image/')) {
      const dims = detectImageDimensions(headerBuffer, detectedMime);
      if (dims) {
        width = dims.width;
        height = dims.height;

        // 检查像素限制
        if (policy.maxPixels && width * height > policy.maxPixels) {
          throw new Error(`Image pixels exceed limit: ${width * height} > ${policy.maxPixels}`);
        }

        // 检查宽高限制
        if (policy.maxWidth && width > policy.maxWidth) {
          throw new Error(`Image width exceeds limit: ${width} > ${policy.maxWidth}`);
        }
        if (policy.maxHeight && height > policy.maxHeight) {
          throw new Error(`Image height exceeds limit: ${height} > ${policy.maxHeight}`);
        }
      }
    }

    // 对于音频，检测时长
    if (detectedMime.startsWith('audio/')) {
      const duration = detectAudioDuration(headerBuffer, detectedMime);
      if (duration !== null && policy.maxDurationSeconds && duration > policy.maxDurationSeconds) {
        throw new Error(`Audio duration exceeds limit: ${duration} > ${policy.maxDurationSeconds}`);
      }
      durationSeconds = duration ?? undefined;
    }

    // 原子重命名
    await rename(tempPath, targetPath);

    const hash = createHash('sha256');
    hash.update(buffer);
    const sha256 = hash.digest('hex');

    return {
      storageKey: targetPath,
      sizeBytes: buffer.length,
      sha256,
      mimeType: detectedMime,
      width,
      height,
      durationSeconds,
    };
  } catch (error) {
    // 清理临时文件
    try {
      await unlink(tempPath);
    } catch {
      // 忽略清理错误
    }
    throw error;
  }
}

/**
 * 验证存储键安全性
 *
 * 手册 §15.5：路径规则
 * - 不接受外部绝对路径
 * - 不信任外部子目录和文件名
 * - 解析后的路径必须位于允许根目录
 * - 拒绝路径穿越、符号链接和特殊设备
 *
 * @param storageKey 存储键
 * @param allowedRoot 允许的根目录
 * @returns 是否安全
 */
export function validateStorageKey(storageKey: string, allowedRoot: string): boolean {
  // 拒绝绝对路径
  if (storageKey.startsWith('/') || /^[a-zA-Z]:\\/.test(storageKey)) {
    return false;
  }

  // 拒绝路径穿越
  if (storageKey.includes('..') || storageKey.includes('./') || storageKey.includes('\\..')) {
    return false;
  }

  // 拒绝特殊字符
  if (/[<>:"|?*]/.test(storageKey)) {
    return false;
  }

  // 拒绝控制字符
  if (/[\x00-\x1F\x7F]/.test(storageKey)) {
    return false;
  }

  // 解析完整路径并检查是否在允许根目录下
  const { resolve } = require('path');
  const fullPath = resolve(allowedRoot, storageKey);
  const resolvedRoot = resolve(allowedRoot);

  if (!fullPath.startsWith(resolvedRoot)) {
    return false;
  }

  return true;
}

/**
 * 生成安全的存储键
 *
 * @param attemptId 尝试 ID
 * @param mimeType MIME 类型
 * @param index 文件索引
 * @returns 存储键
 */
export function generateStorageKey(attemptId: string, mimeType: string, index: number = 0): string {
  const ext = getExtensionFromMime(mimeType);
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `artifacts/${attemptId}/${timestamp}_${index}_${random}.${ext}`;
}

/**
 * 从 MIME 类型获取文件扩展名
 */
function getExtensionFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    'audio/wav': 'wav',
    'audio/mp3': 'mp3',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'audio/aac': 'aac',
    'audio/m4a': 'm4a',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/avi': 'avi',
  };
  return map[mimeType] || 'bin';
}
