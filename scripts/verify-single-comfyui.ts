import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bindWorkflow } from "../src/lib/generation/workflows/binder";
import { canonicalize } from "../src/lib/generation/workflows/canonical";
import { parseCompiledBindings } from "../src/lib/generation/workflows/compiled";
import { parseWorkflowManifest } from "../src/lib/generation/workflows/manifest";
import { normalizeComfyWorkflow } from "../src/lib/generation/workflows/normalize";
import type { ComfyWorkflow, CompiledBindings, WorkflowManifest } from "../src/lib/generation/workflows/types";
import { loadProductionTask4PrivateKey } from "./pixelle-trust-store";
import { signTask4Evidence, verifyGenerationPackageForImport, verifyPreparedGenerationPackage } from "./verify-generation-package";
import { createPowerShellCommandRunner } from "../src/lib/generation/runtime/managed-comfyui-runtime";

const BASE_URL = "http://127.0.0.1:8000" as const;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const execFileAsync = promisify(execFile);

export interface Task4ListenerIdentity {
  pid: number;
  processCreatedAtMs: number;
  bootId: string;
  processIdentity: string;
  connectionId: string;
}

export interface Task4History {
  status: { statusStr: string; completed: boolean; messages?: Array<[string, Record<string, unknown>]> };
  outputs: Record<string, Record<string, unknown>>;
}

export interface Task4Session {
  connectionId: string;
  systemStats(): Promise<Record<string, unknown>>;
  objectInfo(): Promise<Record<string, unknown>>;
  models(folder: string): Promise<string[]>;
  uploadReferenceAudio(input: { filename: string; bytes: Buffer; mimeType: string }): Promise<string>;
  submit(workflow: Record<string, unknown>, clientId: string): Promise<string>;
  history(promptId: string): Promise<Task4History | undefined>;
  download(file: { filename: string; subfolder: string; type: string }, maximumBytes: number): Promise<{ bytes: Buffer; mediaKind: "audio" | "image" | "video" }>;
  close(): Promise<void>;
}

export interface VerifySingleOptions {
  baseUrl: string;
  mode: "inventory-only" | "verify";
  pixelleRoot: string;
  generationRoot: string;
  expectedGenerationDigest: string;
  evidenceDir: string;
  archiveDir: string;
  parameters: Record<string, Record<string, unknown>>;
  referenceAudioFile?: string;
  completionTimeoutMs?: number;
  pollIntervalMs?: number;
  evidenceTtlMs?: number;
  privateKey?: string | Buffer;
  publicKey?: string | Buffer;
}

