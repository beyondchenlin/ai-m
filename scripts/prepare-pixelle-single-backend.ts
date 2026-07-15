import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyPreparedGenerationPackage } from "./verify-generation-package";
import {
  appendPixelleGcAudit,
  getPixelleGcAuditEntries,
  productionPixelleGcAuditAnchor,
  recoverPixelleGcAuditJournal,
  type AuditDurabilityEvent,
  type AuditRecoveryDurabilityEvent,
  type SqlitePixelleGcAuditAnchor,
  verifyPixelleGcAuditChain,
} from "./pixelle-gc-audit";
import { canonicalize, sha256 } from "../src/lib/generation/workflows/canonical";
import { compileWorkflowBindings } from "../src/lib/generation/workflows/compiler";
import { parseWorkflowManifest } from "../src/lib/generation/workflows/manifest";
import { normalizeComfyWorkflow } from "../src/lib/generation/workflows/normalize";
import { parseWorkflowPackageLock, verifyLockedFiles } from "../src/lib/generation/workflows/package-lock";
import { applyStaticPolicy, validateWorkflowStructure } from "../src/lib/generation/workflows/validator";
import type { AuthorBinding, AuthorOutput, ComfyWorkflow, WorkflowManifest } from "../src/lib/generation/workflows/types";
import { comparePixelleProcessIdentity, getPixelleProcessIdentity, getPixelleProcessLiveness } from "./pixelle-process-identity";

export interface PrepareOptions {
  pixelleRoot: string;
  stagingDir: string;
  nowMs?: number;
  lockStaleMs?: number;
  isProcessAlive?: (pid: number) => Promise<boolean | "unknown">;
  afterLockAcquired?: () => Promise<void>;
  afterSourceFileRead?: (sourceFile: string, index: number) => Promise<void>;
  writeBytes?: typeof fs.writeFile;
  writeInitMarker?: typeof fs.writeFile;
  renameInitDir?: typeof fs.rename;
  afterDurabilityEvent?: (event: "generation-payload" | "generations-directory" | "current-file" | "staging-directory") => Promise<void>;
  maxGenerations?: number;
  maxOrphanTemps?: number;
  maxStagingBytes?: number;
  minimumFreeBytes?: number;
  getAvailableBytes?: (directory: string) => Promise<number>;
  getProcessIdentity?: (pid: number) => Promise<string | "missing" | "unknown">;
}

interface PreparedPackage {
  sourceFile: string;
  packageName: string;
  workflowId: string;
  packageDigest: string;
  requirements: WorkflowManifest["requirements"];
}

export interface PrepareResult {
  packages: PreparedPackage[];
  state: "prepared-environment-unverified";
  generationDigest: string;
  orphanTempCount: number;
  durability: { fileFsync: true; directoryFsync: boolean };
}

export interface GarbageCollectOptions {
  stagingDir: string;
  generationDigest: string;
  confirmGenerationDigest: string;
  actor: string;
  getProcessIdentity?: PrepareOptions["getProcessIdentity"];
  auditKey?: Buffer;
  auditAnchor?: SqlitePixelleGcAuditAnchor;
  renameGeneration?: typeof fs.rename;
  afterAuditDurabilityEvent?: (phase: "intent" | "committed", event: AuditDurabilityEvent) => Promise<void>;
  afterAuditRecoveryDurabilityEvent?: (event: AuditRecoveryDurabilityEvent) => Promise<void>;
}

const STAGING_MARKER_FILENAME = ".ai-m-pixelle-staging.json";
const STAGING_MARKER_PRODUCER = "ai-m/pixelle-single-backend";
const STAGING_MARKER_SCHEMA_VERSION = 2;
const TEMP_MARKER_FILENAME = ".ai-m-generation-temp.json";
const MAX_WORKFLOW_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_WORKFLOW_BYTES = 30 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const DEFAULT_LOCK_STALE_MS = 15 * 60 * 1000;
const DEFAULT_MAX_GENERATIONS = 32;
const DEFAULT_MAX_ORPHAN_TEMPS = 16;
const DEFAULT_MAX_STAGING_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_MINIMUM_FREE_BYTES = 256 * 1024 * 1024;

interface CandidateDefinition {
  sourceFile: string;
  packageName: string;
  workflowId: string;
  displayName: string;
  capability: WorkflowManifest["capability"];
  requiredNodeClasses: string[];
  bindings(workflow: ComfyWorkflow): AuthorBinding[];
  output: AuthorOutput;
  models(workflow: ComfyWorkflow): WorkflowManifest["requirements"]["models"];
  referenceModes: WorkflowManifest["requirements"]["referenceModes"];
  limits: WorkflowManifest["limits"];
}

const selector = (classType: string, metaTitle: string) => ({ classType, metaTitle });

const textBinding = (key: string, classType: string, metaTitle: string, inputName: string, options: Partial<AuthorBinding> = {}): AuthorBinding => ({
  key,
  selector: selector(classType, metaTitle),
  inputName,
  valueType: "string",
  source: "request",
  required: true,
  userOverride: true,
  ...options,
});

const numericBinding = (
  key: string,
  classType: string,
  metaTitle: string,
  inputName: string,
  valueType: "integer" | "number",
  defaultValue: number | undefined,
  minimum: number,
  maximum: number,
  step?: number,
): AuthorBinding => ({
  key,
  selector: selector(classType, metaTitle),
  inputName,
  valueType,
  source: "request",
  required: defaultValue === undefined,
  userOverride: true,
  ...(defaultValue === undefined ? {} : { default: defaultValue }),
  minimum,
  maximum,
  ...(step === undefined ? {} : { step }),
});

const voiceReferenceBinding = (): AuthorBinding => ({
  key: "voiceReference",
  selector: selector("VHS_LoadAudioUpload", "$ref_audio.~audio!"),
  inputName: "audio",
  valueType: "audio",
  source: "voice-reference",
  required: true,
  userOverride: false,
});

const speechLimits: WorkflowManifest["limits"] = {
  maxPromptChars: 100_000,
  maxPixels: 1,
  maxBatch: 1,
  maxOutputs: 1,
  maxJobMs: 1_800_000,
  maxOutputBytes: 536_870_912,
};

const visualLimits: WorkflowManifest["limits"] = {
  maxPromptChars: 20_000,
  maxPixels: 4_194_304,
  maxBatch: 1,
  maxOutputs: 1,
  maxJobMs: 1_800_000,
  maxOutputBytes: 2_147_483_648,
};

function loaderModel(workflow: ComfyWorkflow, classType: string, inputName: string, folder: string) {
  const matches = Object.values(workflow).filter((node) => node.class_type === classType);
  if (matches.length !== 1) throw new Error(`${classType} model mapping requires exactly one node; found ${matches.length}`);
  const filename = matches[0].inputs[inputName];
  if (typeof filename !== "string" || !filename.trim()) throw new Error(`${classType}.${inputName} must name a model file`);
  return { folder, filename };
}

