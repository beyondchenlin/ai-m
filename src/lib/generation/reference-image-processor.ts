/**
 * Reference image contract.
 *
 * V2 generation never accepts an arbitrary host path. A reference must be an
 * already committed project artifact and is resolved through the durable job
 * ownership graph before it can be materialised for a backend.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { generationArtifacts, generationAttempts, generationJobs } from "@/lib/db/schema";

export interface ReferenceImageConfig {
  maxReferenceImages: number;
  allowedMimeTypes: string[];
  maxFileSizeBytes: number;
  defaultStrength: number;
  strengthRange: { min: number; max: number };
  supportsReferenceImages: boolean;
}

const DEFAULT_REFERENCE_CONFIG: ReferenceImageConfig = {
  maxReferenceImages: 3,
  allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
  maxFileSizeBytes: 10 * 1024 * 1024,
  defaultStrength: 0.7,
  strengthRange: { min: 0, max: 1 },
  supportsReferenceImages: true,
};

export type ReferenceSemanticType =
  | "identity" | "face" | "body" | "clothing" | "style" | "scene" | "prop"
  | "first_frame" | "last_frame" | "general";
export type ReferenceMode = "off" | "auto" | "forced";

export interface ReferenceImageInput {
  /** Preferred immutable reference. */
  artifactId?: string;
  /** Compatibility form: artifact ID or /api/generation/artifacts/{id}. */
  source?: string;
  strength?: number;
  semanticLabel?: string;
  semanticType?: ReferenceSemanticType;
}

export interface ProcessedReferenceImage {
  artifactId: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  strength: number;
  semanticLabel?: string;
  semanticType: ReferenceSemanticType;
}

function extractArtifactId(input: ReferenceImageInput): string {
  const raw = input.artifactId ?? input.source;
  if (!raw || typeof raw !== "string") throw new Error("Reference image requires artifactId");
  const match = raw.match(/^\/api\/generation\/artifacts\/([A-Za-z0-9._:-]+)$/);
  const value = match?.[1] ?? raw;
  if (!/^[A-Za-z0-9._:-]{1,180}$/.test(value)) {
    throw new Error("Reference image source must be a committed artifact ID, not a host file path or URL");
  }
  return value;
}

async function loadAuthorizedReference(
  artifactId: string,
  projectId: string,
): Promise<typeof generationArtifacts.$inferSelect> {
  const [row] = await db.select({ artifact: generationArtifacts, projectId: generationJobs.projectId })
    .from(generationArtifacts)
    .innerJoin(generationAttempts, eq(generationAttempts.id, generationArtifacts.attemptId))
    .innerJoin(generationJobs, eq(generationJobs.id, generationAttempts.jobId))
    .where(eq(generationArtifacts.id, artifactId));
  if (!row || row.artifact.status !== "COMMITTED") throw new Error("Reference artifact is missing or not committed");
  if (row.projectId !== projectId) {
    throw new Error("Reference artifact is not accessible to this project");
  }
  return row.artifact;
}

async function processSingleReferenceImage(
  input: ReferenceImageInput,
  config: ReferenceImageConfig,
  projectId: string,
): Promise<ProcessedReferenceImage> {
  const artifactId = extractArtifactId(input);
  const artifact = await loadAuthorizedReference(artifactId, projectId);
  if (!config.allowedMimeTypes.includes(artifact.mimeType)) throw new Error(`Reference artifact MIME type is not allowed: ${artifact.mimeType}`);
  if (artifact.sizeBytes <= 0 || artifact.sizeBytes > config.maxFileSizeBytes) throw new Error("Reference artifact size is outside the allowed range");
  if (!/^[0-9a-f]{64}$/i.test(artifact.sha256)) throw new Error("Reference artifact digest is invalid");
  const strength = Math.max(config.strengthRange.min, Math.min(config.strengthRange.max, input.strength ?? config.defaultStrength));
  return {
    artifactId,
    sha256: artifact.sha256,
    sizeBytes: artifact.sizeBytes,
    mimeType: artifact.mimeType,
    strength,
    semanticLabel: input.semanticLabel,
    semanticType: input.semanticType ?? "general",
  };
}

export async function processReferenceImages(
  inputs: ReferenceImageInput[],
  config: Partial<ReferenceImageConfig> = {},
  projectId: string,
): Promise<ProcessedReferenceImage[]> {
  const cfg = { ...DEFAULT_REFERENCE_CONFIG, ...config };
  const validation = validateReferenceConfig(cfg);
  if (!validation.valid) throw new Error(validation.errors.join("; "));
  if (!cfg.supportsReferenceImages && inputs.length > 0) throw new Error("The selected profile does not support reference images");
  if (inputs.length > cfg.maxReferenceImages) throw new Error(`Too many reference images: ${inputs.length} > ${cfg.maxReferenceImages}`);
  const seen = new Set<string>();
  const result: ProcessedReferenceImage[] = [];
  for (const input of inputs) {
    const processed = await processSingleReferenceImage(input, cfg, projectId);
    if (seen.has(processed.artifactId)) continue;
    seen.add(processed.artifactId);
    result.push(processed);
  }
  return result;
}

export function validateReferenceConfig(config: Partial<ReferenceImageConfig>): { valid: boolean; errors: string[] } {
  const cfg = { ...DEFAULT_REFERENCE_CONFIG, ...config };
  const errors: string[] = [];
  if (!Number.isInteger(cfg.maxReferenceImages) || cfg.maxReferenceImages < 0 || cfg.maxReferenceImages > 20) errors.push("maxReferenceImages must be an integer between 0 and 20");
  if (!Number.isSafeInteger(cfg.maxFileSizeBytes) || cfg.maxFileSizeBytes <= 0) errors.push("maxFileSizeBytes must be a positive safe integer");
  if (!Number.isFinite(cfg.strengthRange.min) || !Number.isFinite(cfg.strengthRange.max) || cfg.strengthRange.min >= cfg.strengthRange.max) errors.push("strengthRange.min must be less than strengthRange.max");
  if (!Number.isFinite(cfg.defaultStrength) || cfg.defaultStrength < cfg.strengthRange.min || cfg.defaultStrength > cfg.strengthRange.max) errors.push("defaultStrength is outside strengthRange");
  if (!Array.isArray(cfg.allowedMimeTypes) || cfg.allowedMimeTypes.length === 0) errors.push("allowedMimeTypes cannot be empty");
  return { valid: errors.length === 0, errors };
}