export interface Task4Dependencies {
  connect(): Promise<Task4Session>;
  observeListener(): Promise<Task4ListenerIdentity>;
  restart(): Promise<{ stoppedAtMs: number; restartedAtMs: number }>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function parseTask4Mode(env: Record<string, string | undefined>): VerifySingleOptions["mode"] {
  const raw = env.TASK4_MODE?.trim() || "inventory-only";
  const mode = raw === "dry-run" ? "inventory-only" : raw;
  if (mode !== "inventory-only" && mode !== "verify") throw new Error("TASK4_MODE must be dry-run, inventory-only or verify");
  if (mode === "verify" && env.TASK4_CONFIRM_RESTART !== "RESTART-127.0.0.1:8000") {
    throw new Error("TASK4_CONFIRM_RESTART must exactly equal RESTART-127.0.0.1:8000 in verify mode");
  }
  return mode;
}

interface PackageInventory {
  packageName: string;
  packageDigest: string;
  manifest: WorkflowManifest;
  compiled: CompiledBindings;
  workflow: ComfyWorkflow;
}

function hash(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex"); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function parseJson(bytes: Buffer, label: string): unknown {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is invalid JSON`); }
  let count = 0;
  const inspect = (candidate: unknown, depth: number) => {
    count += 1;
    if (depth > MAX_JSON_DEPTH || count > 100_000) throw new Error(`${label} exceeds structural bounds`);
    if (typeof candidate === "string" && Buffer.byteLength(candidate) > MAX_CONFIG_BYTES) throw new Error(`${label} contains an oversized string`);
    if (Array.isArray(candidate)) for (const item of candidate) inspect(item, depth + 1);
    else if (candidate && typeof candidate === "object") for (const item of Object.values(candidate)) inspect(item, depth + 1);
  };
  inspect(value, 0);
  return value;
}
function safeInteger(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error(`${label} is outside its bounded range`);
  return result;
}
async function assertFixedScripts(pixelleRoot: string): Promise<void> {
  const root = path.resolve(pixelleRoot);
  for (const name of ["start_backend.ps1", "stop_backend.ps1"]) {
    const script = path.join(root, "scripts", "comfyui", name);
    const stat = await fs.lstat(script);
    if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(script) !== script) throw new Error(`Fixed Pixelle ${name} is missing or linked`);
  }
}
function assertIdentity(value: Task4ListenerIdentity, label: string): void {
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isSafeInteger(value.processCreatedAtMs) || value.processCreatedAtMs <= 0
    || !/^[A-Za-z0-9._:-]{3,200}$/.test(value.bootId) || !/^[A-Za-z0-9._:-]{3,300}$/.test(value.processIdentity)
    || !/^[A-Za-z0-9._:-]{8,200}$/.test(value.connectionId)) throw new Error(`${label} listener identity is uncertain`);
}
function assertProbeSchemas(system: Record<string, unknown>, objects: Record<string, unknown>): void {
  const systemRecord = record(system.system, "system_stats.system");
  if (!Object.keys(systemRecord).length || !Array.isArray(system.devices)) throw new Error("system_stats schema is malformed");
  if (!Object.keys(objects).length) throw new Error("object_info schema is malformed");
}
function assertInventory(pkg: PackageInventory, objects: Record<string, unknown>, models: Map<string, string[]>): void {
  for (const nodeClass of pkg.manifest.requirements.nodeClasses) {
    if (!objects[nodeClass] || typeof objects[nodeClass] !== "object") throw new Error(`${pkg.packageName} is missing required node ${nodeClass}`);
  }
  for (const binding of pkg.compiled.bindings) {
    const descriptor = record(objects[binding.classType], `${binding.classType} object_info`);
    const inputs = record(descriptor.input, `${binding.classType} object_info.input`);
    const required = inputs.required && typeof inputs.required === "object" && !Array.isArray(inputs.required) ? inputs.required as Record<string, unknown> : {};
    const optional = inputs.optional && typeof inputs.optional === "object" && !Array.isArray(inputs.optional) ? inputs.optional as Record<string, unknown> : {};
    if (!(binding.inputName in required) && !(binding.inputName in optional)) throw new Error(`${pkg.packageName} binding ${binding.key} is absent from actual object_info`);
  }
  for (const output of pkg.compiled.outputs) {
    const descriptor = record(objects[output.classType], `${output.classType} object_info`);
    if (!Array.isArray(descriptor.output) || !Array.isArray(descriptor.output_name)) throw new Error(`${pkg.packageName} output node schema is malformed`);
  }
  for (const model of pkg.manifest.requirements.models) {
    if (!(models.get(model.folder) ?? []).includes(model.filename.replace(/\\/g, "/"))) throw new Error(`${pkg.packageName} is missing required model ${model.folder}/${model.filename}`);
  }
}

async function inventoryGeneration(options: VerifySingleOptions): Promise<PackageInventory[]> {
  if (!DIGEST.test(options.expectedGenerationDigest)) throw new Error("Expected generation digest is invalid");
  const generationFile = path.join(path.resolve(options.generationRoot), "generation.json");
  const generationStat = await fs.lstat(generationFile);
  if (!generationStat.isFile() || generationStat.isSymbolicLink() || generationStat.size > 64 * 1024) throw new Error("generation.json is unsafe or oversized");
  const generation = record(parseJson(await fs.readFile(generationFile), "generation.json"), "generation.json");
  if (generation.generationDigest !== options.expectedGenerationDigest) throw new Error("current generation digest does not match the selected root");
  const packageDigests = record(generation.packageDigests, "generation package digests");
  const packages: PackageInventory[] = [];
  for (const packageName of Object.keys(packageDigests).sort()) {
    const packageDigest = packageDigests[packageName];
    if (typeof packageDigest !== "string" || !DIGEST.test(packageDigest)) throw new Error("Generation package digest is invalid");
    const verified = await verifyPreparedGenerationPackage({
      generationRoot: options.generationRoot, packageName, expectedGenerationDigest: options.expectedGenerationDigest, expectedPackageDigest: packageDigest,
    });
    packages.push({
      packageName, packageDigest,
      manifest: parseWorkflowManifest(parseJson(verified.files["manifest.json"], `${packageName}/manifest.json`)),
      compiled: parseCompiledBindings(parseJson(verified.files["compiled-bindings.json"], `${packageName}/compiled-bindings.json`)),
      workflow: normalizeComfyWorkflow(parseJson(verified.files["workflow.api.json"], `${packageName}/workflow.api.json`)),
    });
  }
  if (!packages.length || packages.length > 32) throw new Error("Current generation package count is invalid");
  return packages;
}