function numericInputDefault(workflow: ComfyWorkflow, classType: string, metaTitle: string, inputName: string): number {
  const matches = Object.values(workflow).filter((node) => node.class_type === classType && node._meta?.title === metaTitle);
  if (matches.length !== 1) throw new Error(`${classType}/${metaTitle} default requires exactly one node; found ${matches.length}`);
  const value = matches[0].inputs[inputName];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${classType}/${metaTitle}.${inputName} must have a numeric default`);
  return value;
}

function omniBindings(workflow: ComfyWorkflow, nodeClass: string, nodeTitle: string, includeDuration: boolean): AuthorBinding[] {
  return [
    textBinding("text", "PrimitiveStringMultiline", "$text.value!", "value"),
    voiceReferenceBinding(),
    textBinding("referenceText", "PrimitiveStringMultiline", "$reference_audio_text.value", "value", {
      required: false,
      default: "",
    }),
    numericBinding("speed", nodeClass, nodeTitle, "speed", "number", numericInputDefault(workflow, nodeClass, nodeTitle, "speed"), 0.5, 2),
    ...(includeDuration ? [numericBinding("duration", "PixelleDurationInput", "$duration.value", "value", "number", numericInputDefault(workflow, "PixelleDurationInput", "$duration.value", "value"), 0.5, 60, 0.5)] : []),
  ];
}

const candidates: CandidateDefinition[] = [
  {
    sourceFile: "tts_index2.json",
    packageName: "tts-index2",
    workflowId: "pixelle.tts.index2",
    displayName: "Pixelle IndexTTS2",
    capability: "speech",
    requiredNodeClasses: ["PrimitiveStringMultiline", "VHS_LoadAudioUpload", "IndexTTS2BaseNode", "IndexTTS2CacheControlNode", "SaveAudio"],
    bindings: () => [textBinding("text", "PrimitiveStringMultiline", "$text.value!", "value"), voiceReferenceBinding()],
    output: { key: "audio", selector: selector("SaveAudio", "Save Audio (FLAC)"), field: "audio", mediaKind: "audio", maxItems: 1 },
    models: () => [],
    referenceModes: ["required"],
    limits: speechLimits,
  },
  {
    sourceFile: "tts_index2_8g.json",
    packageName: "tts-index2-8g",
    workflowId: "pixelle.tts.index2-8g",
    displayName: "Pixelle IndexTTS2 8G",
    capability: "speech",
    requiredNodeClasses: ["PrimitiveStringMultiline", "VHS_LoadAudioUpload", "IndexTTS2BaseNode", "IndexTTS2CacheControlNode", "SaveAudio"],
    bindings: () => [textBinding("text", "PrimitiveStringMultiline", "$text.value!", "value"), voiceReferenceBinding()],
    output: { key: "audio", selector: selector("SaveAudio", "Save Audio (FLAC)"), field: "audio", mediaKind: "audio", maxItems: 1 },
    models: () => [],
    referenceModes: ["required"],
    limits: speechLimits,
  },
  {
    sourceFile: "tts_omnivoice_longform_bf16.json",
    packageName: "tts-omnivoice-longform-bf16",
    workflowId: "pixelle.tts.omnivoice-longform-bf16",
    displayName: "Pixelle OmniVoice Longform BF16",
    capability: "speech",
    requiredNodeClasses: ["PrimitiveStringMultiline", "VHS_LoadAudioUpload", "OmniVoiceLongformTTS", "OmniVoiceWhisperLoader", "SaveAudio"],
    bindings: (workflow) => omniBindings(workflow, "OmniVoiceLongformTTS", "OmniVoice Longform TTS", false),
    output: { key: "audio", selector: selector("SaveAudio", "Save Audio (FLAC)"), field: "audio", mediaKind: "audio", maxItems: 1 },
    models: () => [],
    referenceModes: ["required"],
    limits: speechLimits,
  },
  {
    sourceFile: "tts_omnivoice_clone_duration_bf16.json",
    packageName: "tts-omnivoice-clone-duration-bf16",
    workflowId: "pixelle.tts.omnivoice-clone-duration-bf16",
    displayName: "Pixelle OmniVoice Clone Duration BF16",
    capability: "speech",
    requiredNodeClasses: ["PrimitiveStringMultiline", "VHS_LoadAudioUpload", "OmniVoiceVoiceCloneTTS", "PixelleDurationInput", "SaveAudio"],
    bindings: (workflow) => omniBindings(workflow, "OmniVoiceVoiceCloneTTS", "OmniVoice Voice Clone TTS", true),
    output: { key: "audio", selector: selector("SaveAudio", "Save Audio (FLAC)"), field: "audio", mediaKind: "audio", maxItems: 1 },
    models: () => [],
    referenceModes: ["required"],
    limits: speechLimits,
  },
  {
    sourceFile: "image_z_image_turbo.json",
    packageName: "image-z-image-turbo",
    workflowId: "pixelle.image.z-image-turbo",
    displayName: "Pixelle Z-Image Turbo",
    capability: "image",
    requiredNodeClasses: ["PrimitiveStringMultiline", "easy int", "KSampler", "UNETLoader", "CLIPLoader", "VAELoader", "SaveImage"],
    bindings: (workflow) => [
      textBinding("prompt", "PrimitiveStringMultiline", "$prompt.value!", "value"),
      numericBinding("width", "easy int", "$width.value", "value", "integer", numericInputDefault(workflow, "easy int", "$width.value", "value"), 256, 2_048),
      numericBinding("height", "easy int", "$height.value", "value", "integer", numericInputDefault(workflow, "easy int", "$height.value", "value"), 256, 2_048),
      numericBinding("seed", "KSampler", "KSampler", "seed", "integer", numericInputDefault(workflow, "KSampler", "KSampler", "seed"), 0, Number.MAX_SAFE_INTEGER),
    ],
    output: { key: "image", selector: selector("SaveImage", "Save Image"), field: "images", mediaKind: "image", maxItems: 1 },
    models: (workflow) => [
      loaderModel(workflow, "UNETLoader", "unet_name", "diffusion_models"),
      loaderModel(workflow, "CLIPLoader", "clip_name", "text_encoders"),
      loaderModel(workflow, "VAELoader", "vae_name", "vae"),
    ],
    referenceModes: ["off"],
    limits: visualLimits,
  },
  {
    sourceFile: "video_wan2.1_fusionx.json",
    packageName: "video-wan2.1-fusionx",
    workflowId: "pixelle.video.wan2.1-fusionx",
    displayName: "Pixelle Wan 2.1 FusionX",
    capability: "video",
    requiredNodeClasses: ["PrimitiveStringMultiline", "easy int", "KSampler", "UNETLoader", "CLIPLoader", "VAELoader", "VHS_VideoCombine"],
    bindings: (workflow) => [
      textBinding("prompt", "PrimitiveStringMultiline", "$prompt.value!", "value"),
      numericBinding("width", "easy int", "$width.value", "value", "integer", numericInputDefault(workflow, "easy int", "$width.value", "value"), 256, 2_048),
      numericBinding("height", "easy int", "$height.value", "value", "integer", numericInputDefault(workflow, "easy int", "$height.value", "value"), 256, 2_048),
      numericBinding("seed", "KSampler", "KSampler", "seed", "integer", numericInputDefault(workflow, "KSampler", "KSampler", "seed"), 0, Number.MAX_SAFE_INTEGER),
    ],
    // VideoHelperSuite writes this UI history payload under `gifs`, including MP4 files.
    output: { key: "video", selector: selector("VHS_VideoCombine", "Video Combine \u{1F3A5}\u{1F165}\u{1F157}\u{1F162}"), field: "gifs", mediaKind: "video", maxItems: 1 },
    models: (workflow) => [
      loaderModel(workflow, "UNETLoader", "unet_name", "diffusion_models"),
      loaderModel(workflow, "CLIPLoader", "clip_name", "text_encoders"),
      loaderModel(workflow, "VAELoader", "vae_name", "vae"),
    ],
    referenceModes: ["off"],
    limits: visualLimits,
  },
];

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function lstatOrNull(target: string) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function stagingMarker(canonicalStagingPath: string) {
  return {
    schemaVersion: STAGING_MARKER_SCHEMA_VERSION,
    producer: STAGING_MARKER_PRODUCER,
    canonicalStagingPath,
  };
}

async function assertOwnedStaging(directory: string, canonicalStagingPath: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Existing staging is not a safe owned directory");
  const markerPath = path.join(directory, STAGING_MARKER_FILENAME);
  const markerStat = await lstatOrNull(markerPath);
  if (!markerStat || !markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new Error("Existing staging is unmanaged: a valid ownership marker is required");
  }
  let marker: unknown;
  try {
    marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  } catch {
    throw new Error("Existing staging ownership marker is invalid");
  }
  const expected = stagingMarker(canonicalStagingPath);
  if (!isRecord(marker)
    || Object.keys(marker).sort().join(",") !== Object.keys(expected).sort().join(",")
    || marker.schemaVersion !== expected.schemaVersion
    || marker.producer !== expected.producer
    || marker.canonicalStagingPath !== expected.canonicalStagingPath) {
    throw new Error("Existing staging ownership marker does not match the canonical staging path");
  }
}

async function assertNoSymlinkComponents(target: string, label: string): Promise<void> {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`${label} must not contain a symbolic link or junction`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

interface SourceIdentity {
  sourceFile: string;
  sourcePath: string;
  realPath: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

function sameIdentity(stat: { dev: number; ino: number; size: number; mtimeMs: number }, identity: SourceIdentity): boolean {
  return stat.dev === identity.dev && stat.ino === identity.ino && stat.size === identity.size && stat.mtimeMs === identity.mtimeMs;
}

function assertJsonDepth(bytes: Buffer, sourceFile: string): void {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const byte of bytes) {
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) inString = false;
      continue;
    }
    if (byte === 0x22) inString = true;
    else if (byte === 0x7b || byte === 0x5b) {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) throw new Error(`${sourceFile} exceeds the JSON depth limit of ${MAX_JSON_DEPTH}`);
    } else if (byte === 0x7d || byte === 0x5d) depth -= 1;
  }
}

async function snapshotSources(
  workflowDir: string,
  afterRead: PrepareOptions["afterSourceFileRead"],
): Promise<Map<string, Buffer>> {
  const identities: SourceIdentity[] = [];
  let totalSize = 0;
  for (const definition of candidates) {
    const sourcePath = path.resolve(workflowDir, definition.sourceFile);
    if (path.dirname(sourcePath) !== workflowDir) throw new Error(`Source workflow escapes workflows/selfhost: ${definition.sourceFile}`);
    const stat = await fs.lstat(sourcePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Source workflow must be a regular file without links: ${definition.sourceFile}`);
    const realPath = await fs.realpath(sourcePath);
    if (path.dirname(realPath) !== workflowDir) throw new Error(`Source workflow escapes workflows/selfhost: ${definition.sourceFile}`);
    if (stat.size > MAX_WORKFLOW_BYTES) throw new Error(`${definition.sourceFile} exceeds the 5 MiB size limit`);
    totalSize += stat.size;
    if (totalSize > MAX_TOTAL_WORKFLOW_BYTES) throw new Error("Workflow source snapshot exceeds the total size limit");
    identities.push({ sourceFile: definition.sourceFile, sourcePath, realPath, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  const result = new Map<string, Buffer>();
  for (let index = 0; index < identities.length; index += 1) {
    const identity = identities[index];
    const handle = await fs.open(identity.sourcePath, "r");
    try {
      const before = await handle.stat();
      if (!sameIdentity(before, identity)) throw new Error(`Source snapshot changed: ${identity.sourceFile}`);
      const buffer = Buffer.alloc(identity.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== identity.size) throw new Error(`Source snapshot changed: ${identity.sourceFile}`);
      await afterRead?.(identity.sourceFile, index);
      const after = await handle.stat();
      if (!sameIdentity(after, identity)) throw new Error(`Source snapshot changed: ${identity.sourceFile}`);
      result.set(identity.sourceFile, buffer.subarray(0, identity.size));
    } finally {
      await handle.close();
    }
  }
  for (const identity of identities) {
    const finalStat = await fs.lstat(identity.sourcePath);
    const finalRealPath = await fs.realpath(identity.sourcePath);
    if (finalStat.isSymbolicLink() || !sameIdentity(finalStat, identity) || finalRealPath !== identity.realPath) {
      throw new Error(`Source snapshot changed: ${identity.sourceFile}`);
    }
  }
  return result;
}

function readApiWorkflow(bytes: Buffer, definition: CandidateDefinition): ComfyWorkflow {
  assertJsonDepth(bytes, definition.sourceFile);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`${definition.sourceFile} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || "nodes" in raw) {
    throw new Error(`${definition.sourceFile} must be a real ComfyUI API graph keyed by numeric node IDs`);
  }
  const structure = validateWorkflowStructure(raw as Record<string, unknown>);
  const policy = applyStaticPolicy(raw as Record<string, unknown>);
  const errors = [...structure.errors, ...policy.errors];
  if (errors.length) throw new Error(`${definition.sourceFile} is not a safe API graph: ${errors.join("; ")}`);
  const workflow = normalizeComfyWorkflow(raw);
  const actualClasses = new Set(Object.values(workflow).map((item) => item.class_type));
  const missing = definition.requiredNodeClasses.filter((classType) => !actualClasses.has(classType));
  if (missing.length) throw new Error(`${definition.sourceFile} is missing required node class(es): ${missing.join(", ")}`);
  return workflow;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalize(value)}\n`, "utf8");
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeManifest(definition: CandidateDefinition, workflow: ComfyWorkflow): WorkflowManifest {
  const manifest = {
    schemaVersion: 1,
    workflowId: definition.workflowId,
    version: "1.0.0",
    displayName: definition.displayName,
    capability: definition.capability,
    workflowFile: "workflow.api.json",
    bindings: definition.bindings(workflow),
    outputs: [definition.output],
    requirements: {
      nodeClasses: [...new Set(Object.values(workflow).map((item) => item.class_type))].sort(),
      models: definition.models(workflow),
      referenceModes: definition.referenceModes,
    },
    limits: definition.limits,
  } satisfies WorkflowManifest;
  return parseWorkflowManifest(manifest);
}

function lockRecord(pid: number, processIdentity: string, token: string, startedAtMs: number) {
  return { schemaVersion: 2, pid, processIdentity, token, startedAtMs };
}

function parseLock(value: unknown): ReturnType<typeof lockRecord> {
  if (!isRecord(value) || value.schemaVersion !== 2 || !Number.isInteger(value.pid) || (value.pid as number) <= 0
    || typeof value.processIdentity !== "string" || !/^[A-Za-z0-9._:-]{3,300}$/.test(value.processIdentity)
    || typeof value.token !== "string" || !/^[a-f0-9]{32}$/.test(value.token)
    || !Number.isFinite(value.startedAtMs)) throw new Error("prepare.lock is invalid; lock ownership is uncertain");
  return lockRecord(value.pid as number, value.processIdentity, value.token, value.startedAtMs as number);
}

let ownProcessIdentity: Promise<string | "missing" | "unknown"> | undefined;

function processIdentityFor(pid: number, options: PrepareOptions): Promise<string | "missing" | "unknown"> {
  if (options.getProcessIdentity) return options.getProcessIdentity(pid);
  if (pid !== process.pid) return getPixelleProcessIdentity(pid);
  ownProcessIdentity ??= getPixelleProcessIdentity(pid);
  return ownProcessIdentity;
}

async function acquireLock(stagingDir: string, options: PrepareOptions, token: string): Promise<void> {
  const lockPath = path.join(stagingDir, "prepare.lock");
  const nowMs = options.nowMs ?? Date.now();
  const staleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  if (!Number.isFinite(staleMs) || staleMs < 1_000) throw new Error("lockStaleMs must be at least 1000");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const identity = await processIdentityFor(process.pid, options);
      if (identity === "unknown" || identity === "missing") throw new Error("Cannot establish process creation/boot identity; manual recovery audit is required");
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(jsonBytes(lockRecord(process.pid, identity, token, nowMs)));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let raw: Buffer;
    let existing: ReturnType<typeof lockRecord>;
    try {
      raw = await fs.readFile(lockPath);
      if (raw.length > 4_096) throw new Error("prepare.lock is too large");
      existing = parseLock(JSON.parse(raw.toString("utf8")));
    } catch (error) {
      throw new Error(`Staging is locked and lock ownership is uncertain: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (nowMs - existing.startedAtMs <= staleMs) throw new Error("Staging is locked by an active prepare.lock");
    const alive = await (options.isProcessAlive ?? getPixelleProcessLiveness)(existing.pid);
    if (alive === "unknown") throw new Error("Staging is locked because process liveness is uncertain");
    if (alive === true) {
      const identity = await processIdentityFor(existing.pid, options);
      if (identity === "unknown" || identity === "missing") throw new Error("Staging lock identity is uncertain; manual recovery audit is required");
      const sameIdentity = comparePixelleProcessIdentity(existing.processIdentity, identity, existing.pid);
      if (sameIdentity === "unknown") throw new Error("Staging lock uses an unsupported legacy process identity; manual recovery audit is required");
      if (sameIdentity) throw new Error("Staging is locked by the original live process");
    }
    const currentRaw = await fs.readFile(lockPath);
    const current = parseLock(JSON.parse(currentRaw.toString("utf8")));
    if (current.token !== existing.token || !currentRaw.equals(raw)) throw new Error("Staging lock changed during stale-lock recovery");
    await fs.rename(lockPath, path.join(stagingDir, `prepare.lock.stale.${existing.token}`));
  }
  throw new Error("Staging is locked");
}

async function releaseLock(stagingDir: string, token: string): Promise<void> {
  const lockPath = path.join(stagingDir, "prepare.lock");
  try {
    const current = parseLock(JSON.parse(await fs.readFile(lockPath, "utf8")));
    if (current.token === token) await fs.unlink(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
}

async function assertLockOwned(stagingDir: string, token: string): Promise<void> {
  let current: ReturnType<typeof lockRecord>;
  try {
    current = parseLock(JSON.parse(await fs.readFile(path.join(stagingDir, "prepare.lock"), "utf8")));
  } catch {
    throw new Error("prepare.lock ownership was lost");
  }
  if (current.token !== token) throw new Error("prepare.lock ownership was lost");
}

async function assertNoInitOrphans(stagingDir: string): Promise<void> {
  const prefix = `.${path.basename(stagingDir)}.init-`;
  const orphans = (await fs.readdir(path.dirname(stagingDir))).filter((name) => name.startsWith(prefix));
  if (orphans.length) throw new Error(`Staging init orphan requires manual review: ${orphans.sort().join(", ")}`);
}

async function cleanupCurrentInitDirectory(initDir: string, stagingDir: string, token: string): Promise<void> {
  if (path.dirname(initDir) !== path.dirname(stagingDir) || path.basename(initDir) !== `.${path.basename(stagingDir)}.init-${token}`) {
    throw new Error("Init cleanup ownership check failed");
  }
  const stat = await fs.lstat(initDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Init cleanup found an unsafe entry");
  const entries = (await fs.readdir(initDir)).sort();
  const unknown = entries.filter((name) => name !== STAGING_MARKER_FILENAME && name !== "generations");
  if (unknown.length) throw new Error(`Init cleanup found unfamiliar content: ${unknown.join(", ")}`);
  if (entries.includes("generations")) {
    const generationsDir = path.join(initDir, "generations");
    const generationsStat = await fs.lstat(generationsDir);
    if (!generationsStat.isDirectory() || generationsStat.isSymbolicLink() || (await fs.readdir(generationsDir)).length) {
      throw new Error("Init cleanup found an unsafe generations directory");
    }
    await fs.rmdir(generationsDir);
  }
  if (entries.includes(STAGING_MARKER_FILENAME)) {
    await assertOwnedStaging(initDir, stagingDir);
    await fs.unlink(path.join(initDir, STAGING_MARKER_FILENAME));
  }
  await fs.rmdir(initDir);
}

async function initializeStaging(stagingDir: string, options: PrepareOptions): Promise<void> {
  await assertNoInitOrphans(stagingDir);
  const existing = await lstatOrNull(stagingDir);
  if (existing) {
    await assertOwnedStaging(stagingDir, stagingDir);
    return;
  }
  const token = randomBytes(16).toString("hex");
  const initDir = path.join(path.dirname(stagingDir), `.${path.basename(stagingDir)}.init-${token}`);
  await fs.mkdir(initDir);
  try {
    await (options.writeInitMarker ?? fs.writeFile)(path.join(initDir, STAGING_MARKER_FILENAME), jsonBytes(stagingMarker(stagingDir)), { flag: "wx" });
    await assertOwnedStaging(initDir, stagingDir);
    await fs.mkdir(path.join(initDir, "generations"));
    await (options.renameInitDir ?? fs.rename)(initDir, stagingDir);
  } catch (error) {
    const collision = (error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ENOTEMPTY";
    try {
      await cleanupCurrentInitDirectory(initDir, stagingDir, token);
    } catch (cleanupError) {
      throw new Error(`Staging initialization failed and owned init cleanup was blocked: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, { cause: error });
    }
    if (!collision) throw error;
    await assertOwnedStaging(stagingDir, stagingDir);
  }
}

