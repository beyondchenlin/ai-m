import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalize, sha256 } from "../src/lib/generation/workflows/canonical";
import { compileWorkflowBindings } from "../src/lib/generation/workflows/compiler";
import { parseWorkflowManifest } from "../src/lib/generation/workflows/manifest";
import { normalizeComfyWorkflow } from "../src/lib/generation/workflows/normalize";
import { parseWorkflowPackageLock, verifyLockedFiles } from "../src/lib/generation/workflows/package-lock";
import { applyStaticPolicy, validateWorkflowStructure } from "../src/lib/generation/workflows/validator";
import type { AuthorBinding, AuthorOutput, ComfyWorkflow, WorkflowManifest } from "../src/lib/generation/workflows/types";

export interface ComfyUIInventory {
  schemaVersion: 1;
  source: "ai-m-live-comfyui-probe-v1";
  baseUrl: "http://127.0.0.1:8000";
  capturedAtMs: number;
  maxAgeMs: number;
  backendFingerprint: string;
  nodeClasses: string[];
  models: Record<string, string[]>;
  objectInfoSha256: string;
  inventoryDigest: string;
}

export interface PrepareOptions {
  pixelleRoot: string;
  stagingDir: string;
  inventory?: unknown;
  nowMs?: number;
  writeBytes?: typeof fs.writeFile;
  removeOwnedBackup?: (backupDir: string) => Promise<void>;
}

interface PreparedPackage {
  sourceFile: string;
  packageDir: string;
  workflowId: string;
  inventoryStatus: "unverified" | "matched" | "blocked";
  blockedReasons: string[];
}

export interface PrepareResult {
  stagingDir: string;
  packages: PreparedPackage[];
  state: "prepared-environment-unverified" | "prepared-inventory-matched" | "prepared-with-inventory-blockers";
  cleanupWarnings: string[];
}

const STAGING_MARKER_FILENAME = ".ai-m-pixelle-staging.json";
const STAGING_MARKER_PRODUCER = "ai-m/pixelle-single-backend";
const STAGING_MARKER_SCHEMA_VERSION = 1;

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
    ...(includeDuration ? [numericBinding("duration", "PixelleDurationInput", "$duration.value", "value", "number", numericInputDefault(workflow, "PixelleDurationInput", "$duration.value", "value"), 0.1, 3_600)] : []),
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

export async function cleanupOwnedBackupDirectory(
  backupDir: string,
  canonicalStagingPath: string,
  removeEntry: (target: string) => Promise<void> = async (target) => fs.rm(target, { recursive: true, force: false }),
): Promise<void> {
  await assertOwnedStaging(backupDir, canonicalStagingPath);
  const entries = (await fs.readdir(backupDir)).filter((name) => name !== STAGING_MARKER_FILENAME).sort();
  for (const name of entries) await removeEntry(path.join(backupDir, name));
  const markerPath = path.join(backupDir, STAGING_MARKER_FILENAME);
  await fs.unlink(markerPath);
  try {
    await fs.rmdir(backupDir);
  } catch (error) {
    try { await fs.writeFile(markerPath, jsonBytes(stagingMarker(canonicalStagingPath))); } catch { /* keep the original cleanup failure */ }
    throw error;
  }
}

