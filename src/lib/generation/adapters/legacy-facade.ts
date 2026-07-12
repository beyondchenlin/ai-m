/**
 * v2.0 旧供应商兼容门面
 *
 * 手册 §7.2：原有同时实现文本和图片的供应商通过兼容包装器继续工作。
 * 迁移期间保留旧工厂入口，但新代码只能依赖能力服务。
 * 达到回归门槛后再删除旧接口，不允许永久双轨。
 */

import type { AIProvider, VideoProvider as LegacyVideoProvider } from "@/lib/ai/types";
import type { TextOptions, ImageOptions, VideoGenerateParams, VideoGenerateResult } from "@/lib/ai/types";
import type {
  TextProvider,
  ImageProvider,
  VideoProvider,
  TextRequest,
  TextResult,
  ImageRequest,
  ImageResult,
  VideoRequest,
  VideoResult,
  ExecutionContext,
} from "@/lib/generation/contracts";

/** 将旧 AIProvider 包装为新的 TextProvider + ImageProvider */
export class LegacyAIProviderFacade implements TextProvider, ImageProvider {
  constructor(private readonly legacy: AIProvider) {}

  async generateText(request: TextRequest, _context: ExecutionContext): Promise<TextResult> {
    const options: TextOptions = {
      model: undefined,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      systemPrompt: request.systemPrompt,
      images: request.images,
    };
    const text = await this.legacy.generateText(request.prompt, options);
    return { text };
  }

  async generateImage(request: ImageRequest, _context: ExecutionContext): Promise<ImageResult> {
    const options: ImageOptions = {
      model: undefined,
      size: request.size,
      aspectRatio: request.aspectRatio,
      quality: request.quality,
      referenceImages: request.referenceImages,
      referenceLabels: request.referenceLabels,
    };
    const url = await this.legacy.generateImage(request.prompt, options);
    return { images: [{ url, filePath: url }] };
  }
}

/** 将旧 VideoProvider 包装为新的 VideoProvider */
export class LegacyVideoProviderFacade implements VideoProvider {
  constructor(private readonly legacy: LegacyVideoProvider) {}

  async generateVideo(request: VideoRequest, _context: ExecutionContext): Promise<VideoResult> {
    const params: VideoGenerateParams = {
      prompt: request.prompt,
      duration: request.duration,
      ratio: request.ratio,
      referenceImages: request.referenceImages,
      ...(request.firstFrame && request.lastFrame
        ? { firstFrame: request.firstFrame, lastFrame: request.lastFrame }
        : { initialImage: request.initialImage ?? "" }),
    } as VideoGenerateParams;

    const result: VideoGenerateResult = await this.legacy.generateVideo(params);
    return {
      filePath: result.filePath,
      lastFrameUrl: result.lastFrameUrl,
    };
  }
}