async function assertGenerationsDirectory(stagingDir: string): Promise<void> {
  const generationsDir = path.join(stagingDir, "generations");
  const stat = await lstatOrNull(generationsDir);
  if (!stat) {
    await fs.mkdir(generationsDir);
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("generations must be a regular directory without links");
  const quarantineDir = path.join(stagingDir, "quarantine");
  const quarantineStat = await lstatOrNull(quarantineDir);
  if (!quarantineStat) await fs.mkdir(quarantineDir);
  else if (!quarantineStat.isDirectory() || quarantineStat.isSymbolicLink()) throw new Error("quarantine must be a regular directory without links");
}

async function countMarkedTempOrphans(stagingDir: string): Promise<number> {
  let count = 0;
  for (const entry of await fs.readdir(stagingDir, { withFileTypes: true })) {
    if (!entry.name.startsWith(".tmp-generation-")) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Unsafe generation temp orphan: ${entry.name}`);
    const token = entry.name.slice(".tmp-generation-".length);
    let marker: unknown;
    try {
      marker = JSON.parse(await fs.readFile(path.join(stagingDir, entry.name, TEMP_MARKER_FILENAME), "utf8"));
    } catch {
      throw new Error(`Unrecognized generation temp orphan: ${entry.name}`);
    }
    if (!isRecord(marker) || marker.schemaVersion !== 1 || marker.producer !== STAGING_MARKER_PRODUCER || marker.token !== token) {
      throw new Error(`Unrecognized generation temp orphan: ${entry.name}`);
    }
    count += 1;
  }
  return count;
}

async function measureSafeTree(directory: string, depth = 0): Promise<number> {
  if (depth > 4) throw new Error("Staging tree exceeds the supported depth");
  let bytes = 0;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  if (entries.length > 1_000) throw new Error("Staging tree has too many entries");
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`Staging quota scan found a linked entry: ${entry.name}`);
    if (stat.isFile()) bytes += stat.size;
    else if (stat.isDirectory()) bytes += await measureSafeTree(target, depth + 1);
    else throw new Error(`Staging quota scan found an unsupported entry: ${entry.name}`);
  }
  return bytes;
}

function positiveLimit(value: number | undefined, fallback: number, name: string, allowZero = false): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < (allowZero ? 0 : 1)) throw new Error(`${name} is invalid`);
  return result;
}

async function availableBytes(directory: string): Promise<number> {
  const stat = await fs.statfs(directory);
  return Number(stat.bavail) * Number(stat.bsize);
}

async function inspectGenerationQuota(stagingDir: string): Promise<{ generationCount: number; quarantineCount: number; bytes: number }> {
  const generationsDir = path.join(stagingDir, "generations");
  const generations = await fs.readdir(generationsDir, { withFileTypes: true });
  for (const entry of generations) {
    if (!/^[a-f0-9]{64}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Generations directory has an unsafe entry: ${entry.name}`);
    }
  }
  const quarantine = await fs.readdir(path.join(stagingDir, "quarantine"), { withFileTypes: true });
  for (const entry of quarantine) {
    if (!/^[a-f0-9]{64}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Quarantine has an unsafe entry: ${entry.name}`);
  }
  return { generationCount: generations.length, quarantineCount: quarantine.length, bytes: await measureSafeTree(stagingDir) };
}

async function recoverCleanupTombstones(stagingDir: string): Promise<void> {
  const prefix = ".tombstone-generation-";
  for (const entry of await fs.readdir(stagingDir, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix)) continue;
    const token = entry.name.slice(prefix.length);
    if (!/^[a-f0-9]{32}$/.test(token) || !entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Unsafe tombstone: ${entry.name}`);
    const directory = path.join(stagingDir, entry.name);
    const names = await fs.readdir(directory);
    if (names.length === 0) {
      await fs.rmdir(directory);
      continue;
    }
    if (names.length !== 1 || names[0] !== TEMP_MARKER_FILENAME) throw new Error(`Tombstone has unfamiliar content: ${entry.name}`);
    let marker: unknown;
    try { marker = JSON.parse(await fs.readFile(path.join(directory, TEMP_MARKER_FILENAME), "utf8")); } catch { throw new Error(`Unsafe tombstone marker: ${entry.name}`); }
    if (!isRecord(marker) || marker.schemaVersion !== 1 || marker.producer !== STAGING_MARKER_PRODUCER || marker.token !== token) {
      throw new Error(`Unsafe tombstone marker: ${entry.name}`);
    }
    await fs.unlink(path.join(directory, TEMP_MARKER_FILENAME));
    await fs.rmdir(directory);
  }
}