function parseInventory(value: unknown, nowMs: number): ComfyUIInventory {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("ComfyUI inventory schemaVersion must equal 1");
  const allowed = [
    "schemaVersion", "source", "baseUrl", "capturedAtMs", "maxAgeMs", "backendFingerprint",
    "nodeClasses", "models", "objectInfoSha256", "inventoryDigest",
  ];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`ComfyUI inventory has unknown field(s): ${unknown.join(", ")}`);
  if (value.source !== "ai-m-live-comfyui-probe-v1") throw new Error("ComfyUI inventory source is invalid");
  if (value.baseUrl !== "http://127.0.0.1:8000") throw new Error("ComfyUI inventory baseUrl must exactly equal http://127.0.0.1:8000");
  if (!Number.isSafeInteger(value.capturedAtMs) || (value.capturedAtMs as number) <= 0) throw new Error("ComfyUI inventory capturedAtMs must be a positive integer");
  if (!Number.isSafeInteger(value.maxAgeMs) || (value.maxAgeMs as number) < 1_000 || (value.maxAgeMs as number) > 86_400_000) {
    throw new Error("ComfyUI inventory maxAgeMs must be an integer between 1000 and 86400000");
  }
  const ageMs = nowMs - (value.capturedAtMs as number);
  if (ageMs < -300_000) throw new Error("ComfyUI inventory capture time is unreasonably far in the future");
  if (ageMs > (value.maxAgeMs as number)) throw new Error("ComfyUI inventory is stale and must be refreshed by the live probe");
  if (typeof value.backendFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.backendFingerprint)) {
    throw new Error("ComfyUI inventory backendFingerprint must be 64 lowercase hex characters");
  }
  if (!Array.isArray(value.nodeClasses) || value.nodeClasses.length === 0) throw new Error("ComfyUI inventory nodeClasses must be non-empty");
  const nodeClasses: string[] = [];
  const seenClasses = new Set<string>();
  for (const item of value.nodeClasses) {
    if (typeof item !== "string" || item !== item.trim() || !/^[A-Za-z0-9_ .:+-]{1,200}$/.test(item)) {
      throw new Error("ComfyUI inventory nodeClasses contains an unsafe class name");
    }
    if (seenClasses.has(item)) throw new Error(`ComfyUI inventory nodeClasses contains duplicate: ${item}`);
    seenClasses.add(item);
    nodeClasses.push(item);
  }
  nodeClasses.sort();
  if (!isRecord(value.models)) throw new Error("ComfyUI inventory models must be an object");
  const models: Record<string, string[]> = {};
  for (const [folder, filenames] of Object.entries(value.models)) {
    if (!/^[A-Za-z0-9._-]+$/.test(folder)) throw new Error(`ComfyUI inventory model folder is unsafe: ${folder}`);
    if (!Array.isArray(filenames) || !filenames.every((item) => typeof item === "string" && item.length > 0)) {
      throw new Error(`ComfyUI inventory models.${folder} must be string[]`);
    }
    const normalized = (filenames as string[]).map((item) => item.replace(/\\/g, "/"));
    for (const filename of normalized) {
      const parts = filename.split("/");
      if (filename.length > 1_024 || path.isAbsolute(filename) || parts.some((part) => !part || part === "." || part === ".." || part.length > 255)) {
        throw new Error(`ComfyUI inventory model filename is unsafe: ${folder}/${filename}`);
      }
    }
    if (new Set(normalized).size !== normalized.length) throw new Error(`ComfyUI inventory models.${folder} contains duplicate filenames`);
    models[folder] = normalized.sort();
  }
  if (typeof value.objectInfoSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.objectInfoSha256)) {
    throw new Error("ComfyUI inventory objectInfoSha256 must be 64 lowercase hex characters");
  }
  if (typeof value.inventoryDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.inventoryDigest)) {
    throw new Error("ComfyUI inventory inventoryDigest must be 64 lowercase hex characters");
  }
  const normalizedPayload = {
    schemaVersion: 1 as const,
    source: "ai-m-live-comfyui-probe-v1" as const,
    baseUrl: "http://127.0.0.1:8000" as const,
    capturedAtMs: value.capturedAtMs as number,
    maxAgeMs: value.maxAgeMs as number,
    backendFingerprint: value.backendFingerprint,
    nodeClasses,
    models,
    objectInfoSha256: value.objectInfoSha256,
  };
  if (digestBytes(Buffer.from(canonicalize(normalizedPayload), "utf8")) !== value.inventoryDigest) {
    throw new Error("ComfyUI inventory inventoryDigest does not match its canonical payload");
  }
  if (digestBytes(Buffer.from(canonicalize(nodeClasses), "utf8")) !== value.objectInfoSha256) {
    throw new Error("ComfyUI inventory objectInfoSha256 does not match canonical nodeClasses evidence");
  }
  return { ...normalizedPayload, inventoryDigest: value.inventoryDigest };
}

