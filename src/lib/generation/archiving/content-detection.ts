/**
 * 内容检测与魔数校验
 *
 * 手册 §15.1：媒体魔数和安全解码
 * 通过文件头字节识别真实 MIME 类型，防止恶意文件伪装
 */

import { createHash } from 'crypto';

/** 文件魔数定义 */
const MAGIC_NUMBERS: Record<string, { offset: number; bytes: number[] }> = {
  // 图片格式
  'image/png': { offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  'image/jpeg': { offset: 0, bytes: [0xFF, 0xD8, 0xFF] },
  'image/gif': { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF87a 或 GIF89a
  'image/webp': { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
  'image/bmp': { offset: 0, bytes: [0x42, 0x4D] },
  'image/svg+xml': { offset: 0, bytes: [0x3C, 0x3F, 0x78, 0x6D, 0x6C] }, // <?xml
  'image/avif': { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66] }, // ftypavif

  // 音频格式
  'audio/wav': { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
  'audio/mp3': { offset: 0, bytes: [0xFF, 0xFB] }, // MP3 帧头
  'audio/mpeg': { offset: 0, bytes: [0xFF, 0xFB] },
  'audio/ogg': { offset: 0, bytes: [0x4F, 0x67, 0x67, 0x53] }, // OggS
  'audio/flac': { offset: 0, bytes: [0x66, 0x4C, 0x61, 0x43] }, // fLaC
  'audio/aac': { offset: 0, bytes: [0xFF, 0xF1] }, // ADTS
  'audio/m4a': { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x4D, 0x34, 0x41] }, // ftypM4A

  // 视频格式
  'video/mp4': { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }, // ftyp
  'video/webm': { offset: 0, bytes: [0x1A, 0x45, 0xDF, 0xA3] }, // EBML
  'video/avi': { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
};

/**
 * 检测文件真实 MIME 类型
 *
 * @param buffer 文件头部字节（至少 32 字节）
 * @returns 检测到的 MIME 类型，未识别返回 null
 */
export function detectMimeType(buffer: Uint8Array): string | null {
  if (buffer.length < 8) {
    return null;
  }

  // 检查 SVG（文本格式，需要特殊处理）
  if (buffer.length >= 5) {
    const svgHeader = String.fromCharCode(...buffer.slice(0, 5));
    if (svgHeader === '<?xml') {
      // 进一步检查是否包含 <svg
      const text = new TextDecoder().decode(buffer.slice(0, Math.min(1024, buffer.length)));
      if (text.includes('<svg')) {
        return 'image/svg+xml';
      }
    }
  }

  // 检查 WebP（RIFF 容器，需要检查 WEBP 标识）
  if (buffer.length >= 12) {
    const riff = String.fromCharCode(...buffer.slice(0, 4));
    const webp = String.fromCharCode(...buffer.slice(8, 12));
    if (riff === 'RIFF' && webp === 'WEBP') {
      return 'image/webp';
    }
  }

  // 检查 MP4/M4A（ftyp 容器）
  if (buffer.length >= 12) {
    const ftyp = String.fromCharCode(...buffer.slice(4, 8));
    if (ftyp === 'ftyp') {
      const brand = String.fromCharCode(...buffer.slice(8, 12));
      if (brand === 'M4A ' || brand === 'M4A') {
        return 'audio/m4a';
      }
      if (brand === 'isom' || brand === 'mp42' || brand === 'avc1') {
        return 'video/mp4';
      }
    }
  }

  // 检查 WAV（RIFF 容器，需要检查 WAVE 标识）
  if (buffer.length >= 12) {
    const riff = String.fromCharCode(...buffer.slice(0, 4));
    const wave = String.fromCharCode(...buffer.slice(8, 12));
    if (riff === 'RIFF' && wave === 'WAVE') {
      return 'audio/wav';
    }
  }

  // 检查 AVI（RIFF 容器，需要检查 AVI 标识）
  if (buffer.length >= 12) {
    const riff = String.fromCharCode(...buffer.slice(0, 4));
    const avi = String.fromCharCode(...buffer.slice(8, 12));
    if (riff === 'RIFF' && (avi === 'AVI ' || avi === 'AVIX')) {
      return 'video/avi';
    }
  }

  // 检查 MP3（既支持 ID3 标签，也支持 MPEG 音频帧同步）
  if (buffer.length >= 3 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    return 'audio/mpeg';
  }
  if (buffer.length >= 2 && buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) {
    return 'audio/mpeg';
  }

  // 检查其他格式
  for (const [mimeType, { offset, bytes }] of Object.entries(MAGIC_NUMBERS)) {
    // 跳过已特殊处理的格式
    if (['image/webp', 'audio/wav', 'video/avi', 'audio/m4a', 'video/mp4', 'image/svg+xml'].includes(mimeType)) {
      continue;
    }

    if (buffer.length < offset + bytes.length) {
      continue;
    }

    let match = true;
    for (let i = 0; i < bytes.length; i++) {
      if (buffer[offset + i] !== bytes[i]) {
        match = false;
        break;
      }
    }

    if (match) {
      return mimeType;
    }
  }

  return null;
}

/**
 * 验证文件内容是否与声明的 MIME 类型匹配
 *
 * @param buffer 文件头部字节
 * @param declaredType 声明的 MIME 类型
 * @returns 是否匹配
 */
export function validateMimeType(buffer: Uint8Array, declaredType: string): boolean {
  const detected = detectMimeType(buffer);
  if (!detected) {
    return false;
  }

  // 允许的 MIME 类型映射（兼容变体）
  const allowedVariants: Record<string, string[]> = {
    'image/png': ['image/png'],
    'image/jpeg': ['image/jpeg', 'image/jpg'],
    'image/gif': ['image/gif'],
    'image/webp': ['image/webp'],
    'image/bmp': ['image/bmp'],
    'image/svg+xml': ['image/svg+xml'],
    'image/avif': ['image/avif'],
    'audio/wav': ['audio/wav', 'audio/x-wav'],
    'audio/mp3': ['audio/mp3', 'audio/mpeg', 'audio/x-mp3'],
    'audio/ogg': ['audio/ogg', 'audio/ogg-vorbis'],
    'audio/flac': ['audio/flac', 'audio/x-flac'],
    'audio/aac': ['audio/aac', 'audio/aacp'],
    'audio/m4a': ['audio/m4a', 'audio/mp4', 'audio/x-m4a'],
    'video/mp4': ['video/mp4', 'video/x-mp4'],
    'video/webm': ['video/webm'],
    'video/avi': ['video/avi', 'video/x-msvideo', 'video/msvideo'],
  };

  const variants = allowedVariants[detected] || [detected];
  return variants.includes(declaredType);
}

/**
 * 计算流式 SHA256 摘要
 *
 * @param stream 可读流
 * @returns SHA256 摘要（十六进制）
 */
export async function computeStreamHash(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = createHash('sha256');
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
    }
  } finally {
    reader.releaseLock();
  }

  return hash.digest('hex');
}

/**
 * 验证图片尺寸（防止恶意超大图片）
 *
 * @param buffer 图片文件内容
 * @param mimeType MIME 类型
 * @returns 宽高，未识别返回 null
 */
export function detectImageDimensions(buffer: Uint8Array, mimeType: string): { width: number; height: number } | null {
  try {
    if (mimeType === 'image/png' && buffer.length >= 24) {
      // PNG: 宽度在 16-19 字节，高度在 20-23 字节
      const width = (buffer[16] << 24) | (buffer[17] << 16) | (buffer[18] << 8) | buffer[19];
      const height = (buffer[20] << 24) | (buffer[21] << 16) | (buffer[22] << 8) | buffer[23];
      return { width, height };
    }

    if (mimeType === 'image/jpeg') {
      // JPEG: 需要解析 SOF 标记
      let offset = 2; // 跳过 SOI
      while (offset < buffer.length - 10) {
        if (buffer[offset] !== 0xFF) break;
        const marker = buffer[offset + 1];

        // SOF0-SOF15（除 DHT=0xC4, DAC=0xCC）
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xCC) {
          const height = (buffer[offset + 5] << 8) | buffer[offset + 6];
          const width = (buffer[offset + 7] << 8) | buffer[offset + 8];
          return { width, height };
        }

        // 跳过当前段
        const length = (buffer[offset + 2] << 8) | buffer[offset + 3];
        offset += 2 + length;
      }
    }

    if (mimeType === 'image/gif' && buffer.length >= 10) {
      // GIF: 宽度在 6-7 字节，高度在 8-9 字节
      const width = buffer[6] | (buffer[7] << 8);
      const height = buffer[8] | (buffer[9] << 8);
      return { width, height };
    }

    if (mimeType === 'image/webp' && buffer.length >= 30) {
      // WebP: 需要检查 VP8/VP8L/VP8X 格式
      const format = String.fromCharCode(...buffer.slice(12, 16));
      if (format === 'VP8 ' && buffer.length >= 30) {
        const width = (buffer[26] | (buffer[27] << 8)) & 0x3FFF;
        const height = (buffer[28] | (buffer[29] << 8)) & 0x3FFF;
        return { width, height };
      }
    }
  } catch {
    // 解析失败返回 null
  }

  return null;
}

