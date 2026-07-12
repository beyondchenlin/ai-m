/**
 * v2.0 Z-Image 本地图片生成适配器
 *
 * 手册 §18、§19：通过 ComfyUI 传输适配器调用本地造相文生图模型。
 * 包括快速预览、质量工作流和参考一致闭环。
 */

import type { ImageProvider, ImageRequest, ImageResult, ImageOutput, ExecutionContext } from "@/lib/generation/contracts";
import type { ComfyUITransport } from "@/lib/generation/transports";
import { submitPrompt, probeHistory, downloadOutput } from "@/lib/generation/transports";
import { isEnabled, FF } from "@/lib/feature-flags";

/** Z-Image 节点类型 */
const ZIMAGE_NODE = {
  /** 造相文生图加载器 */
  LOADER: "ZImageLoader",
  /** 正提示词 */
  POSITIVE: "ZImagePositive",
  /** 负提示词 */
  NEGATIVE: "ZImageNegative",
  /** 采样器 */
  SAMPLER: "ZImageSampler",
  /** 解码器 */
  DECODER: "ZImageDecoder",
  /** 输出节点 */
  OUTPUT: "SaveImage",
} as const;

/** 质量工作流类型 */
export type QualityWorkflow = "fast-preview" | "standard" | "high-quality";

/** Z-Image 构建输入 */
export interface ZImageBuildInput {
  workflow: QualityWorkflow;
  seed?: string;
  cfg?: number;
  steps?: number;
  sampler?: string;
  scheduler?: string;
}

/** 默认质量参数 */
const QUALITY_DEFAULTS: Record<QualityWorkflow, { steps: number; cfg: number; sampler: string; scheduler: string }> = {
  "fast-preview": { steps: 8, cfg: 2.0, sampler: "euler", scheduler: "normal" },
  "standard": { steps: 20, cfg: 3.5, sampler: "euler_ancestral", scheduler: "normal" },
  "high-quality": { steps: 30, cfg: 5.0, sampler: "dpmpp_2m", scheduler: "karras" },
};

/** 构建 Z-Image 工作流 API JSON */
export function buildZImageWorkflow(
  request: ImageRequest,
  buildInput: ZImageBuildInput,
): Record<string, unknown> {
  const quality = QUALITY_DEFAULTS[buildInput.workflow];
  const steps = buildInput.steps ?? quality.steps;
  const cfg = buildInput.cfg ?? quality.cfg;
  const sampler = buildInput.sampler ?? quality.sampler;
  const scheduler = buildInput.scheduler ?? quality.scheduler;
  const seed = buildInput.seed ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString();
  const width = request.width ?? 1024;
  const height = request.height ?? 1024;

  return {
    nodes: {
      "1": {
        class_type: ZIMAGE_NODE.LOADER,
        inputs: {
          zimage_model: "Z-Image-Turbo",
        },
      },
      "2": {
        class_type: ZIMAGE_NODE.POSITIVE,
        inputs: {
          text: request.prompt,
          width,
          height,
        },
      },
      "3": {
        class_type: ZIMAGE_NODE.NEGATIVE,
        inputs: {
          text: request.negativePrompt ?? "",
        },
      },
      "4": {
        class_type: ZIMAGE_NODE.SAMPLER,
        inputs: {
          seed: parseInt(seed, 10) % Number.MAX_SAFE_INTEGER,
          steps,
          cfg,
          sampler_name: sampler,
          scheduler,
          denoise: 1.0,
          model: ["1", 0],
          positive: ["2", 0],
          negative: ["3", 0],
        },
      },
      "5": {
        class_type: ZIMAGE_NODE.DECODER,
        inputs: {
          samples: ["4", 0],
        },
      },
      "6": {
        class_type: ZIMAGE_NODE.OUTPUT,
        inputs: {
          images: ["5", 0],
          filename_prefix: "ai-m-zimage",
        },
      },
    },
    outputs: {
      "6": { class_type: ZIMAGE_NODE.OUTPUT, node_id: "6" },
    },
  };
}

/** Z-Image 本地图片生成适配器 */
export class ZImageAdapter implements ImageProvider {
  constructor(
    private readonly transport: ComfyUITransport,
    private readonly defaultQuality: QualityWorkflow = "standard",
  ) {}

  async generateImage(request: ImageRequest, context: ExecutionContext): Promise<ImageResult> {
    if (!isEnabled(FF.V2_LOCAL_IMAGE)) {
      throw new Error("v2.0 local image generation is not enabled");
    }

    const clientId = (this.transport as { getClientId?: () => string }).getClientId?.() ?? "unknown";

    const buildInput: ZImageBuildInput = {
      workflow: this.defaultQuality,
      seed: request.seed,
    };

    const workflow = buildZImageWorkflow(request, buildInput);

    // 提交到 ComfyUI
    const response = await submitPrompt(this.transport, workflow, clientId);

    console.log(`[ZImage] Submitted prompt ${response.promptId} (queue: ${response.queueRemaining ?? "?"})`);

    // 轮询直到完成
    const result = await this.waitForCompletion(response.promptId);

    // 收集输出
    const images: ImageOutput[] = [];
    const outputs = result.outputs;

    for (const [nodeId, nodeOutputs] of Object.entries(outputs)) {
      if (nodeOutputs.images) {
        for (const img of nodeOutputs.images) {
          images.push({
            storageKey: `${img.type}/${img.subfolder}/${img.filename}`,
            mimeType: img.filename.endsWith(".png") ? "image/png" : "image/jpeg",
          });
        }
      }
    }

    return { images };
  }

  /** 等待 ComfyUI 执行完成 */
  private async waitForCompletion(
    promptId: string,
    maxWaitMs: number = 300_000,
  ): Promise<{ outputs: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }> }> {
    const startedAt = Date.now();
    const pollInterval = 2000;

    while (Date.now() - startedAt < maxWaitMs) {
      const history = await probeHistory(this.transport, promptId);
      const entry = history[promptId];

      if (entry && entry.status.completed) {
        return entry;
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Z-Image execution timed out after ${maxWaitMs}ms for prompt ${promptId}`);
  }
}

/** 创建 Z-Image 适配器 */
export function createZImageAdapter(
  transport: ComfyUITransport,
  quality: QualityWorkflow = "standard",
): ZImageAdapter {
  return new ZImageAdapter(transport, quality);
}