function environmentAssessment(manifest: WorkflowManifest, inventory: ComfyUIInventory | undefined) {
  if (!inventory) return { inventoryStatus: "unverified" as const, blockedReasons: [] as string[] };
  const blockedReasons: string[] = [];
  for (const classType of manifest.requirements.nodeClasses) {
    if (!inventory.nodeClasses.includes(classType)) blockedReasons.push(`missing node class: ${classType}`);
  }
  for (const model of manifest.requirements.models) {
    const filename = model.filename.replace(/\\/g, "/");
    if (!inventory.models[model.folder]?.includes(filename)) {
      blockedReasons.push(`missing model: ${model.folder}/${filename}`);
    }
  }
  return blockedReasons.length
    ? { inventoryStatus: "blocked" as const, blockedReasons }
    : { inventoryStatus: "matched" as const, blockedReasons };
}

async function removeInvocationDirectory(directory: string, parent: string, prefix: string): Promise<void> {
  if (path.dirname(directory) !== parent || !path.basename(directory).startsWith(prefix)) {
    throw new Error("Refusing to remove a directory not owned by this invocation");
  }
  const stat = await lstatOrNull(directory);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing to remove a linked invocation directory");
  await fs.rm(directory, { recursive: true, force: false });
}

async function assertNoSymlinkComponents(target: string, label: string): Promise<void> {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`${label} must not contain a symbolic link or junction: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function readApiWorkflow(workflowDir: string, definition: CandidateDefinition): Promise<ComfyWorkflow> {
  const source = path.resolve(workflowDir, definition.sourceFile);
  if (path.dirname(source) !== workflowDir) throw new Error(`Source workflow escapes workflows/selfhost: ${definition.sourceFile}`);
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Source workflow must be a regular file without symbolic links: ${definition.sourceFile}`);
  const realSource = await fs.realpath(source);
  if (path.dirname(realSource) !== workflowDir) throw new Error(`Source workflow escapes workflows/selfhost: ${definition.sourceFile}`);
  const raw = JSON.parse(await fs.readFile(source, "utf8")) as unknown;
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
  const existingStaging = await lstatOrNull(stagingDir);
  if (existingStaging) await assertOwnedStaging(stagingDir, stagingDir);
  const basename = path.basename(stagingDir);
  const backupPrefix = `${basename}.ai-m-backup-`;
  const orphanBackups = (await fs.readdir(stagingParent, { withFileTypes: true }))
    .filter((entry) => entry.name.startsWith(backupPrefix));
  if (orphanBackups.length) {
    for (const orphan of orphanBackups) {
      if (!orphan.isDirectory() || orphan.isSymbolicLink()) throw new Error(`Unsafe orphan backup blocks staging: ${orphan.name}`);
      await assertOwnedStaging(path.join(stagingParent, orphan.name), stagingDir);
    }
    throw new Error(`Owned orphan backup cleanup is required before another run: ${orphanBackups.map((item) => item.name).join(", ")}`);
  }
  const inventory = options.inventory === undefined ? undefined : parseInventory(options.inventory, options.nowMs ?? Date.now());

  const prepared: Array<{
    definition: CandidateDefinition;
    workflow: ComfyWorkflow;
    manifest: WorkflowManifest;
    compiled: ReturnType<typeof compileWorkflowBindings>;
  }> = [];
  for (const definition of candidates) {
    const workflow = await readApiWorkflow(workflowDir, definition);
    const manifest = makeManifest(definition, workflow);
    const compiled = compileWorkflowBindings(workflow, manifest);
    prepared.push({ definition, workflow, manifest, compiled });
  }

  const tempPrefix = `${basename}.ai-m-tmp-`;
  const tempDir = path.join(stagingParent, `${tempPrefix}${randomUUID()}`);
  await fs.mkdir(tempDir);
  const writeBytes = options.writeBytes ?? fs.writeFile;
  const packages: PreparedPackage[] = [];
  const cleanupWarnings: string[] = [];
  try {
    for (const item of prepared) {
      const tempPackageDir = path.join(tempDir, item.definition.packageName);
      await fs.mkdir(tempPackageDir);
      const workflowBytes = jsonBytes(item.workflow);
      const manifestBytes = jsonBytes(item.manifest);
      const compiledBytes = jsonBytes(item.compiled);
      const fileDigests = {
        "workflow.api.json": digestBytes(workflowBytes),
        "manifest.json": digestBytes(manifestBytes),
        "compiled-bindings.json": digestBytes(compiledBytes),
      };
      const packageLock = {
        schemaVersion: 1,
        workflowId: item.manifest.workflowId,
        version: item.manifest.version,
        files: fileDigests,
        environmentLockDigest: sha256({
          requirements: item.manifest.requirements,
          outputContract: item.manifest.outputs,
        }),
      };
      const parsedLock = parseWorkflowPackageLock(packageLock, item.manifest);
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
      }
      const assessment = environmentAssessment(item.manifest, inventory);
      packages.push({
        sourceFile: item.definition.sourceFile,
        packageDir: path.join(stagingDir, item.definition.packageName),
        workflowId: item.manifest.workflowId,
        ...assessment,
      });
    }
    const markerBytes = jsonBytes(stagingMarker(stagingDir));
    await writeBytes(path.join(tempDir, STAGING_MARKER_FILENAME), markerBytes);
    await assertOwnedStaging(tempDir, stagingDir);

    if (!existingStaging) {
      await fs.rename(tempDir, stagingDir);
      await assertOwnedStaging(stagingDir, stagingDir);
    } else {
      const backupDir = path.join(stagingParent, `${backupPrefix}${randomUUID()}`);
      await fs.rename(stagingDir, backupDir);
      try {
        await fs.rename(tempDir, stagingDir);
        await assertOwnedStaging(stagingDir, stagingDir);
      } catch (error) {
        const failedNewPrefix = `${basename}.ai-m-precommit-new-`;
        const failedNewDir = path.join(stagingParent, `${failedNewPrefix}${randomUUID()}`);
        if (await lstatOrNull(stagingDir)) await fs.rename(stagingDir, failedNewDir);
        await fs.rename(backupDir, stagingDir);
        await removeInvocationDirectory(failedNewDir, stagingParent, failedNewPrefix);
        throw error;
      }
      await assertOwnedStaging(backupDir, stagingDir);
      try {
        if (options.removeOwnedBackup) await options.removeOwnedBackup(backupDir);
        else await cleanupOwnedBackupDirectory(backupDir, stagingDir);
      } catch (error) {
        cleanupWarnings.push(`Committed new staging; owned backup cleanup failed at ${backupDir}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    await removeInvocationDirectory(tempDir, stagingParent, tempPrefix);
    throw error;
  }
  const state = !inventory
    ? "prepared-environment-unverified" as const
    : packages.some((item) => item.inventoryStatus === "blocked")
      ? "prepared-with-inventory-blockers" as const
      : "prepared-inventory-matched" as const;
  return { stagingDir, packages, state, cleanupWarnings };
}

async function main(): Promise<void> {
  const inventoryFile = process.env.COMFYUI_INVENTORY_FILE?.trim();
  const result = await preparePixelleSingleBackendPackages({
    pixelleRoot: process.env.PIXELLE_ROOT ?? "",
    stagingDir: process.env.PIXELLE_WORKFLOW_STAGING_DIR ?? "",
    inventory: inventoryFile ? JSON.parse(await fs.readFile(path.resolve(inventoryFile), "utf8")) : undefined,
  });
  console.log(JSON.stringify({
    stagingDir: result.stagingDir,
    state: result.state,
    inventoryMatched: result.packages.filter((item) => item.inventoryStatus === "matched").map(({ sourceFile, workflowId }) => ({ sourceFile, workflowId })),
    unverified: result.packages.filter((item) => item.inventoryStatus === "unverified").map(({ sourceFile, workflowId }) => ({ sourceFile, workflowId })),
    blocked: result.packages.filter((item) => item.inventoryStatus === "blocked").map(({ sourceFile, workflowId, blockedReasons }) => ({ sourceFile, workflowId, blockedReasons })),
    cleanupWarnings: result.cleanupWarnings,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
