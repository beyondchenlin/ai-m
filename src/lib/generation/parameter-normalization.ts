/**
 * 参数规范化模块
 *
 * 手册 §18.2：参数规范化
 * - 提示词长度限制
 * - 宽高由比例和配置策略计算
 * - 宽高符合工作流倍数（通常 8 的倍数）
 * - 像素总量受显存基线限制
 * - 批量数量受配置限制
 * - 随机种子以字符串保存
 * - 输出前缀由系统生成
 * - 用户不能覆盖模型文件名和任意节点输入
 */

/** 宽高比例映射 */
const ASPECT_RATIOS: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "16:9": { width: 1344, height: 768 },
  "9:16": { width: 768, height: 1344 },
  "4:3": { width: 1152, height: 896 },
  "3:4": { width: 896, height: 1152 },
};

/** 显存基线（像素总量限制） */
const PIXEL_BUDGETS = {
  low: 1024 * 1024, // 1MP - 8GB 显存
  medium: 1344 * 768, // ~1MP - 12GB 显存
  high: 1536 * 1536, // ~2.4MP - 16GB+ 显存
} as const;

/** 参数规范化配置 */
export interface NormalizationConfig {
  /** 提示词最大长度（字符数） */
  maxPromptLength: number;
  /** 负面提示词最大长度（字符数） */
  maxNegativePromptLength: number;
  /** 允许的宽高比例 */
  allowedAspectRatios: string[];
  /** 像素预算级别 */
  pixelBudget: keyof typeof PIXEL_BUDGETS;
  /** 最大批量数量 */
  maxBatchSize: number;
  /** 宽高倍数（通常为 8） */
  dimensionMultiple: number;
}

/** 默认规范化配置 */
const DEFAULT_CONFIG: NormalizationConfig = {
  maxPromptLength: 1000,
  maxNegativePromptLength: 500,
  allowedAspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
  pixelBudget: "medium",
  maxBatchSize: 1,
  dimensionMultiple: 8,
};

/** 规范化后的参数 */
export interface NormalizedParameters {
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  seed: string;
  batchSize: number;
}

/** 输入参数 */
export interface InputParameters {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  aspectRatio?: string;
  seed?: string | number;
  batchSize?: number;
}

/**
 * 规范化提示词长度
 */
function normalizePromptLength(
  prompt: string,
  maxLength: number
): string {
  if (prompt.length <= maxLength) {
    return prompt;
  }
  console.warn(
    `[ParameterNormalization] Prompt truncated from ${prompt.length} to ${maxLength} characters`
  );
  return prompt.slice(0, maxLength);
}

/**
 * 计算宽高（基于比例）
 */
function calculateDimensions(
  aspectRatio: string,
  pixelBudget: keyof typeof PIXEL_BUDGETS,
  multiple: number
): { width: number; height: number } {
  const ratio = ASPECT_RATIOS[aspectRatio];
  if (!ratio) {
    throw new Error(`Unsupported aspect ratio: ${aspectRatio}`);
  }

  const maxPixels = PIXEL_BUDGETS[pixelBudget];
  const ratioValue = ratio.width / ratio.height;

  // 计算基础尺寸
  let width = ratio.width;
  let height = ratio.height;

  // 确保不超过像素预算
  const currentPixels = width * height;
  if (currentPixels > maxPixels) {
    const scale = Math.sqrt(maxPixels / currentPixels);
    width = Math.floor(width * scale);
    height = Math.floor(height * scale);
  }

  // 对齐到倍数
  width = Math.floor(width / multiple) * multiple;
  height = Math.floor(height / multiple) * multiple;

  // 确保最小尺寸
  width = Math.max(width, multiple * 8); // 至少 64
  height = Math.max(height, multiple * 8);

  return { width, height };
}

/**
 * 规范化种子（转为字符串）
 */
function normalizeSeed(seed?: string | number): string {
  if (seed === undefined || seed === null || seed === "") {
    // 生成随机种子
    return Math.floor(Math.random() * 2147483647).toString();
  }
  return seed.toString();
}

/**
 * 规范化批量数量
 */
function normalizeBatchSize(
  batchSize: number | undefined,
  maxBatchSize: number
): number {
  if (batchSize === undefined || batchSize < 1) {
    return 1;
  }
  if (batchSize > maxBatchSize) {
    console.warn(
      `[ParameterNormalization] Batch size reduced from ${batchSize} to ${maxBatchSize}`
    );
    return maxBatchSize;
  }
  return batchSize;
}

