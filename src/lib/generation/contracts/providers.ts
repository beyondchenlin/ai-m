/**
 * v2.0 独立能力接口
 *
 * 手册 §7.1：将旧 AIProvider 拆分为按能力独立的接口。
 * 文本、图片、视频、语音各自独立，避免纯图片后端必须实现无意义的文本方法。
 */

/** 文本生成请求 */
export interface TextRequest {
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  images?: string[]; // vision input
}

/** 文本生成结果 */
export interface TextResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/** 图片生成请求 */
export interface ImageRequest {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  aspectRatio?: string;
  size?: string;
  quality?: string;
  seed?: string; // 64-bit seed as string, no precision loss
  referenceImages?: string[];
  referenceLabels?: string[];
  count?: number;
}

/** 图片生成结果 */
export interface ImageResult {
  images: ImageOutput[];
}

export interface ImageOutput {
  url?: string;
  filePath?: string;
  storageKey?: string;
  width?: number;
  height?: number;
  mimeType?: string;
}

/** 视频生成请求 */
export interface VideoRequest {
  prompt: string;
  duration: number;
  ratio: string;
  firstFrame?: string;
  lastFrame?: string;
  initialImage?: string;
  referenceImages?: string[];
}

/** 视频生成结果 */
export interface VideoResult {
  filePath: string;
  lastFrameUrl?: string;
  storageKey?: string;
}

/** 语音生成请求 */
export interface SpeechRequest {
  text: string;
  voiceProfileId: string;
  speed?: number;
  pitch?: number;
}

/** 语音生成结果 */
export interface SpeechResult {
  audioFilePath: string;
  storageKey?: string;
  durationMs: number;
  format: string;
}

/** 执行上下文：传递给适配器的只读上下文 */
export interface ExecutionContext {
  projectId?: string;
  jobId?: string;
  attemptId?: string;
  traceId?: string;
}

/** 文本生成供应商 */
export interface TextProvider {
  generateText(request: TextRequest, context: ExecutionContext): Promise<TextResult>;
}

/** 图片生成供应商 */
export interface ImageProvider {
  generateImage(request: ImageRequest, context: ExecutionContext): Promise<ImageResult>;
}

/** 视频生成供应商 */
export interface VideoProvider {
  generateVideo(request: VideoRequest, context: ExecutionContext): Promise<VideoResult>;
}

/** 语音生成供应商 */
export interface SpeechProvider {
  generateSpeech(request: SpeechRequest, context: ExecutionContext): Promise<SpeechResult>;
}