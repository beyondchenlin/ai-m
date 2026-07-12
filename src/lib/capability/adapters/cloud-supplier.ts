/**
 * v2.0 云供应商兼容适配器
 *
 * 阶段 C：将旧云供应商（OpenAI、Gemini、Kling、DashScope、Seedance 等）
 * 包装为统一的能力接口。后续阶段 D 将替换为 ComfyUI 传输适配器。
 */

import { OpenAIProvider } from "@/lib/ai/providers/openai";
import { GeminiProvider } from "@/lib/ai/providers/gemini";
import { VeoProvider } from "@/lib/ai/providers/veo";
import { KlingImageProvider } from "@/lib/ai/providers/kling-image";
import { KlingVideoProvider } from "@/lib/ai/providers/kling-video";
import { WanVideoProvider } from "@/lib/ai/providers/wan-video";
import { SeedanceProvider } from "@/lib/ai/providers/seedance";
import { UCloudSeedanceProvider } from "@/lib/ai/providers/ucloud-seedance";
import { DashScopeImageProvider } from "@/lib/ai/providers/dashscope-image";
import type { AIProvider, VideoProvider, TextOptions, ImageOptions, VideoGenerateParams, VideoGenerateResult } from "@/lib/ai/types";

interface AdapterConfig {
  protocol: string;
  baseUrl: string;
  apiKey: string;
  secretKey?: string;
  modelId: string;
  uploadDir?: string;
}

/** 创建图片/文本 AI 供应商适配器 */
function createImageAdapter(config: AdapterConfig): AIProvider {
  const { protocol, apiKey, baseUrl, modelId, secretKey, uploadDir } = config;
  const opts = { apiKey, baseURL: baseUrl, model: modelId, ...(uploadDir && { uploadDir }) };

  switch (protocol) {
    case "openai":   return new OpenAIProvider(opts);
    case "gemini":   return new GeminiProvider({ apiKey, baseUrl, model: modelId, ...(uploadDir && { uploadDir }) });
    case "kling":    return new KlingImageProvider({ ...opts, secretKey });
    case "dashscope": return new DashScopeImageProvider(opts);
    default:
      throw new Error(`[CloudAdapter] Unsupported image protocol: ${protocol}`);
  }
}

/** 创建视频供应商适配器 */
function createVideoAdapter(config: AdapterConfig): VideoProvider {
  const { protocol, apiKey, baseUrl, modelId, secretKey, uploadDir } = config;
  const opts = { apiKey, baseURL: baseUrl, model: modelId, ...(uploadDir && { uploadDir }) };

  switch (protocol) {
    case "seedance":          return new SeedanceProvider(opts);
    case "ucloud-seedance":   return new UCloudSeedanceProvider(opts);
    case "kling":             return new KlingVideoProvider({ ...opts, secretKey });
    case "wan":               return new WanVideoProvider(opts);
    case "gemini":            return new VeoProvider({ apiKey, baseUrl, model: modelId, ...(uploadDir && { uploadDir }) });
    default:
      throw new Error(`[CloudAdapter] Unsupported video protocol: ${protocol}`);
  }
}

/** 云供应商适配器：实现统一的 AIProvider + VideoProvider 接口 */
export class CloudSupplierAdapter implements AIProvider, VideoProvider {
  private imageProvider: AIProvider | null = null;
  private videoProvider: VideoProvider | null = null;

  constructor(private config: AdapterConfig) {}

  private getImageProvider(): AIProvider {
    if (!this.imageProvider) {
      this.imageProvider = createImageAdapter(this.config);
    }
    return this.imageProvider;
  }

  private getVideoProvider(): VideoProvider {
    if (!this.videoProvider) {
      this.videoProvider = createVideoAdapter(this.config);
    }
    return this.videoProvider;
  }

  async generateText(prompt: string, options?: TextOptions): Promise<string> {
    return this.getImageProvider().generateText(prompt, options);
  }

  async generateImage(prompt: string, options?: ImageOptions): Promise<string> {
    return this.getImageProvider().generateImage(prompt, options);
  }

  async generateVideo(params: VideoGenerateParams): Promise<VideoGenerateResult> {
    return this.getVideoProvider().generateVideo(params);
  }
}