/**
 * 检测音频时长（估算）
 *
 * @param buffer 音频文件内容
 * @param mimeType MIME 类型
 * @returns 时长（秒），未识别返回 null
 */
export function detectAudioDuration(buffer: Uint8Array, mimeType: string): number | null {
  try {
    if (mimeType === 'audio/wav' && buffer.length >= 44) {
      // WAV: 采样率在 24-27 字节，数据大小在 40-43 字节
      const sampleRate = buffer[24] | (buffer[25] << 8) | (buffer[26] << 16) | (buffer[27] << 24);
      const dataSize = buffer[40] | (buffer[41] << 8) | (buffer[42] << 16) | (buffer[43] << 24);
      const bitsPerSample = buffer[34] | (buffer[35] << 8);
      const channels = buffer[22] | (buffer[23] << 8);

      if (sampleRate > 0 && bitsPerSample > 0 && channels > 0) {
        const bytesPerSample = (bitsPerSample / 8) * channels;
        return dataSize / (sampleRate * bytesPerSample);
      }
    }

    if (mimeType === 'audio/mp3' || mimeType === 'audio/mpeg') {
      // MP3: 需要解析帧头和比特率
      // 简化估算：假设 CBR，从文件大小和比特率估算
      // 这里只返回 null，实际实现需要更复杂的解析
      return null;
    }
  } catch {
    // 解析失败返回 null
  }

  return null;
}