function historyOutcome(history: Task4History | undefined): "completed" | "cancelled" | "failed" | "unknown" {
  if (!history) return "unknown";
  const status = history.status?.statusStr?.trim().toLowerCase();
  const messages = new Set((history.status?.messages ?? []).map(([name]) => name));
  if (status === "success" && history.status.completed === true && !messages.has("execution_error")) return "completed";
  if (messages.has("execution_interrupted")) return "cancelled";
  if (messages.has("execution_error") || status === "failed" || status === "failure") return "failed";
  return "unknown";
}

async function archiveBytes(file: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes, { flag: "wx" });
  const handle = await fs.open(file, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function responseBytes(response: Response, maximumBytes: number, label: string): Promise<Buffer> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`${label} failed (${response.status})`); }
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) throw new Error(`${label} response is oversized`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${label} response body is missing`);
  const chunks: Buffer[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximumBytes) throw new Error(`${label} response is oversized`);
      chunks.push(Buffer.from(part.value));
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  return Buffer.concat(chunks, size);
}

async function fetchJson(url: string, init: RequestInit, maximumBytes: number, label: string): Promise<unknown> {
  const signal = AbortSignal.timeout(30_000);
  return parseJson(await responseBytes(await fetch(url, { ...init, signal }), maximumBytes, label), label);
}

async function createHttpSession(): Promise<Task4Session> {
  const connectionId = `task4-${randomUUID()}`;
  let closed = false;
  const socket = new WebSocket(`ws://127.0.0.1:8000/ws?clientId=${encodeURIComponent(connectionId)}`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("ComfyUI WebSocket connection timed out")); }, 30_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("ComfyUI WebSocket connection failed")); }, { once: true });
  });
  const ensureOpen = () => { if (closed) throw new Error("ComfyUI session is closed"); };
  return {
    connectionId,
    async systemStats() { ensureOpen(); return record(await fetchJson(`${BASE_URL}/system_stats`, {}, 1024 * 1024, "system_stats"), "system_stats"); },
    async objectInfo() { ensureOpen(); return record(await fetchJson(`${BASE_URL}/object_info`, {}, 16 * 1024 * 1024, "object_info"), "object_info"); },
    async models(folder) {
      ensureOpen();
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(folder)) throw new Error("Model folder is unsafe");
      const value = await fetchJson(`${BASE_URL}/models/${encodeURIComponent(folder)}`, {}, 4 * 1024 * 1024, "models");
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length <= 500)) throw new Error("models schema is malformed");
      return value;
    },
    async uploadReferenceAudio(input) {
      ensureOpen();
      const data = new FormData();
      data.set("image", new Blob([Uint8Array.from(input.bytes)], { type: input.mimeType }), input.filename);
      data.set("type", "input"); data.set("overwrite", "false");
      const result = record(await fetchJson(`${BASE_URL}/upload/image`, { method: "POST", body: data }, 64 * 1024, "reference upload"), "reference upload");
      if (typeof result.name !== "string" || !result.name || result.name.length > 300 || typeof result.subfolder !== "string") throw new Error("Reference upload schema is malformed");
      return result.subfolder ? `${result.subfolder.replace(/\\/g, "/")}/${result.name}` : result.name;
    },
    async submit(workflow, clientId) {
      ensureOpen();
      const result = record(await fetchJson(`${BASE_URL}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: workflow, client_id: clientId }) }, 64 * 1024, "prompt submission"), "prompt submission");
      if (typeof result.prompt_id !== "string") throw new Error("Prompt submission schema is malformed");
      return result.prompt_id;
    },
    async history(promptId) {
      ensureOpen();
      const result = record(await fetchJson(`${BASE_URL}/history/${encodeURIComponent(promptId)}`, {}, 16 * 1024 * 1024, "history"), "history");
      if (!(promptId in result)) return undefined;
      const item = record(result[promptId], "history item");
      const status = record(item.status, "history status");
      const outputsRaw = record(item.outputs, "history outputs");
      const outputs: Record<string, Record<string, unknown>> = {};
      for (const [nodeId, output] of Object.entries(outputsRaw)) outputs[nodeId] = record(output, `history output ${nodeId}`);
      if (typeof status.statusStr !== "string" || typeof status.completed !== "boolean") throw new Error("History status schema is malformed");
      return { status: status as unknown as Task4History["status"], outputs };
    },
    async download(file, maximumBytes) {
      ensureOpen();
      const query = new URLSearchParams(file);
      const response = await fetch(`${BASE_URL}/view?${query}`, { signal: AbortSignal.timeout(60_000) });
      const bytes = await responseBytes(response, maximumBytes, "output download");
      const mime = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() ?? "";
      const mediaKind = mime.startsWith("audio/") ? "audio" : mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : undefined;
      if (!mediaKind) throw new Error("Output content type is unsupported");
      return { bytes, mediaKind };
    },
    async close() { closed = true; socket.close(1000, "task4 session complete"); },
  };
}

export async function verifySingleComfyUI(options: VerifySingleOptions, dependencies: Task4Dependencies): Promise<{
  mode: VerifySingleOptions["mode"];
  packages: string[];
  archiveFiles: string[];
  evidenceFiles: string[];
}> {
  if (options.baseUrl !== BASE_URL) throw new Error("Task 4 only permits http://127.0.0.1:8000");
  await assertFixedScripts(options.pixelleRoot);
  const completionTimeoutMs = safeInteger(options.completionTimeoutMs, 10 * 60_000, 30 * 60_000, "completion timeout");
  const pollIntervalMs = safeInteger(options.pollIntervalMs, 250, 10_000, "poll interval");
  const evidenceTtlMs = safeInteger(options.evidenceTtlMs, 60 * 60_000, 24 * 60 * 60_000, "evidence TTL");
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const packages = await inventoryGeneration(options);
  const packageNames = new Set(packages.map((pkg) => pkg.packageName));
  for (const packageName of Object.keys(options.parameters)) if (!packageNames.has(packageName)) throw new Error(`Parameters name unknown package ${packageName}`);
  const beforeSession = await dependencies.connect();
  const windowStartedAtMs = now();
  const beforeIdentity = await dependencies.observeListener();
  assertIdentity(beforeIdentity, "pre-restart");
  if (beforeSession.connectionId !== beforeIdentity.connectionId) throw new Error("Pre-restart connection is not bound to the listener identity");
  let system: Record<string, unknown>;
  let objects: Record<string, unknown>;
  const archiveFiles: string[] = [];
  const runs: Array<{ packageName: string; packageDigest: string; run: Record<string, unknown> }> = [];
  try {
    system = await beforeSession.systemStats();
    objects = await beforeSession.objectInfo();
    assertProbeSchemas(system, objects);
    const folders = [...new Set(packages.flatMap((pkg) => pkg.manifest.requirements.models.map((model) => model.folder)))];
    const models = new Map<string, string[]>();
    for (const folder of folders) models.set(folder, await beforeSession.models(folder));
    for (const pkg of packages) assertInventory(pkg, objects, models);
    if (options.mode === "inventory-only") return { mode: options.mode, packages: packages.map((pkg) => pkg.packageName), archiveFiles, evidenceFiles: [] };
    const backendFingerprint = hash(canonicalize({ baseUrl: BASE_URL, system, objects, listener: beforeIdentity }));
    let referenceAudioName: string | undefined;
    for (const pkg of packages) {
      const parameters = { ...(options.parameters[pkg.packageName] ?? {}) };
      for (const binding of pkg.compiled.bindings) {
        if (binding.source !== "voice-reference") continue;
        if (!options.referenceAudioFile) throw new Error(`${pkg.packageName} requires a controlled reference audio file`);
        if (!referenceAudioName) {
          const stat = await fs.lstat(options.referenceAudioFile);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 20 * 1024 * 1024) throw new Error("Reference audio must be a bounded regular no-link file");
          const referenceBytes = await fs.readFile(options.referenceAudioFile);
          if (path.extname(options.referenceAudioFile).toLowerCase() !== ".wav" || referenceBytes.subarray(0, 4).toString("ascii") !== "RIFF"
            || referenceBytes.subarray(8, 12).toString("ascii") !== "WAVE") throw new Error("Reference audio must be a controlled WAV file");
          referenceAudioName = await beforeSession.uploadReferenceAudio({ filename: path.basename(options.referenceAudioFile), bytes: referenceBytes, mimeType: "audio/wav" });
        }
        parameters[binding.key] = referenceAudioName;
      }
      const startedAtMs = now();
      const workflow = bindWorkflow(pkg.workflow, pkg.compiled, parameters, `task4/${pkg.packageName}/${randomUUID()}`);
      let promptId: string;
      try { promptId = await beforeSession.submit(workflow, beforeIdentity.connectionId); }
      catch (error) { throw new Error(`ComfyUI submission outcome is uncertain for ${pkg.packageName}`, { cause: error }); }
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(promptId)) throw new Error("ComfyUI returned an invalid prompt ID");
      const deadline = Date.now() + completionTimeoutMs;
      let history: Task4History | undefined;
      for (;;) {
        history = await beforeSession.history(promptId);
        const outcome = historyOutcome(history);
        if (outcome === "completed") break;
        if (outcome === "cancelled") throw new Error(`${pkg.packageName} execution was cancelled`);
        if (outcome === "failed") throw new Error(`${pkg.packageName} execution failed`);
        if (Date.now() >= deadline) throw new Error(`${pkg.packageName} completion remained unknown until timeout`);
        await sleep(pollIntervalMs);
      }
      const completedHistory = history;
      if (!completedHistory) throw new Error(`${pkg.packageName} completion history disappeared`);
      const output = pkg.compiled.outputs[0];
      const rawItems = record(completedHistory.outputs[output.nodeId], `${pkg.packageName} history output`)[output.field];
      if (!Array.isArray(rawItems) || rawItems.length !== 1) throw new Error(`${pkg.packageName} output history schema is malformed`);
      const item = record(rawItems[0], `${pkg.packageName} output item`);
      if (typeof item.filename !== "string" || typeof item.subfolder !== "string" || typeof item.type !== "string") throw new Error(`${pkg.packageName} output descriptor is malformed`);
      const downloaded = await beforeSession.download({ filename: item.filename, subfolder: item.subfolder, type: item.type }, pkg.manifest.limits.maxOutputBytes);
      if (!downloaded.bytes.length || downloaded.bytes.length > pkg.manifest.limits.maxOutputBytes || downloaded.mediaKind !== output.mediaKind) throw new Error(`${pkg.packageName} downloaded output is invalid or oversized`);
      const extension = path.extname(item.filename).toLowerCase();
      if (!/^\.[a-z0-9]{1,10}$/.test(extension)) throw new Error("ComfyUI output extension is unsafe");
      const archiveFile = path.join(path.resolve(options.archiveDir), `${pkg.packageName}-${promptId}${extension}`);
      await archiveBytes(archiveFile, downloaded.bytes);
      archiveFiles.push(archiveFile);
      const completedAtMs = now();
      runs.push({ packageName: pkg.packageName, packageDigest: pkg.packageDigest, run: {
        runId: promptId, startedAtMs, completedAtMs, backendFingerprint,
        listener: beforeIdentity,
        artifact: { sha256: hash(downloaded.bytes), mediaKind: downloaded.mediaKind, byteLength: downloaded.bytes.length },
      } });
    }
  } finally {
    await beforeSession.close();
  }
  const restart = await dependencies.restart();
  const latestCompletion = Math.max(...runs.map(({ run }) => run.completedAtMs as number));
  if (!(latestCompletion < restart.stoppedAtMs && restart.stoppedAtMs < restart.restartedAtMs)) throw new Error("Restart timestamps do not follow completed live runs");
  const afterSession = await dependencies.connect();
  let afterSystem: Record<string, unknown>;
  let afterObjects: Record<string, unknown>;
  const readinessAtMs = now();
  const afterIdentity = await dependencies.observeListener();
  try {
    assertIdentity(afterIdentity, "post-restart");
    if (afterSession.connectionId !== afterIdentity.connectionId) throw new Error("Post-restart connection is not bound to the listener identity");
    if (beforeIdentity.pid === afterIdentity.pid || beforeIdentity.processIdentity === afterIdentity.processIdentity
      || beforeIdentity.processCreatedAtMs === afterIdentity.processCreatedAtMs || beforeIdentity.connectionId === afterIdentity.connectionId) {
      throw new Error("ComfyUI listener process/connection identity did not change after restart");
    }
    afterSystem = await afterSession.systemStats();
    afterObjects = await afterSession.objectInfo();
    assertProbeSchemas(afterSystem, afterObjects);
  } finally {
    await afterSession.close();
  }
  const reconnectedAtMs = now();
  if (!(restart.restartedAtMs < readinessAtMs && readinessAtMs <= reconnectedAtMs)) throw new Error("Fresh readiness/reconnection timeline is invalid");
  const issuedAtMs = now();
  const privateKey = options.privateKey ?? await loadProductionTask4PrivateKey();
  await fs.mkdir(path.resolve(options.evidenceDir), { recursive: true });
  const evidenceFiles: string[] = [];
  for (const pkg of packages) {
    const selected = runs.filter((run) => run.packageName === pkg.packageName).map((run) => run.run);
    const backendFingerprint = selected[0].backendFingerprint;
    const payload = {
      schemaVersion: 1, producer: "ai-m/task4-comfyui-live-verify-v1", windowStartedAtMs, issuedAtMs, expiresAtMs: issuedAtMs + evidenceTtlMs,
      generationDigest: options.expectedGenerationDigest, packageName: pkg.packageName, packageDigest: pkg.packageDigest, backendFingerprint,
      listener: { baseUrl: BASE_URL, ...afterIdentity }, liveRuns: selected,
      restart: { before: beforeIdentity, after: afterIdentity, stoppedAtMs: restart.stoppedAtMs, restartedAtMs: restart.restartedAtMs, readinessAtMs, reconnectedAtMs },
      readiness: {
        checkedAtMs: readinessAtMs,
        systemStats: { path: "/system_stats", statusCode: 200, responseSha256: hash(canonicalize(afterSystem)) },
        objectInfo: { path: "/object_info", statusCode: 200, responseSha256: hash(canonicalize(afterObjects)) },
      },
    };
    const evidence = signTask4Evidence(payload, privateKey);
    await verifyGenerationPackageForImport({
      generationRoot: options.generationRoot, packageName: pkg.packageName, expectedGenerationDigest: options.expectedGenerationDigest,
      expectedPackageDigest: pkg.packageDigest, verifiedEvidence: evidence, trustRootPublicKey: options.publicKey, nowMs: issuedAtMs,
    });
    const evidenceFile = path.join(path.resolve(options.evidenceDir), `${pkg.packageName}.json`);
    await archiveBytes(evidenceFile, Buffer.from(`${canonicalize(evidence)}\n`));
    evidenceFiles.push(evidenceFile);
  }
  return { mode: options.mode, packages: packages.map((pkg) => pkg.packageName), archiveFiles, evidenceFiles };
}

async function main(): Promise<void> {
  const required = (name: string): string => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const stagingDir = path.resolve(required("PIXELLE_WORKFLOW_STAGING_DIR"));
  const currentFile = path.join(stagingDir, "current.json");
  const currentStat = await fs.lstat(currentFile);
  if (!currentStat.isFile() || currentStat.isSymbolicLink() || currentStat.size > 64 * 1024) throw new Error("current.json is unsafe or oversized");
  const current = record(parseJson(await fs.readFile(currentFile), "current.json"), "current.json");
  if (typeof current.generationDigest !== "string" || !DIGEST.test(current.generationDigest)) throw new Error("current.json generation digest is invalid");
  const mode = parseTask4Mode(process.env);
  const parametersFile = process.env.TASK4_PARAMETERS_FILE?.trim();
  let parameters: Record<string, Record<string, unknown>> = {};
  if (parametersFile) {
    const resolved = path.resolve(parametersFile); const stat = await fs.lstat(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) throw new Error("TASK4_PARAMETERS_FILE is unsafe or oversized");
    const raw = record(parseJson(await fs.readFile(resolved), "TASK4_PARAMETERS_FILE"), "TASK4_PARAMETERS_FILE");
    parameters = Object.fromEntries(Object.entries(raw).map(([packageName, value]) => [packageName, record(value, `parameters.${packageName}`)]));
  }
  const pixelleRoot = path.resolve(required("PIXELLE_ROOT"));
  const dataRoot = path.resolve(required("AI_M_MANAGED_COMFYUI_DATA_ROOT"));
  const pythonExe = path.resolve(required("AI_M_MANAGED_COMFYUI_PYTHON_EXE"));
  const commandTimeoutMs = safeInteger(Number(required("AI_M_MANAGED_COMFYUI_COMMAND_TIMEOUT_MS")), 0, 600_000, "command timeout");
  const readyTimeoutMs = safeInteger(Number(required("AI_M_MANAGED_COMFYUI_READY_TIMEOUT_MS")), 0, 900_000, "ready timeout");
  for (const [value, kind, label] of [[dataRoot, "directory", "data root"], [pythonExe, "file", "Python executable"]] as const) {
    const stat = await fs.stat(value);
    if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) throw new Error(`${label} has the wrong path type`);
  }
  let activeConnectionId = "";
  const connect = async () => { const session = await createHttpSession(); activeConnectionId = session.connectionId; return session; };
  const observeListener = async (): Promise<Task4ListenerIdentity> => {
    if (process.platform !== "win32") throw new Error("Task 4 listener identity observation requires Windows");
    const script = [
      "$ErrorActionPreference='Stop'",
      "$listeners=@(Get-NetTCPConnection -State Listen -LocalPort 8000 | Where-Object {$_.LocalAddress -eq '127.0.0.1'})",
      "if($listeners.Count -ne 1){throw ('Expected exactly one 127.0.0.1:8000 listener; found '+$listeners.Count)}",
      "$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listeners[0].OwningProcess)",
      "$os=Get-CimInstance Win32_OperatingSystem",
      "[ordered]@{pid=[int]$p.ProcessId;created=[DateTimeOffset]$p.CreationDate;boot=[DateTimeOffset]$os.LastBootUpTime}|ConvertTo-Json -Compress",
    ].join(";");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 });
    const value = record(parseJson(Buffer.from(stdout), "listener identity"), "listener identity");
    const pid = value.pid; const created = Date.parse(String(value.created)); const boot = Date.parse(String(value.boot));
    if (!Number.isSafeInteger(pid) || !Number.isFinite(created) || !Number.isFinite(boot)) throw new Error("Listener identity schema is malformed");
    return { pid: pid as number, processCreatedAtMs: created, bootId: `windows-${boot}`, processIdentity: `windows-${boot}:${pid}:${created}`, connectionId: activeConnectionId };
  };
  const runner = createPowerShellCommandRunner();
  const runScript = async (name: "stop_backend.ps1" | "start_backend.ps1") => {
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(pixelleRoot, "scripts", "comfyui", name), "-Json", "-DataRoot", dataRoot, "-PythonExe", pythonExe, "-HostAddress", "127.0.0.1", "-Port", "8000"];
    if (name === "start_backend.ps1") args.push("-ReadyTimeoutSeconds", String(Math.max(1, Math.ceil(readyTimeoutMs / 1000))));
    const result = await runner({ executable: "powershell.exe", args, cwd: pixelleRoot, timeoutMs: commandTimeoutMs, maxOutputBytes: 64 * 1024, windowsHide: true });
    if (result.exitCode !== 0 || result.truncated) throw new Error(`${name} failed or returned oversized output`);
  };
  const result = await verifySingleComfyUI({
    baseUrl: BASE_URL, mode, pixelleRoot,
    generationRoot: path.join(stagingDir, "generations", current.generationDigest), expectedGenerationDigest: current.generationDigest,
    evidenceDir: path.resolve(process.env.TASK4_EVIDENCE_DIR?.trim() || path.join(stagingDir, "task4-evidence", current.generationDigest)),
    archiveDir: path.resolve(process.env.TASK4_ARCHIVE_DIR?.trim() || path.join(stagingDir, "task4-artifacts", current.generationDigest)),
    parameters, referenceAudioFile: process.env.TASK4_REFERENCE_AUDIO_FILE?.trim(),
    completionTimeoutMs: process.env.TASK4_COMPLETION_TIMEOUT_MS ? Number(process.env.TASK4_COMPLETION_TIMEOUT_MS) : undefined,
    pollIntervalMs: process.env.TASK4_POLL_INTERVAL_MS ? Number(process.env.TASK4_POLL_INTERVAL_MS) : undefined,
  }, {
    connect, observeListener,
    restart: async () => { await runScript("stop_backend.ps1"); const stoppedAtMs = Date.now(); await runScript("start_backend.ps1"); return { stoppedAtMs, restartedAtMs: Date.now() }; },
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