/**
 * 规范化生成参数
 */
export function normalizeParameters(
  input: InputParameters,
  config: Partial<NormalizationConfig> = {}
): NormalizedParameters {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // 1. 规范化提示词
  const prompt = normalizePromptLength(input.prompt, cfg.maxPromptLength);
  const negativePrompt = normalizePromptLength(
    input.negativePrompt || "",
    cfg.maxNegativePromptLength
  );

  // 2. 计算宽高
  let width: number;
  let height: number;

  if (input.width && input.height) {
    // 使用指定的宽高，但需要对齐到倍数
    width = Math.floor(input.width / cfg.dimensionMultiple) * cfg.dimensionMultiple;
    height = Math.floor(input.height / cfg.dimensionMultiple) * cfg.dimensionMultiple;

    // 检查像素预算
    const maxPixels = PIXEL_BUDGETS[cfg.pixelBudget];
    if (width * height > maxPixels) {
      const scale = Math.sqrt(maxPixels / (width * height));
      width = Math.floor((width * scale) / cfg.dimensionMultiple) * cfg.dimensionMultiple;
      height = Math.floor((height * scale) / cfg.dimensionMultiple) * cfg.dimensionMultiple;
      console.warn(
        `[ParameterNormalization] Dimensions scaled down to fit pixel budget: ${width}x${height}`
      );
    }
  } else if (input.aspectRatio) {
    // 基于比例计算
    if (!cfg.allowedAspectRatios.includes(input.aspectRatio)) {
      throw new Error(
        `Aspect ratio ${input.aspectRatio} not allowed. Allowed: ${cfg.allowedAspectRatios.join(", ")}`
      );
    }
    const dims = calculateDimensions(input.aspectRatio, cfg.pixelBudget, cfg.dimensionMultiple);
    width = dims.width;
    height = dims.height;
  } else {
    // 默认 1:1
    const dims = calculateDimensions("1:1", cfg.pixelBudget, cfg.dimensionMultiple);
    width = dims.width;
    height = dims.height;
  }

  // 3. 规范化种子
  const seed = normalizeSeed(input.seed);

  // 4. 规范化批量数量
  const batchSize = normalizeBatchSize(input.batchSize, cfg.maxBatchSize);

  return {
    prompt,
    negativePrompt,
    width,
    height,
    seed,
    batchSize,
  };
}

/**
 * 生成输出前缀
 *
 * 手册 §18.2：输出前缀由系统生成，用户不能覆盖
 */
export function generateOutputPrefix(
  jobId: string,
  attemptId: string
): string {
  return `ai-m-${jobId}-${attemptId}`;
}

/**
 * 验证参数是否符合配置限制
 */
export function validateParameters(
  params: NormalizedParameters,
  config: Partial<NormalizationConfig> = {}
): { valid: boolean; errors: string[] } {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const errors: string[] = [];

  // 检查提示词长度
  if (params.prompt.length > cfg.maxPromptLength) {
    errors.push(`Prompt exceeds max length: ${params.prompt.length} > ${cfg.maxPromptLength}`);
  }

  if (params.negativePrompt.length > cfg.maxNegativePromptLength) {
    errors.push(
      `Negative prompt exceeds max length: ${params.negativePrompt.length} > ${cfg.maxNegativePromptLength}`
    );
  }

  // 检查宽高倍数
  if (params.width % cfg.dimensionMultiple !== 0) {
    errors.push(`Width ${params.width} is not a multiple of ${cfg.dimensionMultiple}`);
  }

  if (params.height % cfg.dimensionMultiple !== 0) {
    errors.push(`Height ${params.height} is not a multiple of ${cfg.dimensionMultiple}`);
  }

  // 检查像素预算
  const maxPixels = PIXEL_BUDGETS[cfg.pixelBudget];
  if (params.width * params.height > maxPixels) {
    errors.push(`Pixel count ${params.width * params.height} exceeds budget ${maxPixels}`);
  }

  // 检查批量数量
  if (params.batchSize < 1 || params.batchSize > cfg.maxBatchSize) {
    errors.push(`Batch size ${params.batchSize} out of range [1, ${cfg.maxBatchSize}]`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
