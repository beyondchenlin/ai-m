import { spawn } from "node:child_process";

export class MediaProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaProbeError";
  }
}

interface ProbeLimits {
  timeoutMs?: number;
  maxDurationMs?: number;
}

export interface AudioMetadata {
  durationMs: number;
  sampleRate: number;
  channels: number;
  codecName: string;
}

function validateLimits(options: ProbeLimits): { timeoutMs: number; maxDurationMs: number } {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxDurationMs = options.maxDurationMs ?? 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new MediaProbeError("Invalid ffprobe timeout");
  }
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs <= 0) {
    throw new MediaProbeError("Invalid media duration limit");
  }
  return { timeoutMs, maxDurationMs };
}

async function runFfprobe(args: string[], timeoutMs: number): Promise<string> {
  const binary = process.env.FFPROBE_PATH?.trim() || "ffprobe";
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let timedOut = false;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > 64 * 1024) {
        child.kill("SIGKILL");
        finish(() => reject(new MediaProbeError("ffprobe output exceeded the safe limit")));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", () => {
      // Drain stderr without persisting paths, model names, or user content.
    });
    child.once("error", (error) => {
      finish(() => reject(new MediaProbeError(`ffprobe is unavailable: ${error.message}`)));
    });
    child.once("close", (code) => {
      finish(() => {
        if (timedOut) {
          reject(new MediaProbeError(`ffprobe timed out after ${timeoutMs}ms`));
        } else if (code !== 0) {
          reject(new MediaProbeError(`ffprobe failed with exit code ${code ?? "unknown"}`));
        } else {
          try {
            resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdoutChunks, stdoutBytes)));
          } catch {
            reject(new MediaProbeError("ffprobe output was not valid UTF-8"));
          }
        }
      });
    });
  });
}

function durationFromSeconds(value: unknown, maxDurationMs: number): number {
  const seconds = typeof value === "string" || typeof value === "number"
    ? Number.parseFloat(String(value))
    : Number.NaN;
  const durationMs = Math.round(seconds * 1000);
  if (!Number.isFinite(seconds) || durationMs <= 0 || durationMs > maxDurationMs) {
    throw new MediaProbeError("ffprobe returned an invalid duration");
  }
  return durationMs;
}

export async function probeMediaDurationMs(
  filePath: string,
  options: ProbeLimits = {},
): Promise<number> {
  const { timeoutMs, maxDurationMs } = validateLimits(options);
  const output = await runFfprobe([
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ], timeoutMs);
  return durationFromSeconds(output.trim(), maxDurationMs);
}

export async function probeAudioMetadata(
  filePath: string,
  options: ProbeLimits = {},
): Promise<AudioMetadata> {
  const { timeoutMs, maxDurationMs } = validateLimits(options);
  const output = await runFfprobe([
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=codec_name,sample_rate,channels,duration:format=duration",
    "-of", "json",
    filePath,
  ], timeoutMs);

  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    throw new MediaProbeError("ffprobe returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MediaProbeError("ffprobe returned an invalid audio descriptor");
  }
  const descriptor = parsed as { streams?: unknown; format?: unknown };
  if (!Array.isArray(descriptor.streams) || descriptor.streams.length !== 1) {
    throw new MediaProbeError("Reference media must contain exactly one readable audio stream");
  }
  const stream = descriptor.streams[0];
  if (!stream || typeof stream !== "object" || Array.isArray(stream)) {
    throw new MediaProbeError("ffprobe returned an invalid audio stream");
  }
  const audio = stream as Record<string, unknown>;
  const sampleRate = Number.parseInt(String(audio.sample_rate ?? ""), 10);
  const channels = Number.parseInt(String(audio.channels ?? ""), 10);
  const codecName = typeof audio.codec_name === "string" ? audio.codec_name.trim() : "";
  const format = descriptor.format && typeof descriptor.format === "object" && !Array.isArray(descriptor.format)
    ? descriptor.format as Record<string, unknown>
    : {};
  const durationMs = durationFromSeconds(format.duration ?? audio.duration, maxDurationMs);
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000) {
    throw new MediaProbeError("Reference audio sample rate is unsupported");
  }
  if (!Number.isSafeInteger(channels) || channels < 1 || channels > 8) {
    throw new MediaProbeError("Reference audio channel count is unsupported");
  }
  if (!codecName || codecName.length > 80) {
    throw new MediaProbeError("Reference audio codec is unavailable");
  }
  return { durationMs, sampleRate, channels, codecName };
}
