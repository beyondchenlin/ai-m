/**
 * 音频分块处理模块
 * 
 * 负责长文本的分块、时长计算和合并
 */

/** 分块配置 */
export interface ChunkingConfig {
  /** 最大文本长度（字符） */
  maxTextLength: number;
  /** 最大时长（秒） */
  maxDurationSeconds: number;
  /** 分块策略 */
  strategy: "sentence" | "paragraph" | "fixed";
  /** 重叠字符数（用于平滑过渡） */
  overlapChars: number;
  /** 预估语速（字符/秒） */
  estimatedCharsPerSecond: number;
}

/** 默认分块配置 */
const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  maxTextLength: 1000,
  maxDurationSeconds: 30,
  strategy: "sentence",
  overlapChars: 50,
  estimatedCharsPerSecond: 15, // 中文约 15 字/秒
};

/** 文本块 */
export interface TextChunk {
  /** 块索引 */
  index: number;
  /** 文本内容 */
  text: string;
  /** 预估时长（秒） */
  estimatedDuration: number;
  /** 起始位置（字符） */
  startOffset: number;
  /** 结束位置（字符） */
  endOffset: number;
}

/** 分块结果 */
export interface ChunkingResult {
  /** 文本块列表 */
  chunks: TextChunk[];
  /** 总预估时长（秒） */
  totalEstimatedDuration: number;
  /** 原始文本长度 */
  originalTextLength: number;
  /** 分块数量 */
  chunkCount: number;
}

/**
 * 按句子分块
 */
function chunkBySentence(
  text: string,
  config: ChunkingConfig
): TextChunk[] {
  const chunks: TextChunk[] = [];
  
  // 中文句子分隔符
  const sentenceDelimiters = /[。！？；\n]+/;
  const sentences = text.split(sentenceDelimiters).filter(s => s.trim().length > 0);
  
  let currentChunk = "";
  let currentOffset = 0;
  let chunkIndex = 0;
  
  for (const sentence of sentences) {
    const testChunk = currentChunk + sentence;
    const testLength = testChunk.length;
    const testDuration = testLength / config.estimatedCharsPerSecond;
    
    // 如果添加当前句子会超限，先保存当前块
    if (testLength > config.maxTextLength || testDuration > config.maxDurationSeconds) {
      if (currentChunk.length > 0) {
        chunks.push({
          index: chunkIndex++,
          text: currentChunk.trim(),
          estimatedDuration: currentChunk.length / config.estimatedCharsPerSecond,
          startOffset: currentOffset,
          endOffset: currentOffset + currentChunk.length,
        });
        
        currentOffset += currentChunk.length - config.overlapChars;
        currentChunk = currentChunk.slice(-config.overlapChars); // 保留重叠部分
      }
    }
    
    currentChunk += sentence;
  }
  
  // 保存最后一块
  if (currentChunk.length > 0) {
    chunks.push({
      index: chunkIndex,
      text: currentChunk.trim(),
      estimatedDuration: currentChunk.length / config.estimatedCharsPerSecond,
      startOffset: currentOffset,
      endOffset: currentOffset + currentChunk.length,
    });
  }
  
  return chunks;
}

/**
 * 按段落分块
 */
function chunkByParagraph(
  text: string,
  config: ChunkingConfig
): TextChunk[] {
  const chunks: TextChunk[] = [];
  
  // 段落分隔符
  const paragraphDelimiters = /\n\n+/;
  const paragraphs = text.split(paragraphDelimiters).filter(p => p.trim().length > 0);
  
  let currentChunk = "";
  let currentOffset = 0;
  let chunkIndex = 0;
  
  for (const paragraph of paragraphs) {
    const testChunk = currentChunk + "\n\n" + paragraph;
    const testLength = testChunk.length;
    const testDuration = testLength / config.estimatedCharsPerSecond;
    
    // 如果添加当前段落会超限，先保存当前块
    if (testLength > config.maxTextLength || testDuration > config.maxDurationSeconds) {
      if (currentChunk.length > 0) {
        chunks.push({
          index: chunkIndex++,
          text: currentChunk.trim(),
          estimatedDuration: currentChunk.length / config.estimatedCharsPerSecond,
          startOffset: currentOffset,
          endOffset: currentOffset + currentChunk.length,
        });
        
        currentOffset += currentChunk.length - config.overlapChars;
        currentChunk = currentChunk.slice(-config.overlapChars);
      }
    }
    
    currentChunk += (currentChunk.length > 0 ? "\n\n" : "") + paragraph;
  }
  
  // 保存最后一块
  if (currentChunk.length > 0) {
    chunks.push({
      index: chunkIndex,
      text: currentChunk.trim(),
      estimatedDuration: currentChunk.length / config.estimatedCharsPerSecond,
      startOffset: currentOffset,
      endOffset: currentOffset + currentChunk.length,
    });
  }
  
  return chunks;
}

