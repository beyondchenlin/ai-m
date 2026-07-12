/**
 * v2.0 能力服务类型定义
 *
 * 统一旧云供应商和新 ComfyUI 后端的能力接口。
 * 阶段 C：旧供应商通过兼容适配器进入此服务。
 */

import type { TextOptions, ImageOptions, VideoGenerateParams, VideoGenerateResult } from "@/lib/ai/types";

/** 能力类型 */
export type CapabilityKind = "text" | "image" | "video";

/** 能力请求 */
export interface CapabilityRequest {
  kind: CapabilityKind;
  /** v2.0: 服务端执行后端 ID */
  backendId?: string;
  /** 旧流程: 浏览器模型配置（向后兼容） */
  legacyConfig?: {
    protocol: string;
    baseUrl: string;
    apiKey: string;
    secretKey?: string;
    modelId: string;
  };
  /** 上传目录（图片/视频生成需要） */
  uploadDir?: string;
}

/** 能力服务接口 */
export interface ICapabilityService {
  /** 生成文本 */
  generateText(prompt: string, options?: TextOptions, request?: CapabilityRequest): Promise<string>;
  /** 生成图片 */
  generateImage(prompt: string, options?: ImageOptions, request?: CapabilityRequest): Promise<string>;
  /** 生成视频 */
  generateVideo(params: VideoGenerateParams, request?: CapabilityRequest): Promise<VideoGenerateResult>;
}