async function assertNoGcOrphans(stagingDir: string): Promise<void> {
  const orphans = (await fs.readdir(stagingDir)).filter((name) => name.startsWith(".gc-generation-")).sort();
  if (orphans.length) throw new Error(`GC tombstone requires manual recovery audit: ${orphans.join(", ")}`);
}

type PackageFiles = Record<string, Buffer>;

async function verifyGeneration(directory: string, expected: Map<string, PackageFiles>, generationBytes: Buffer): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Existing generation is not a safe directory");
  const expectedRoot = ["generation.json", ...expected.keys()].sort();
  if ((await fs.readdir(directory)).sort().join("\0") !== expectedRoot.join("\0")) throw new Error("Existing generation content does not match its digest");
  if (!(await fs.readFile(path.join(directory, "generation.json"))).equals(generationBytes)) throw new Error("Existing generation metadata does not match its digest");
  for (const [packageName, files] of expected) {
    const packageDir = path.join(directory, packageName);
    const packageStat = await fs.lstat(packageDir);
    if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) throw new Error(`Existing generation package is unsafe: ${packageName}`);
    if ((await fs.readdir(packageDir)).sort().join("\0") !== Object.keys(files).sort().join("\0")) throw new Error(`Existing package content does not match: ${packageName}`);
    for (const [filename, bytes] of Object.entries(files)) {
      if (!(await fs.readFile(path.join(packageDir, filename))).equals(bytes)) throw new Error(`Existing package bytes do not match: ${packageName}/${filename}`);
    }
  }
}

