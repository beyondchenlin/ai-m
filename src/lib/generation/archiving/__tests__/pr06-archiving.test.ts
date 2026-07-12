/**
 * PR-06 安全媒体归档单元测试
 */

import { describe, it, expect } from 'vitest';
import {
  detectMimeType,
  validateMimeType,
  detectImageDimensions,
  detectAudioDuration,
} from '../content-detection';
import { validateStorageKey, generateStorageKey } from '../atomic-commit';

describe('PR-06: 安全媒体归档', () => {
  describe('内容检测', () => {
    it('应该正确检测 PNG 文件', () => {
      const pngHeader = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      expect(detectMimeType(pngHeader)).toBe('image/png');
    });

    it('应该正确检测 JPEG 文件', () => {
      const jpegHeader = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]);
      expect(detectMimeType(jpegHeader)).toBe('image/jpeg');
    });

    it('应该正确检测 GIF 文件', () => {
      const gifHeader = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);
      expect(detectMimeType(gifHeader)).toBe('image/gif');
    });

    it('应该正确检测 WebP 文件', () => {
      const webpHeader = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x00, 0x00, 0x00, 0x00, // size
        0x57, 0x45, 0x42, 0x50, // WEBP
      ]);
      expect(detectMimeType(webpHeader)).toBe('image/webp');
    });

    it('应该正确检测 WAV 文件', () => {
      const wavHeader = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x00, 0x00, 0x00, 0x00, // size
        0x57, 0x41, 0x56, 0x45, // WAVE
      ]);
      expect(detectMimeType(wavHeader)).toBe('audio/wav');
    });

    it('应该正确检测 MP3 文件', () => {
      const mp3Header = new Uint8Array([0xFF, 0xFB, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]);
      expect(detectMimeType(mp3Header)).toBe('audio/mp3');
    });

    it('应该正确检测 MP4 文件', () => {
      const mp4Header = new Uint8Array([
        0x00, 0x00, 0x00, 0x20, // size
        0x66, 0x74, 0x79, 0x70, // ftyp
        0x69, 0x73, 0x6F, 0x6D, // isom
      ]);
      expect(detectMimeType(mp4Header)).toBe('video/mp4');
    });

    it('应该返回 null 对于未知格式', () => {
      const unknownHeader = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
      expect(detectMimeType(unknownHeader)).toBeNull();
    });

    it('应该验证 MIME 类型匹配', () => {
      const pngHeader = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      expect(validateMimeType(pngHeader, 'image/png')).toBe(true);
      expect(validateMimeType(pngHeader, 'image/jpeg')).toBe(false);
    });
  });

  describe('图片尺寸检测', () => {
    it('应该正确检测 PNG 尺寸', () => {
      // PNG header + IHDR chunk
      const pngData = new Uint8Array([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
        0x00, 0x00, 0x00, 0x0D, // IHDR length
        0x49, 0x48, 0x44, 0x52, // IHDR
        0x00, 0x00, 0x04, 0x00, // width: 1024
        0x00, 0x00, 0x03, 0x00, // height: 768
      ]);
      const dims = detectImageDimensions(pngData, 'image/png');
      expect(dims).toEqual({ width: 1024, height: 768 });
    });

    it('应该正确检测 GIF 尺寸', () => {
      const gifData = new Uint8Array([
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
        0x00, 0x04, // width: 1024 (little endian)
        0x00, 0x03, // height: 768 (little endian)
      ]);
      const dims = detectImageDimensions(gifData, 'image/gif');
      expect(dims).toEqual({ width: 1024, height: 768 });
    });

    it('应该返回 null 对于无法检测的尺寸', () => {
      const invalidData = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      expect(detectImageDimensions(invalidData, 'image/png')).toBeNull();
    });
  });

  describe('音频时长检测', () => {
    it('应该正确检测 WAV 时长', () => {
      // WAV header (44 bytes)
      const wavData = new Uint8Array(44);
      wavData.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
      wavData.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE

      // fmt chunk
      wavData.set([0x66, 0x6D, 0x74, 0x20], 12); // fmt
      wavData.set([0x10, 0x00, 0x00, 0x00], 16); // chunk size: 16
      wavData.set([0x01, 0x00], 20); // audio format: PCM
      wavData.set([0x02, 0x00], 22); // channels: 2
      wavData.set([0x44, 0xAC, 0x00, 0x00], 24); // sample rate: 44100
      wavData.set([0x10, 0x00], 34); // bits per sample: 16

      // data chunk
      wavData.set([0x64, 0x61, 0x74, 0x61], 36); // data
      wavData.set([0x00, 0x00, 0x10, 0x00], 40); // data size: 1048576 bytes

      const duration = detectAudioDuration(wavData, 'audio/wav');
      // 1048576 / (44100 * 2 * 2) = 5.94 seconds
      expect(duration).toBeCloseTo(5.94, 1);
    });

    it('应该返回 null 对于无法检测的时长', () => {
      const invalidData = new Uint8Array(10);
      expect(detectAudioDuration(invalidData, 'audio/wav')).toBeNull();
    });
  });

  describe('存储键验证', () => {
    it('应该接受合法的存储键', () => {
      expect(validateStorageKey('artifacts/abc123/image.png', '/data')).toBe(true);
      expect(validateStorageKey('images/2024/01/photo.jpg', '/data')).toBe(true);
    });

    it('应该拒绝绝对路径', () => {
      expect(validateStorageKey('/etc/passwd', '/data')).toBe(false);
      expect(validateStorageKey('C:\\Windows\\System32', '/data')).toBe(false);
    });

    it('应该拒绝路径穿越', () => {
      expect(validateStorageKey('../etc/passwd', '/data')).toBe(false);
      expect(validateStorageKey('artifacts/../../etc/passwd', '/data')).toBe(false);
    });

    it('应该拒绝特殊字符', () => {
      expect(validateStorageKey('file<name.png', '/data')).toBe(false);
      expect(validateStorageKey('file>name.png', '/data')).toBe(false);
      expect(validateStorageKey('file:name.png', '/data')).toBe(false);
    });
  });

  describe('存储键生成', () => {
    it('应该生成合法的存储键', () => {
      const key = generateStorageKey('attempt123', 'image/png', 0);
      expect(key).toMatch(/^artifacts\/attempt123\/\d+_0_[a-z0-9]+\.png$/);
    });

    it('应该根据 MIME 类型生成正确的扩展名', () => {
      expect(generateStorageKey('a', 'image/jpeg', 0)).toMatch(/\.jpg$/);
      expect(generateStorageKey('a', 'image/webp', 0)).toMatch(/\.webp$/);
      expect(generateStorageKey('a', 'audio/wav', 0)).toMatch(/\.wav$/);
      expect(generateStorageKey('a', 'video/mp4', 0)).toMatch(/\.mp4$/);
    });
  });
});
