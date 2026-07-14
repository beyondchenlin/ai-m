/** Deterministic narration chunking with exact source offsets. */
export interface ChunkingConfig {
  maxTextLength: number;
  maxDurationSeconds: number;
  strategy: "sentence" | "paragraph" | "fixed";
  /** Audio chunks must not overlap: overlap would repeat spoken words. */
  overlapChars: number;
  estimatedCharsPerSecond: number;
}

const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  maxTextLength: 1000,
  maxDurationSeconds: 30,
  strategy: "sentence",
  overlapChars: 0,
  estimatedCharsPerSecond: 15,
};

export interface TextChunk {
  index: number;
  text: string;
  estimatedDuration: number;
  startOffset: number;
  endOffset: number;
}

export interface ChunkingResult {
  chunks: TextChunk[];
  totalEstimatedDuration: number;
  originalTextLength: number;
  chunkCount: number;
}

function isSentenceBoundary(text: string, index: number): boolean {
  const char = text[index];
  if ("。！？!?；;\n".includes(char)) return true;
  if (char !== ".") return false;
  if (index > 0 && index + 1 < text.length && /\d/.test(text[index - 1]) && /\d/.test(text[index + 1])) return false;
  let start = index;
  while (start > 0 && /[A-Za-z]/.test(text[start - 1])) start--;
  return !new Set(["mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc"]).has(text.slice(start, index).toLowerCase());
}

function consumeClosers(text: string, index: number, limit: number): number {
  let cursor = index;
  while (cursor < limit && /["'”’）)\]} \t\r\n]/.test(text[cursor])) cursor++;
  return cursor;
}

function findBoundary(text: string, start: number, target: number, hardEnd: number, strategy: ChunkingConfig["strategy"]): number {
  if (strategy === "fixed") return hardEnd;
  if (strategy === "paragraph") {
    const paragraph = text.lastIndexOf("\n\n", hardEnd - 1);
    if (paragraph >= start && paragraph + 2 <= hardEnd) return paragraph + 2;
  }
  for (let i = hardEnd - 1; i >= target - 1; i--) if (isSentenceBoundary(text, i)) return consumeClosers(text, i + 1, hardEnd);
  for (let i = target - 2; i >= start; i--) if (isSentenceBoundary(text, i)) return consumeClosers(text, i + 1, hardEnd);
  return hardEnd;
}

export function validateChunkingConfig(config: Partial<ChunkingConfig>): { valid: boolean; errors: string[] } {
  const cfg = { ...DEFAULT_CHUNKING_CONFIG, ...config };
  const errors: string[] = [];
  if (!Number.isInteger(cfg.maxTextLength) || cfg.maxTextLength <= 0 || cfg.maxTextLength > 100_000) errors.push("maxTextLength must be an integer between 1 and 100000");
  if (!Number.isFinite(cfg.maxDurationSeconds) || cfg.maxDurationSeconds <= 0 || cfg.maxDurationSeconds > 3600) errors.push("maxDurationSeconds must be between 0 and 3600");
  if (cfg.overlapChars !== 0) errors.push("overlapChars must be 0 for audio narration to prevent repeated speech");
  if (!Number.isFinite(cfg.estimatedCharsPerSecond) || cfg.estimatedCharsPerSecond <= 0 || cfg.estimatedCharsPerSecond > 100) errors.push("estimatedCharsPerSecond must be between 0 and 100");
  if (!["sentence", "paragraph", "fixed"].includes(cfg.strategy)) errors.push(`Unsupported chunking strategy: ${cfg.strategy}`);
  return { valid: errors.length === 0, errors };
}

export function chunkText(text: string, config: Partial<ChunkingConfig> = {}): ChunkingResult {
  if (typeof text !== "string") throw new Error("Narration text must be a string");
  const cfg = { ...DEFAULT_CHUNKING_CONFIG, ...config };
  const validation = validateChunkingConfig(cfg);
  if (!validation.valid) throw new Error(validation.errors.join("; "));
  const source = text;
  if (!source.trim()) return { chunks: [], totalEstimatedDuration: 0, originalTextLength: source.length, chunkCount: 0 };
  const durationLimit = Math.max(1, Math.floor(cfg.maxDurationSeconds * cfg.estimatedCharsPerSecond));
  const hardLimit = Math.min(cfg.maxTextLength, durationLimit);
  const chunks: TextChunk[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const hardEnd = Math.min(cursor + hardLimit, source.length);
    const target = Math.min(cursor + Math.max(1, Math.floor(hardLimit * 0.7)), hardEnd);
    const end = hardEnd === source.length ? source.length : findBoundary(source, cursor, target, hardEnd, cfg.strategy);
    if (end <= cursor) throw new Error("Narration chunker made no forward progress");
    const raw = source.slice(cursor, end);
    if (raw.trim()) {
      chunks.push({
        index: chunks.length,
        text: raw.trim(),
        estimatedDuration: raw.trim().length / cfg.estimatedCharsPerSecond,
        startOffset: cursor,
        endOffset: end,
      });
    }
    cursor = end;
  }
  return {
    chunks,
    totalEstimatedDuration: chunks.reduce((sum, chunk) => sum + chunk.estimatedDuration, 0),
    originalTextLength: source.length,
    chunkCount: chunks.length,
  };
}

export function estimateTextDuration(text: string, charsPerSecond = 15): number {
  if (!Number.isFinite(charsPerSecond) || charsPerSecond <= 0) throw new Error("charsPerSecond must be positive");
  return text.length / charsPerSecond;
}

export function generateMergeInstructions(chunks: TextChunk[], outputFormat: "wav" | "mp3" = "wav"): {
  chunkFiles: string[];
  mergeCommand: string;
  argv: string[];
  totalDuration: number;
} {
  const chunkFiles = chunks.map((_, index) => `chunk_${index}.${outputFormat}`);
  const filter = `${chunkFiles.map((_, index) => `[${index}:a]`).join("")}concat=n=${chunkFiles.length}:v=0:a=1[out]`;
  const argv = chunkFiles.flatMap((file) => ["-i", file]).concat(["-filter_complex", filter, "-map", "[out]", `output.${outputFormat}`]);
  return {
    chunkFiles,
    mergeCommand: ["ffmpeg", ...argv.map((arg) => JSON.stringify(arg))].join(" "),
    argv,
    totalDuration: chunks.reduce((sum, chunk) => sum + chunk.estimatedDuration, 0),
  };
}