async function removeCurrentDuplicatePayload(payloadDir: string, expected: Map<string, PackageFiles>): Promise<void> {
  for (const [packageName, files] of expected) {
    const packageDir = path.join(payloadDir, packageName);
    for (const filename of Object.keys(files)) await fs.unlink(path.join(packageDir, filename));
    await fs.rmdir(packageDir);
  }
  await fs.unlink(path.join(payloadDir, "generation.json"));
  await fs.rmdir(payloadDir);
}

async function removeCurrentTempWrapper(tempDir: string, stagingDir: string, token: string): Promise<void> {
  const tombstone = path.join(stagingDir, `.tombstone-generation-${token}`);
  await fs.rename(tempDir, tombstone);
  await recoverCleanupTombstones(stagingDir);
}

async function syncFile(file: string): Promise<void> {
  const handle = await fs.open(file, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(directory: string): Promise<boolean> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EPERM" || code === "EINVAL" || code === "ENOTSUP")) return false;
    throw error;
  } finally { await handle.close(); }
}

async function validateCurrentPointer(stagingDir: string): Promise<void> {
  const currentPath = path.join(stagingDir, "current.json");
  const stat = await lstatOrNull(currentPath);
  if (!stat) return;
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("current.json is not a bounded regular file");
    const current = JSON.parse(await fs.readFile(currentPath, "utf8")) as unknown;
    if (!isRecord(current) || current.schemaVersion !== 1 || current.state !== "prepared-environment-unverified"
      || typeof current.generationDigest !== "string" || !/^[a-f0-9]{64}$/.test(current.generationDigest)
      || !isRecord(current.packageDigests)) throw new Error("current.json contract is invalid");
    const allowed = ["schemaVersion", "generationDigest", "packageDigests", "state"];
    if (Object.keys(current).some((key) => !allowed.includes(key))) throw new Error("current.json has unknown fields");
    const packageNames = Object.keys(current.packageDigests).sort();
    if (packageNames.join("\0") !== candidates.map((item) => item.packageName).sort().join("\0")) throw new Error("current.json package set is invalid");
    const packageDigests: Record<string, string> = {};
    for (const packageName of packageNames) {
      const digest = current.packageDigests[packageName];
      if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("current.json package digest is invalid");
      packageDigests[packageName] = digest;
    }
    const recomputed = digestBytes(Buffer.from(canonicalize({ schemaVersion: 1, packageDigests }), "utf8"));
    if (recomputed !== current.generationDigest) throw new Error("current generation digest does not match package digests");
    const generationRoot = path.join(stagingDir, "generations", current.generationDigest);
    for (const [packageName, packageDigest] of Object.entries(packageDigests)) {
      await verifyPreparedGenerationPackage({
        generationRoot, packageName, expectedGenerationDigest: current.generationDigest, expectedPackageDigest: packageDigest,
      });
    }
  } catch (error) {
    throw new Error(`Current pointer integrity check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeCurrentPointer(stagingDir: string, token: string, pointer: unknown): Promise<void> {
  const tempPath = path.join(stagingDir, `current.${token}.tmp`);
  const bytes = jsonBytes(pointer);
  try {
    await fs.writeFile(tempPath, bytes, { flag: "wx" });
    if (!(await fs.readFile(tempPath)).equals(bytes)) throw new Error("current pointer write verification failed");
    await syncFile(tempPath);
    await assertLockOwned(stagingDir, token);
    await fs.rename(tempPath, path.join(stagingDir, "current.json"));
  } catch (error) {
    try { await fs.unlink(tempPath); } catch { /* only this invocation's exact token path is eligible */ }
    throw error;
  }
}

export async function preparePixelleSingleBackendPackages(options: PrepareOptions): Promise<PrepareResult> {
  if (!options.pixelleRoot?.trim()) throw new Error("PIXELLE_ROOT is required");
  if (!options.stagingDir?.trim()) throw new Error("PIXELLE_WORKFLOW_STAGING_DIR is required");
  const pixelleRoot = path.resolve(options.pixelleRoot);
  const stagingDir = path.resolve(options.stagingDir);
  const repositoryRoot = path.resolve(process.cwd());
  const userProfile = path.resolve(os.homedir());
  const driveRoot = path.parse(stagingDir).root;
  if (stagingDir === driveRoot || isInside(pixelleRoot, stagingDir) || isInside(stagingDir, pixelleRoot)) {
    throw new Error("Staging directory must be a distinct tree outside PIXELLE_ROOT");
  }
  if (isInside(repositoryRoot, stagingDir) || isInside(stagingDir, repositoryRoot)) {
    throw new Error("Staging directory must not be the repository root or its parent/child");
  }
  if (stagingDir === userProfile || isInside(stagingDir, userProfile)) {
    throw new Error("Staging directory must not be the user profile or its parent");
  }
  await assertNoSymlinkComponents(pixelleRoot, "PIXELLE_ROOT");
  await assertNoSymlinkComponents(stagingDir, "staging directory");
  const stagingParent = path.dirname(stagingDir);
  await assertNoSymlinkComponents(stagingParent, "staging parent");
  const parentStat = await fs.lstat(stagingParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("Staging parent must be an existing regular directory");
  const workflowDir = path.resolve(pixelleRoot, "workflows", "selfhost");
  await assertNoSymlinkComponents(workflowDir, "Pixelle workflows/selfhost");
  if (await fs.realpath(workflowDir) !== workflowDir) throw new Error("Pixelle workflows/selfhost must not escape PIXELLE_ROOT");
  await initializeStaging(stagingDir, options);
  await assertGenerationsDirectory(stagingDir);
  const token = randomBytes(16).toString("hex");
  await acquireLock(stagingDir, options, token);
  try {
    let directoryFsyncSupported = true;
    await options.afterLockAcquired?.();
    await assertLockOwned(stagingDir, token);
    await recoverCleanupTombstones(stagingDir);
    await assertNoGcOrphans(stagingDir);
    await validateCurrentPointer(stagingDir);
    const orphanTempCount = await countMarkedTempOrphans(stagingDir);
    const maxGenerations = positiveLimit(options.maxGenerations, DEFAULT_MAX_GENERATIONS, "maxGenerations");
    const maxOrphanTemps = positiveLimit(options.maxOrphanTemps, DEFAULT_MAX_ORPHAN_TEMPS, "maxOrphanTemps", true);
    const maxStagingBytes = positiveLimit(options.maxStagingBytes, DEFAULT_MAX_STAGING_BYTES, "maxStagingBytes");
    const minimumFreeBytes = positiveLimit(options.minimumFreeBytes, DEFAULT_MINIMUM_FREE_BYTES, "minimumFreeBytes", true);
    if (orphanTempCount > maxOrphanTemps) throw new Error("Generation orphan limit exceeded; manual review/GC is required");
    const quota = await inspectGenerationQuota(stagingDir);
    if (orphanTempCount + quota.quarantineCount > maxOrphanTemps) throw new Error("Orphan/quarantine limit exceeded; offline cleanup is required");
    if (quota.generationCount > maxGenerations) throw new Error("Generation count limit exceeded; manual GC is required");
    if (quota.bytes > maxStagingBytes) throw new Error("Staging byte limit exceeded; manual GC is required");
    const freeBytes = await (options.getAvailableBytes ?? availableBytes)(stagingDir);
    if (!Number.isFinite(freeBytes) || freeBytes < minimumFreeBytes) throw new Error("Staging free space is below the configured low-water mark");
    const sourceBytes = await snapshotSources(workflowDir, options.afterSourceFileRead);
    const tempDir = path.join(stagingDir, `.tmp-generation-${token}`);
    await fs.mkdir(tempDir);
    await fs.writeFile(path.join(tempDir, TEMP_MARKER_FILENAME), jsonBytes({
      schemaVersion: 1, producer: STAGING_MARKER_PRODUCER, token, pid: process.pid, startedAtMs: options.nowMs ?? Date.now(),
    }), { flag: "wx" });
    const payloadDir = path.join(tempDir, "payload");
    await fs.mkdir(payloadDir);
    const writeBytes = options.writeBytes ?? fs.writeFile;
    const packages: PreparedPackage[] = [];
    const expected = new Map<string, PackageFiles>();
    const packageDigests: Record<string, string> = {};
    for (const definition of candidates) {
      const workflow = readApiWorkflow(sourceBytes.get(definition.sourceFile)!, definition);
      const manifest = makeManifest(definition, workflow);
      const compiled = compileWorkflowBindings(workflow, manifest);
      const tempPackageDir = path.join(payloadDir, definition.packageName);
      await fs.mkdir(tempPackageDir);
      const workflowBytes = jsonBytes(workflow);
      const manifestBytes = jsonBytes(manifest);
      const compiledBytes = jsonBytes(compiled);
      const fileDigests = {
        "workflow.api.json": digestBytes(workflowBytes),
        "manifest.json": digestBytes(manifestBytes),
        "compiled-bindings.json": digestBytes(compiledBytes),
      };
      const packageLock = {
        schemaVersion: 1,
        workflowId: manifest.workflowId,
        version: manifest.version,
        files: fileDigests,
        environmentLockDigest: sha256({
          requirements: manifest.requirements,
          outputContract: manifest.outputs,
        }),
      };
      const parsedLock = parseWorkflowPackageLock(packageLock, manifest);
      verifyLockedFiles(parsedLock, fileDigests);
      const files: Record<string, Buffer> = {
        "workflow.api.json": workflowBytes,
        "manifest.json": manifestBytes,
        "compiled-bindings.json": compiledBytes,
        "package.lock.json": jsonBytes(parsedLock),
      };
      for (const [filename, bytes] of Object.entries(files)) {
        const destination = path.join(tempPackageDir, filename);
        await writeBytes(destination, bytes);
        if (!(await fs.readFile(destination)).equals(bytes)) throw new Error(`Staging write verification failed: ${filename}`);
        await syncFile(destination);
      }
      if (!await syncDirectory(tempPackageDir)) directoryFsyncSupported = false;
      const packageDigest = digestBytes(Buffer.from(canonicalize(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, digestBytes(bytes)]))), "utf8"));
      packageDigests[definition.packageName] = packageDigest;
      expected.set(definition.packageName, files);
      packages.push({
        sourceFile: definition.sourceFile,
        packageName: definition.packageName,
        workflowId: manifest.workflowId,
        packageDigest,
        requirements: manifest.requirements,
      });
    }
    const generationDigest = digestBytes(Buffer.from(canonicalize({ schemaVersion: 1, packageDigests }), "utf8"));
    const generationBytes = jsonBytes({ schemaVersion: 1, generationDigest, packageDigests, state: "prepared-environment-unverified" });
    await writeBytes(path.join(payloadDir, "generation.json"), generationBytes);
    await syncFile(path.join(payloadDir, "generation.json"));
    if (!await syncDirectory(payloadDir)) directoryFsyncSupported = false;
    await options.afterDurabilityEvent?.("generation-payload");
    await assertLockOwned(stagingDir, token);
    const generationDir = path.join(stagingDir, "generations", generationDigest);
    const generationExists = Boolean(await lstatOrNull(generationDir));
    if (!generationExists && quota.generationCount >= maxGenerations) throw new Error("Generation count limit would be exceeded; manual GC is required");
    const payloadBytes = await measureSafeTree(payloadDir);
    if (!generationExists && quota.bytes + payloadBytes > maxStagingBytes) throw new Error("Staging byte limit would be exceeded; manual GC is required");
    if (generationExists) {
      await verifyGeneration(generationDir, expected, generationBytes);
      await removeCurrentDuplicatePayload(payloadDir, expected);
    } else {
      try {
        await fs.rename(payloadDir, generationDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
        await verifyGeneration(generationDir, expected, generationBytes);
        await removeCurrentDuplicatePayload(payloadDir, expected);
      }
    }
    await verifyGeneration(generationDir, expected, generationBytes);
    if (!await syncDirectory(generationDir)) directoryFsyncSupported = false;
    if (!await syncDirectory(path.join(stagingDir, "generations"))) directoryFsyncSupported = false;
    await options.afterDurabilityEvent?.("generations-directory");
    await writeCurrentPointer(stagingDir, token, {
      schemaVersion: 1, generationDigest, packageDigests, state: "prepared-environment-unverified",
    });
    await options.afterDurabilityEvent?.("current-file");
    if (!await syncDirectory(stagingDir)) directoryFsyncSupported = false;
    await options.afterDurabilityEvent?.("staging-directory");
    await removeCurrentTempWrapper(tempDir, stagingDir, token);
    return { packages, state: "prepared-environment-unverified", generationDigest, orphanTempCount, durability: { fileFsync: true, directoryFsync: directoryFsyncSupported } };
  } finally {
    await releaseLock(stagingDir, token);
  }
}

export async function garbageCollectPixelleGeneration(options: GarbageCollectOptions): Promise<{ generationDigest: string; quarantined: true; quarantinedBytes: number; auditFile: string; recovered: boolean }> {
  if (!/^[a-f0-9]{64}$/.test(options.generationDigest)) throw new Error("GC generation digest is invalid");
  if (options.confirmGenerationDigest !== options.generationDigest) throw new Error("GC confirmation digest must exactly match the target generation");
  if (!/^[A-Za-z0-9._@-]{1,200}$/.test(options.actor)) throw new Error("GC actor is invalid");
  const stagingDir = path.resolve(options.stagingDir);
  await assertNoSymlinkComponents(stagingDir, "staging directory");
  await assertOwnedStaging(stagingDir, stagingDir);
  const token = randomBytes(16).toString("hex");
  const lockOptions: PrepareOptions = {
    pixelleRoot: stagingDir,
    stagingDir,
    ...(options.getProcessIdentity ? { getProcessIdentity: options.getProcessIdentity } : {}),
  };
  await acquireLock(stagingDir, lockOptions, token);
  try {
    await recoverCleanupTombstones(stagingDir);
    await assertNoGcOrphans(stagingDir);
    await validateCurrentPointer(stagingDir);
    const currentPath = path.join(stagingDir, "current.json");
    const currentBytes = await fs.readFile(currentPath);
    const current = JSON.parse(currentBytes.toString("utf8")) as { generationDigest: string };
    if (current.generationDigest === options.generationDigest) throw new Error("Refusing to garbage-collect the current generation");
    const generationRoot = path.join(stagingDir, "generations", options.generationDigest);
    const quarantineDir = path.join(stagingDir, "quarantine");
    const quarantineTarget = path.join(quarantineDir, options.generationDigest);
    const auditAnchor = options.auditAnchor ?? await productionPixelleGcAuditAnchor();
    const anchorEvents = auditAnchor.list();
    const pending = anchorEvents.find((event) => event.phase === "intent"
      && !anchorEvents.some((candidate) => candidate.phase === "committed" && candidate.transactionId === event.transactionId));
    if (pending) {
      if (pending.payload.generationDigest !== options.generationDigest || pending.payload.currentGenerationDigest !== current.generationDigest) {
        throw new Error("A different or stale Pixelle GC database intent requires manual recovery");
      }
      await recoverPixelleGcAuditJournal({
        stagingDir,
        auditKey: options.auditKey,
        pending,
        afterDurabilityEvent: options.afterAuditRecoveryDurabilityEvent,
      });
      const entries = await getPixelleGcAuditEntries({ stagingDir, auditKey: options.auditKey });
      if (!entries.some((entry) => entry.transactionId === pending.transactionId && entry.phase === "intent")) {
        await appendPixelleGcAudit({ stagingDir, auditKey: options.auditKey, payload: pending.payload, phase: "intent", transactionId: pending.transactionId });
      }
      const sourceExists = Boolean(await lstatOrNull(generationRoot));
      const targetExists = Boolean(await lstatOrNull(quarantineTarget));
      if (sourceExists === targetExists) throw new Error("Pending Pixelle GC intent has an ambiguous source/quarantine state");
      const recoveryRoot = sourceExists ? generationRoot : quarantineTarget;
      for (const [packageName, expectedPackageDigest] of Object.entries(pending.payload.packageDigests)) {
        await verifyPreparedGenerationPackage({
          generationRoot: recoveryRoot,
          packageName,
          expectedGenerationDigest: pending.payload.generationDigest,
          expectedPackageDigest,
        });
      }
      if (await measureSafeTree(recoveryRoot) !== pending.payload.quarantinedBytes) throw new Error("Pending Pixelle GC target bytes changed after intent review");
      if (sourceExists) await (options.renameGeneration ?? fs.rename)(generationRoot, quarantineTarget);
      const committedAudit = await appendPixelleGcAudit({ stagingDir, auditKey: options.auditKey, payload: pending.payload, phase: "committed", transactionId: pending.transactionId });
      auditAnchor.commit(pending, committedAudit.entryDigest);
      await verifyPixelleGcAuditChain({ stagingDir, auditKey: options.auditKey, auditAnchor });
      await syncDirectory(path.join(stagingDir, "generations"));
      await syncDirectory(quarantineDir);
      await syncDirectory(stagingDir);
      return { generationDigest: options.generationDigest, quarantined: true, quarantinedBytes: pending.payload.quarantinedBytes, auditFile: committedAudit.auditFile, recovered: true };
    }
    const completed = [...anchorEvents].reverse().find((event) => event.phase === "committed" && event.payload.generationDigest === options.generationDigest);
    if (completed) {
      const sourceExists = Boolean(await lstatOrNull(generationRoot));
      const targetExists = Boolean(await lstatOrNull(quarantineTarget));
      if (sourceExists || !targetExists) throw new Error("Committed Pixelle GC anchor conflicts with source/quarantine state");
      for (const [packageName, expectedPackageDigest] of Object.entries(completed.payload.packageDigests)) {
        await verifyPreparedGenerationPackage({ generationRoot: quarantineTarget, packageName, expectedGenerationDigest: completed.payload.generationDigest, expectedPackageDigest });
      }
      if (await measureSafeTree(quarantineTarget) !== completed.payload.quarantinedBytes) throw new Error("Committed Pixelle GC quarantine bytes changed");
      await verifyPixelleGcAuditChain({ stagingDir, auditKey: options.auditKey, auditAnchor });
      return { generationDigest: options.generationDigest, quarantined: true, quarantinedBytes: completed.payload.quarantinedBytes, auditFile: "database-anchor", recovered: true };
    }
    const generationRaw = JSON.parse(await fs.readFile(path.join(generationRoot, "generation.json"), "utf8")) as unknown;
    if (!isRecord(generationRaw) || !isRecord(generationRaw.packageDigests) || generationRaw.generationDigest !== options.generationDigest) {
      throw new Error("GC target generation metadata is invalid");
    }
    const packageDigests: Record<string, string> = {};
    for (const [packageName, digest] of Object.entries(generationRaw.packageDigests)) {
      if (typeof digest !== "string") throw new Error("GC target package digest is invalid");
      await verifyPreparedGenerationPackage({
        generationRoot, packageName, expectedGenerationDigest: options.generationDigest, expectedPackageDigest: digest,
      });
      packageDigests[packageName] = digest;
    }
    if (!(await fs.readFile(currentPath)).equals(currentBytes)) throw new Error("current.json changed during GC review");
    const quarantinedBytes = await measureSafeTree(generationRoot);
    if (await lstatOrNull(quarantineTarget)) throw new Error("GC quarantine target already exists");
    const payload = {
      actor: options.actor, generationDigest: options.generationDigest, packageDigests,
      currentGenerationDigest: current.generationDigest, quarantinedBytes,
      quarantineName: options.generationDigest, reviewedAtMs: Date.now(),
    };
    const chain = await verifyPixelleGcAuditChain({ stagingDir, auditKey: options.auditKey, auditAnchor });
    const transactionId = randomBytes(16).toString("hex");
    const intent = auditAnchor.begin(payload, chain.lastDigest, transactionId);
    await appendPixelleGcAudit({ stagingDir, auditKey: options.auditKey, payload, phase: "intent", transactionId: intent.transactionId, afterDurabilityEvent: options.afterAuditDurabilityEvent });
    await (options.renameGeneration ?? fs.rename)(generationRoot, quarantineTarget);
    const audit = await appendPixelleGcAudit({ stagingDir, auditKey: options.auditKey, payload, phase: "committed", transactionId: intent.transactionId, afterDurabilityEvent: options.afterAuditDurabilityEvent });
    auditAnchor.commit(intent, audit.entryDigest);
    await verifyPixelleGcAuditChain({ stagingDir, auditKey: options.auditKey, auditAnchor });
    await syncDirectory(path.join(stagingDir, "generations"));
    await syncDirectory(quarantineDir);
    await syncDirectory(stagingDir);
    return { generationDigest: options.generationDigest, quarantined: true, quarantinedBytes, auditFile: audit.auditFile, recovered: false };
  } finally {
    await releaseLock(stagingDir, token);
  }
}

async function main(): Promise<void> {
  const result = await preparePixelleSingleBackendPackages({
    pixelleRoot: process.env.PIXELLE_ROOT ?? "",
    stagingDir: process.env.PIXELLE_WORKFLOW_STAGING_DIR ?? "",
  });
  console.log(JSON.stringify({
    state: result.state,
    generationDigest: result.generationDigest,
    orphanTempCount: result.orphanTempCount,
    durability: result.durability,
    packages: result.packages,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
