import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalize, sha256 } from "../src/lib/generation/workflows/canonical";
import { compileWorkflowBindings } from "../src/lib/generation/workflows/compiler";
import { parseWorkflowManifest } from "../src/lib/generation/workflows/manifest";
import { normalizeComfyWorkflow } from "../src/lib/generation/workflows/normalize";
import { parseWorkflowPackageLock, verifyLockedFiles } from "../src/lib/generation/workflows/package-lock";
import { applyStaticPolicy, validateWorkflowStructure } from "../src/lib/generation/workflows/validator";
import type { AuthorBinding, AuthorOutput, ComfyWorkflow, WorkflowManifest } from "../src/lib/generation/workflows/types";

interface PrepareOptions {
  pixelleRoot: string;
  stagingDir: string;
}

interface PreparedPackage {
  sourceFile: string;
  packageDir: string;
  workflowId: string;
}

export interface PrepareResult {
  stagingDir: string;
  packages: PreparedPackage[];
}

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
  const driveRoot = path.parse(stagingDir).root;
  if (stagingDir === driveRoot || isInside(pixelleRoot, stagingDir) || isInside(stagingDir, pixelleRoot)) {
    throw new Error("Staging directory must be a distinct tree outside PIXELLE_ROOT");
  }
  await assertNoSymlinkComponents(pixelleRoot, "PIXELLE_ROOT");
  await assertNoSymlinkComponents(stagingDir, "staging directory");
  const workflowDir = path.resolve(pixelleRoot, "workflows", "selfhost");
  await assertNoSymlinkComponents(workflowDir, "Pixelle workflows/selfhost");
  if (await fs.realpath(workflowDir) !== workflowDir) throw new Error("Pixelle workflows/selfhost must not escape PIXELLE_ROOT");

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

  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir, { recursive: true });
  const packages: PreparedPackage[] = [];
  for (const item of prepared) {
    const packageDir = path.join(stagingDir, item.definition.packageName);
    await fs.mkdir(packageDir);
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
    await Promise.all([
      fs.writeFile(path.join(packageDir, "workflow.api.json"), workflowBytes),
      fs.writeFile(path.join(packageDir, "manifest.json"), manifestBytes),
      fs.writeFile(path.join(packageDir, "compiled-bindings.json"), compiledBytes),
      fs.writeFile(path.join(packageDir, "package.lock.json"), jsonBytes(parsedLock)),
    ]);
    packages.push({ sourceFile: item.definition.sourceFile, packageDir, workflowId: item.manifest.workflowId });
  }
  return { stagingDir, packages };
}

async function main(): Promise<void> {
  const result = await preparePixelleSingleBackendPackages({
    pixelleRoot: process.env.PIXELLE_ROOT ?? "",
    stagingDir: process.env.PIXELLE_WORKFLOW_STAGING_DIR ?? "",
  });
  console.log(JSON.stringify({
    stagingDir: result.stagingDir,
    packages: result.packages.map(({ sourceFile, workflowId }) => ({ sourceFile, workflowId })),
    state: "prepared-not-imported",
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