/**
 * 按固定长度分块
 */
function chunkByFixedLength(
  text: string,
  config: ChunkingConfig
): TextChunk[] {
  const chunks: TextChunk[] = [];
  const chunkSize = config.maxTextLength;
  
  for (let i = 0; i < text.length; i += chunkSize - config.overlapChars) {
    const chunkText = text.slice(i, i + chunkSize);
    if (chunkText.trim().length === 0) continue;
    
    chunks.push({
      index: chunks.length,
      text: chunkText.trim(),
      estimatedDuration: chunkText.length / config.estimatedCharsPerSecond,
      startOffset: i,
      endOffset: i + chunkText.length,
    });
  }
  
  return chunks;
}

/**
 * 对文本进行分块
 */
export function chunkText(
  text: string,
  config: Partial<ChunkingConfig> = {}
): ChunkingResult {
  const cfg = { ...DEFAULT_CHUNKING_CONFIG, ...config };
  
  // 根据策略选择分块方法
  let chunks: TextChunk[];
  switch (cfg.strategy) {
    case "sentence":
      chunks = chunkBySentence(text, cfg);
      break;
    case "paragraph":
      chunks = chunkByParagraph(text, cfg);
      break;
    case "fixed":
      chunks = chunkByFixedLength(text, cfg);
      break;
    default:
      chunks = chunkBySentence(text, cfg);
  }
  
  // 重新编号
  chunks = chunks.map((chunk, idx) => ({
    ...chunk,
    index: idx,
  }));
  
  const totalEstimatedDuration = chunks.reduce(
    (sum, chunk) => sum + chunk.estimatedDuration,
    0
  );
  
  return {
    chunks,
    totalEstimatedDuration,
    originalTextLength: text.length,
    chunkCount: chunks.length,
  };
}

/**
 * 计算文本预估时长
 */
export function estimateTextDuration(
  text: string,
  charsPerSecond: number = 15
): number {
  return text.length / charsPerSecond;
}

/**
 * 验证分块配置
 */
export function validateChunkingConfig(
  config: Partial<ChunkingConfig>
): { valid: boolean; errors: string[] } {
  const cfg = { ...DEFAULT_CHUNKING_CONFIG, ...config };
  const errors: string[] = [];
  
  if (cfg.maxTextLength <= 0) {
    errors.push("maxTextLength 必须大于 0");
  }
  
  if (cfg.maxDurationSeconds <= 0) {
    errors.push("maxDurationSeconds 必须大于 0");
  }
  
  if (cfg.overlapChars < 0) {
    errors.push("overlapChars 必须 >= 0");
  }
  
  if (cfg.overlapChars >= cfg.maxTextLength) {
    errors.push("overlapChars 必须小于 maxTextLength");
  }
  
  if (cfg.estimatedCharsPerSecond <= 0) {
    errors.push("estimatedCharsPerSecond 必须大于 0");
  }
  
  if (!["sentence", "paragraph", "fixed"].includes(cfg.strategy)) {
    errors.push(`不支持的分块策略: ${cfg.strategy}`);
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * 合并音频块（生成合并指令）
 */
export function generateMergeInstructions(
  chunks: TextChunk[],
  outputFormat: "wav" | "mp3" = "wav"
): {
  chunkFiles: string[];
  mergeCommand: string;
  totalDuration: number;
} {
  const chunkFiles = chunks.map(
    (chunk, idx) => `chunk_${idx}.${outputFormat}`
  );
  
  // 生成 ffmpeg 合并命令
  const inputArgs = chunkFiles.map(f => `-i ${f}`).join(" ");
  const filterComplex = chunkFiles
    .map((_, idx) => `[${idx}:a]`)
    .join("");
  const filter = `${filterComplex}concat=n=${chunkFiles.length}:v=0:a=1[out]`;
  
  const mergeCommand = `ffmpeg ${inputArgs} -filter_complex "${filter}" -map "[out]" output.${outputFormat}`;
  
  const totalDuration = chunks.reduce(
    (sum, chunk) => sum + chunk.estimatedDuration,
    0
  );
  
  return {
    chunkFiles,
    mergeCommand,
    totalDuration,
  };
}
