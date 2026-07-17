import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketStream } from "undici";
import { bindWorkflow } from "../src/lib/generation/workflows/binder";
import { canonicalize } from "../src/lib/generation/workflows/canonical";
import { parseCompiledBindings } from "../src/lib/generation/workflows/compiled";
import { parseWorkflowManifest } from "../src/lib/generation/workflows/manifest";
import { normalizeComfyWorkflow } from "../src/lib/generation/workflows/normalize";
import type { ComfyWorkflow, CompiledBindings, WorkflowManifest } from "../src/lib/generation/workflows/types";
import { loadProductionTask4PrivateKey } from "./pixelle-trust-store";
import { signTask4Evidence, verifyGenerationPackageForImport, verifyPreparedGenerationPackage } from "./verify-generation-package";
import { createPowerShellCommandRunner } from "../src/lib/generation/runtime/managed-comfyui-runtime";
import { comparePixelleProcessIdentity, getPixelleProcessIdentity, getPixelleProcessLiveness } from "./pixelle-process-identity";

const BASE_URL = "http://127.0.0.1:8000" as const;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_ARRAY_ITEMS = 10_000;
const execFileAsync = promisify(execFile);

export interface Task4ListenerIdentity {
  pid: number;
  processCreatedAtMs: number;
  bootId: string;
  processIdentity: string;
}

export interface Task4History {
  status: { status_str?: string; statusStr?: string; completed: boolean; messages?: Array<[string, Record<string, unknown>]> };
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
  downloadToFile(file: { filename: string; subfolder: string; type: string }, targetFile: string, maximumBytes: number): Promise<{ sha256: string; byteLength: number; mediaKind: "audio" | "image" | "video" }>;
  assertHealthy(): void;
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
  committedDir?: string;
  blockedMarkerFile?: string;
  recoveryConfirmation?: string;
  lockFile?: string;
  prepareLockFile?: string;
}

export interface Task4Dependencies {
  connect(): Promise<Task4Session>;
  observeListener(): Promise<Task4ListenerIdentity>;
  restart(): Promise<{ stoppedAtMs: number; restartedAtMs: number }>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Test seam only. Production always requires the fixed six-package set. */
  expectedPackageNames?: readonly string[];
  writeRestartMarker?: (file: string, payload: Record<string, unknown>) => Promise<void>;
  removeRestartMarker?: (file: string) => Promise<void>;
  afterRestartMarker?: () => Promise<void>;
  processIdentityForPid?: (pid: number) => Promise<string | "missing" | "unknown">;
  isProcessAlive?: (pid: number) => Promise<boolean | "unknown">;
  lockStaleMs?: number;
  beforeFinalCurrentCheck?: () => Promise<void>;
}

const PIXELLE_PACKAGE_NAMES = ["tts-index2", "tts-index2-8g", "tts-omnivoice-longform-bf16", "tts-omnivoice-clone-duration-bf16", "image-z-image-turbo", "video-wan2.1-fusionx"] as const;

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
export function parseTask4Json(bytes: Buffer, label: string, maximumNodes = 100_000): unknown {
  if (!Number.isSafeInteger(maximumNodes) || maximumNodes < 1 || maximumNodes > 500_000) throw new Error(`${label} node bound is invalid`);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is invalid JSON`); }
  let count = 0;
  const inspect = (candidate: unknown, depth: number) => {
    count += 1;
    if (depth > MAX_JSON_DEPTH || count > maximumNodes) throw new Error(`${label} exceeds structural bounds`);
    if (typeof candidate === "string" && Buffer.byteLength(candidate) > MAX_CONFIG_BYTES) throw new Error(`${label} contains an oversized string`);
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_JSON_ARRAY_ITEMS) throw new Error(`${label} array exceeds its bounded length`);
      for (const item of candidate) inspect(item, depth + 1);
    }
    else if (candidate && typeof candidate === "object") for (const item of Object.values(candidate)) inspect(item, depth + 1);
  };
  inspect(value, 0);
  return value;
}
const parseJson = parseTask4Json;
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
  ) throw new Error(`${label} listener identity is uncertain`);
}

export function parseTask4ListenerObservation(input: unknown): Task4ListenerIdentity {
  const value = record(input, "listener identity"); const pid = value.pid; const created = value.createdMs; const boot = value.bootMs;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || !Number.isSafeInteger(created) || (created as number) <= 0 || !Number.isSafeInteger(boot) || (boot as number) <= 0) {
    throw new Error("Listener identity schema is malformed");
  }
  return { pid: pid as number, processCreatedAtMs: created as number, bootId: `windows-${boot}`, processIdentity: `windows-${boot}:${pid}:${created}` };
}
function sameListener(left: Task4ListenerIdentity, right: Task4ListenerIdentity): boolean {
  return left.pid === right.pid && left.processCreatedAtMs === right.processCreatedAtMs && left.bootId === right.bootId && left.processIdentity === right.processIdentity;
}
function assertProbeSchemas(system: Record<string, unknown>, objects: Record<string, unknown>): void {
  const systemRecord = record(system.system, "system_stats.system");
  if (!Object.keys(systemRecord).length || !Array.isArray(system.devices)) throw new Error("system_stats schema is malformed");
  if (!Object.keys(objects).length) throw new Error("object_info schema is malformed");
}
function assertRawNodeDescriptor(value: unknown, classType: string): Record<string, unknown> {
  const descriptor = record(value, `${classType} object_info`);
  if (!descriptor.input || typeof descriptor.input !== "object" || Array.isArray(descriptor.input)
    || !Array.isArray(descriptor.output) || !descriptor.output.every((item) => typeof item === "string")
    || !Array.isArray(descriptor.output_name) || !descriptor.output_name.every((item) => typeof item === "string")
    || !Array.isArray(descriptor.output_is_list) || !descriptor.output_is_list.every((item) => typeof item === "boolean")
    || descriptor.output.length !== descriptor.output_name.length || descriptor.output.length !== descriptor.output_is_list.length
    || descriptor.name !== classType || (descriptor.display_name !== null && typeof descriptor.display_name !== "string") || typeof descriptor.description !== "string"
    || typeof descriptor.output_node !== "boolean") {
    throw new Error(`${classType} raw object_info descriptor is malformed`);
  }
  return descriptor;
}
function assertInventory(pkg: PackageInventory, objects: Record<string, unknown>, models: Map<string, string[]>): void {
  for (const nodeClass of pkg.manifest.requirements.nodeClasses) {
    if (!objects[nodeClass] || typeof objects[nodeClass] !== "object") throw new Error(`${pkg.packageName} is missing required node ${nodeClass}`);
    assertRawNodeDescriptor(objects[nodeClass], nodeClass);
  }
  for (const binding of pkg.compiled.bindings) {
    const descriptor = assertRawNodeDescriptor(objects[binding.classType], binding.classType);
    const inputs = record(descriptor.input, `${binding.classType} object_info.input`);
    const required = inputs.required && typeof inputs.required === "object" && !Array.isArray(inputs.required) ? inputs.required as Record<string, unknown> : {};
    const optional = inputs.optional && typeof inputs.optional === "object" && !Array.isArray(inputs.optional) ? inputs.optional as Record<string, unknown> : {};
    const tuple = required[binding.inputName] ?? optional[binding.inputName];
    if (!Array.isArray(tuple) || tuple.length < 1 || tuple.length > 2) throw new Error(`${pkg.packageName} binding ${binding.key} has malformed actual input tuple`);
    const actualType = tuple[0];
    const expectedType = binding.valueType === "integer" ? "INT" : binding.valueType === "number" ? "FLOAT" : binding.valueType === "string" ? "STRING" : undefined;
    if (expectedType && actualType !== expectedType) throw new Error(`${pkg.packageName} binding ${binding.key} actual type is not ${expectedType}`);
    if (binding.source === "voice-reference" && actualType !== "STRING" && !(Array.isArray(actualType) && actualType.every((item) => typeof item === "string"))) {
      throw new Error(`${pkg.packageName} voice reference actual type is malformed`);
    }
    if ((binding.valueType === "integer" || binding.valueType === "number") && (binding.minimum !== undefined || binding.maximum !== undefined)) {
      const config = tuple[1];
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${pkg.packageName} numeric binding ${binding.key} lacks actual range metadata`);
      const range = config as Record<string, unknown>;
      if (binding.minimum !== undefined && (typeof range.min !== "number" || range.min > binding.minimum)) throw new Error(`${pkg.packageName} numeric binding ${binding.key} actual minimum is incompatible`);
      if (binding.maximum !== undefined && (typeof range.max !== "number" || range.max < binding.maximum)) throw new Error(`${pkg.packageName} numeric binding ${binding.key} actual maximum is incompatible`);
    }
  }
  for (const output of pkg.compiled.outputs) {
    const descriptor = assertRawNodeDescriptor(objects[output.classType], output.classType);
    if (descriptor.output_node !== true) throw new Error(`${pkg.packageName} output node is not declared as output_node`);
    if ((output.classType === "SaveImage" || output.classType === "SaveAudio") && (descriptor.output as unknown[]).length !== 0) throw new Error(`${pkg.packageName} save output node must have empty RETURN_TYPES`);
    if (output.classType === "VHS_VideoCombine" && canonicalize(descriptor.output) !== canonicalize(["VHS_FILENAMES"])) throw new Error(`${pkg.packageName} video output node must return VHS_FILENAMES`);
    const outputInputs = record(descriptor.input, `${output.classType} output input`);
    const outputRequired = record(outputInputs.required, `${output.classType} required output input`);
    const inputName = output.classType === "SaveAudio" ? "audio" : "images";
    const tuple = outputRequired[inputName];
    if (!Array.isArray(tuple) || tuple.length < 1 || (output.classType === "SaveAudio" ? tuple[0] !== "AUDIO" : typeof tuple[0] !== "string" || !String(tuple[0]).includes("IMAGE"))) {
      throw new Error(`${pkg.packageName} output node input schema is incompatible`);
    }
  }
  for (const model of pkg.manifest.requirements.models) {
    if (!(models.get(model.folder) ?? []).map((candidate) => candidate.replace(/\\/g, "/")).includes(model.filename.replace(/\\/g, "/"))) throw new Error(`${pkg.packageName} is missing required model ${model.folder}/${model.filename}`);
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

async function assertCurrentGeneration(options: VerifySingleOptions): Promise<void> {
  const stagingDir = path.dirname(path.dirname(path.resolve(options.generationRoot)));
  const currentFile = path.join(stagingDir, "current.json"); const stat = await fs.lstat(currentFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("current.json is unsafe or oversized");
  const current = record(parseJson(await fs.readFile(currentFile), "current.json"), "current.json");
  if (current.generationDigest !== options.expectedGenerationDigest) throw new Error("current.json changed away from the locked Task 4 generation");
}

function historyOutcome(history: Task4History | undefined): "completed" | "cancelled" | "failed" | "unknown" {
  if (!history) return "unknown";
  const status = (history.status?.status_str ?? history.status?.statusStr)?.trim().toLowerCase();
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

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EINVAL")) throw error;
  } finally { await handle.close(); }
}

async function writeBlockedMarker(file: string, payload: Record<string, unknown>): Promise<void> {
  const target = path.resolve(file); await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  await archiveBytes(temp, Buffer.from(`${canonicalize(payload)}\n`));
  try { await fs.rename(temp, target); await syncDirectory(path.dirname(target)); }
  catch (error) { await fs.rm(temp, { force: true }); throw error; }
}

async function removeBlockedMarker(file: string): Promise<void> {
  await fs.rm(path.resolve(file)); await syncDirectory(path.dirname(path.resolve(file)));
}

function combinedError(primary: unknown, cleanup: unknown[], label: string): Error {
  const errors = [primary, ...cleanup].filter((error): error is Error => error instanceof Error);
  if (errors.length === 1) return errors[0];
  return new AggregateError(errors, `${label}: ${errors.map((error) => error.message).join("; ")}`);
}

interface Task4LockRecord { schemaVersion: 2; pid: number; processIdentity: string; token: string; startedAtMs: number }
let currentTask4ProcessIdentity: Promise<string | "missing" | "unknown"> | undefined;
function defaultProcessIdentityForPid(pid: number): Promise<string | "missing" | "unknown"> {
  if (pid !== process.pid) return getPixelleProcessIdentity(pid);
  currentTask4ProcessIdentity ??= getPixelleProcessIdentity(pid);
  return currentTask4ProcessIdentity;
}
function parseTask4Lock(value: unknown, lockName = "task4.lock"): Task4LockRecord {
  const lock = record(value, lockName);
  if (lock.schemaVersion !== 2 || !Number.isSafeInteger(lock.pid) || (lock.pid as number) <= 0 || typeof lock.processIdentity !== "string"
    || !/^[A-Za-z0-9._:-]{3,300}$/.test(lock.processIdentity) || typeof lock.token !== "string" || !/^[a-f0-9-]{20,100}$/.test(lock.token)
    || !Number.isSafeInteger(lock.startedAtMs) || (lock.startedAtMs as number) <= 0) throw new Error(`${lockName} is invalid; ownership is uncertain`);
  return lock as unknown as Task4LockRecord;
}
async function acquireTask4Lock(file: string, dependencies: Task4Dependencies): Promise<Task4LockRecord> {
  const target = path.resolve(file); const lockName = path.basename(target); const now = dependencies.now ?? Date.now; const staleMs = dependencies.lockStaleMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(staleMs) || staleMs < 1_000) throw new Error("Task 4 lock stale threshold is invalid");
  const identityFor = dependencies.processIdentityForPid ?? defaultProcessIdentityForPid;
  const processIdentity = await identityFor(process.pid); if (processIdentity === "missing" || processIdentity === "unknown") throw new Error("Current Task 4 process identity is uncertain");
  const owned = { schemaVersion: 2 as const, pid: process.pid, processIdentity, token: randomUUID().replace(/-/g, ""), startedAtMs: now() };
  await fs.mkdir(path.dirname(target), { recursive: true });
  for (;;) {
    try { await archiveBytes(target, Buffer.from(`${canonicalize(owned)}\n`)); await syncDirectory(path.dirname(target)); return owned; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.lstat(target); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_096) throw new Error(`${lockName} is unsafe`);
      const raw = await fs.readFile(target); const existing = parseTask4Lock(parseJson(raw, lockName), lockName);
      if (now() - existing.startedAtMs <= staleMs) throw new Error(`Task 4 is locked by an active ${lockName}`);
      const alive = await (dependencies.isProcessAlive ?? getPixelleProcessLiveness)(existing.pid);
      if (alive === "unknown") throw new Error("Stale Task 4 lock owner liveness is uncertain");
      if (alive) {
        const observed = await identityFor(existing.pid);
        if (observed === "unknown" || observed === "missing") throw new Error("Stale Task 4 lock owner identity is uncertain");
        const sameIdentity = comparePixelleProcessIdentity(existing.processIdentity, observed, existing.pid);
        if (sameIdentity === "unknown") throw new Error("Stale Task 4 lock uses an unsupported legacy process identity; manual recovery audit is required");
        if (sameIdentity) throw new Error("Task 4 is locked by the original live process");
      }
      if (!(await fs.readFile(target)).equals(raw)) throw new Error(`${lockName} changed during stale recovery`);
      await fs.rename(target, `${target}.stale.${existing.token}`); await syncDirectory(path.dirname(target));
    }
  }
}
async function releaseTask4Lock(file: string, owned: Task4LockRecord): Promise<void> {
  const target = path.resolve(file); const lockName = path.basename(target); const current = parseTask4Lock(parseJson(await fs.readFile(target), lockName), lockName);
  if (canonicalize(current) !== canonicalize(owned)) throw new Error(`${lockName} ownership was lost`);
  await fs.rm(target); await syncDirectory(path.dirname(target));
}

async function responseBytes(response: Response, maximumBytes: number, label: string): Promise<Buffer> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`${label} failed (${response.status})`); }
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    await response.body?.cancel();
    throw new Error(`${label} response is oversized`);
  }
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

async function fetchJson(url: string, init: RequestInit, maximumBytes: number, label: string, maximumNodes?: number): Promise<unknown> {
  const signal = AbortSignal.timeout(30_000);
  return parseJson(await responseBytes(await fetch(url, { ...init, signal }), maximumBytes, label), label, maximumNodes);
}
export async function writeAllBytes(handle: Pick<Awaited<ReturnType<typeof fs.open>>, "write">, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.byteLength - offset) throw new Error("Output file write made invalid progress");
    offset += bytesWritten;
  }
}

export async function createHttpSession(baseUrl = BASE_URL): Promise<Task4Session> {
  const connectionId = `task4-${randomUUID()}`;
  let closed = false;
  let unhealthy: Error | undefined;
  const websocketUrl = new URL(baseUrl); websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:"; websocketUrl.pathname = "/ws"; websocketUrl.search = `clientId=${encodeURIComponent(connectionId)}`;
  const abortController = new AbortController(); const socket = new WebSocketStream(websocketUrl, { signal: abortController.signal }); const socketClosed = socket.closed;
  void socketClosed.catch(() => undefined);
  const bounded = async <T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  let opened: Awaited<typeof socket.opened>;
  try {
    opened = await bounded(socket.opened, 30_000, "ComfyUI WebSocket connection timed out");
  } catch (error) { abortController.abort(error); throw new Error("ComfyUI WebSocket connection failed", { cause: error }); }
  const drainPromise = (async () => {
    const reader = opened.readable.getReader();
    try { for (;;) { const part = await reader.read(); if (part.done) return; } }
    finally { reader.releaseLock(); }
  })().catch((error) => { if (!closed) unhealthy ??= new Error("ComfyUI WebSocket reported an error", { cause: error }); });
  void socketClosed.then(
    () => { if (!closed) unhealthy ??= new Error("ComfyUI WebSocket closed unexpectedly"); },
    (error) => { if (!closed) unhealthy ??= new Error("ComfyUI WebSocket reported an error", { cause: error }); },
  );
  const ensureOpen = () => { if (closed) throw new Error("ComfyUI session is closed"); };
  return {
    connectionId,
    async systemStats() { ensureOpen(); return record(await fetchJson(`${baseUrl}/system_stats`, {}, 1024 * 1024, "system_stats"), "system_stats"); },
    async objectInfo() { ensureOpen(); return record(await fetchJson(`${baseUrl}/object_info`, {}, 16 * 1024 * 1024, "object_info", 200_000), "object_info"); },
    async models(folder) {
      ensureOpen();
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(folder)) throw new Error("Model folder is unsafe");
      const value = await fetchJson(`${baseUrl}/models/${encodeURIComponent(folder)}`, {}, 4 * 1024 * 1024, "models");
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length <= 500)) throw new Error("models schema is malformed");
      return value;
    },
    async uploadReferenceAudio(input) {
      ensureOpen();
      const data = new FormData();
      data.set("image", new Blob([Uint8Array.from(input.bytes)], { type: input.mimeType }), input.filename);
      data.set("type", "input"); data.set("overwrite", "false");
      const result = record(await fetchJson(`${baseUrl}/upload/image`, { method: "POST", body: data }, 64 * 1024, "reference upload"), "reference upload");
      if (typeof result.name !== "string" || !result.name || result.name.length > 300 || typeof result.subfolder !== "string") throw new Error("Reference upload schema is malformed");
      return result.subfolder ? `${result.subfolder.replace(/\\/g, "/")}/${result.name}` : result.name;
    },
    async submit(workflow, clientId) {
      ensureOpen();
      const result = record(await fetchJson(`${baseUrl}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: workflow, client_id: clientId }) }, 64 * 1024, "prompt submission"), "prompt submission");
      if (typeof result.prompt_id !== "string") throw new Error("Prompt submission schema is malformed");
      return result.prompt_id;
    },
    async history(promptId) {
      ensureOpen();
      const result = record(await fetchJson(`${baseUrl}/history/${encodeURIComponent(promptId)}`, {}, 16 * 1024 * 1024, "history"), "history");
      if (!(promptId in result)) return undefined;
      const item = record(result[promptId], "history item");
      const status = record(item.status, "history status");
      const outputsRaw = record(item.outputs, "history outputs");
      const outputs: Record<string, Record<string, unknown>> = {};
      for (const [nodeId, output] of Object.entries(outputsRaw)) outputs[nodeId] = record(output, `history output ${nodeId}`);
      if (typeof status.status_str !== "string" || typeof status.completed !== "boolean") throw new Error("History status schema is malformed");
      return { status: status as unknown as Task4History["status"], outputs };
    },
    async downloadToFile(file, targetFile, maximumBytes) {
      ensureOpen();
      const query = new URLSearchParams(file);
      const response = await fetch(`${baseUrl}/view?${query}`, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`output download failed (${response.status})`); }
      const declared = response.headers.get("content-length");
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) { await response.body?.cancel(); throw new Error("output download response is oversized"); }
      const mime = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() ?? "";
      const mediaKind = mime.startsWith("audio/") ? "audio" : mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : undefined;
      if (!mediaKind) { await response.body?.cancel(); throw new Error("Output content type is unsupported"); }
      const reader = response.body?.getReader(); if (!reader) throw new Error("Output response body is missing");
      let handle: Awaited<ReturnType<typeof fs.open>>;
      try { handle = await fs.open(targetFile, "wx"); }
      catch (error) { await reader.cancel().catch(() => undefined); throw error; }
      const digest = createHash("sha256"); let byteLength = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          byteLength += part.value.byteLength;
          if (byteLength > maximumBytes) throw new Error("Output download response is oversized");
          digest.update(part.value);
          await writeAllBytes(handle, part.value);
        }
        if (!byteLength) throw new Error("Output download is empty");
        await handle.sync();
      } catch (error) {
        await reader.cancel().catch(() => undefined); await handle.close().catch(() => undefined); await fs.rm(targetFile, { force: true }); throw error;
      }
      await handle.close();
      const expectedSha256 = digest.digest("hex"); const stat = await fs.lstat(targetFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== byteLength) { await fs.rm(targetFile, { force: true }); throw new Error("Output temp file size changed after fsync"); }
      const verifiedDigest = createHash("sha256"); let verifiedBytes = 0; const verifyHandle = await fs.open(targetFile, "r");
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        for (;;) { const { bytesRead } = await verifyHandle.read(buffer, 0, buffer.length); if (!bytesRead) break; verifiedBytes += bytesRead; if (verifiedBytes > maximumBytes) throw new Error("Output temp file grew after fsync"); verifiedDigest.update(buffer.subarray(0, bytesRead)); }
      } finally { await verifyHandle.close(); }
      const sha256 = verifiedDigest.digest("hex");
      if (verifiedBytes !== byteLength || sha256 !== expectedSha256) { await fs.rm(targetFile, { force: true }); throw new Error("Output temp file digest changed after fsync"); }
      return { sha256, byteLength, mediaKind };
    },
    assertHealthy() {
      ensureOpen();
      if (unhealthy) throw unhealthy;
    },
    async close() {
      if (closed) return; closed = true;
      try {
        socket.close({ closeCode: 1000, reason: "task4 session complete" });
        await bounded(socketClosed, 5_000, "ComfyUI WebSocket close timed out"); await drainPromise;
      } catch (error) {
        abortController.abort(error); throw error;
      }
    },
  };
}

async function verifySingleComfyUILocked(options: VerifySingleOptions, dependencies: Task4Dependencies): Promise<{
  mode: VerifySingleOptions["mode"];
  packages: string[];
  archiveFiles: string[];
  evidenceFiles: string[];
}> {
  if (options.baseUrl !== BASE_URL) throw new Error("Task 4 only permits http://127.0.0.1:8000");
  await assertFixedScripts(options.pixelleRoot);
  await assertCurrentGeneration(options);
  const completionTimeoutMs = safeInteger(options.completionTimeoutMs, 10 * 60_000, 30 * 60_000, "completion timeout");
  const pollIntervalMs = safeInteger(options.pollIntervalMs, 250, 10_000, "poll interval");
  const evidenceTtlMs = safeInteger(options.evidenceTtlMs, 60 * 60_000, 24 * 60 * 60_000, "evidence TTL");
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const packages = await inventoryGeneration(options);
  const expectedPackageNames = [...(dependencies.expectedPackageNames ?? PIXELLE_PACKAGE_NAMES)].sort();
  const actualPackageNames = packages.map((pkg) => pkg.packageName).sort();
  if (canonicalize(actualPackageNames) !== canonicalize(expectedPackageNames)) throw new Error("Current generation must contain the exact fixed Pixelle package set");
  const packageNames = new Set(packages.map((pkg) => pkg.packageName));
  for (const packageName of Object.keys(options.parameters)) if (!packageNames.has(packageName)) throw new Error(`Parameters name unknown package ${packageName}`);
  const blockedMarkerFile = path.resolve(options.blockedMarkerFile ?? path.join(path.dirname(path.dirname(options.generationRoot)), "task4-restart-blocked.json"));
  const writeRestartMarker = dependencies.writeRestartMarker ?? writeBlockedMarker;
  const removeRestartMarker = dependencies.removeRestartMarker ?? removeBlockedMarker;
  try {
    const stat = await fs.lstat(blockedMarkerFile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Task 4 restart blocked marker is unsafe");
    if (options.recoveryConfirmation !== `RECOVER-${options.expectedGenerationDigest}`) throw new Error("Task 4 restart is blocked pending explicit external recovery verification");
    const recoverySession = await dependencies.connect();
    try {
      recoverySession.assertHealthy(); const recoveryIdentity = await dependencies.observeListener(); assertIdentity(recoveryIdentity, "recovery");
      assertProbeSchemas(await recoverySession.systemStats(), await recoverySession.objectInfo()); recoverySession.assertHealthy();
      const recoveryAfterProbe = await dependencies.observeListener(); assertIdentity(recoveryAfterProbe, "recovery post-probe");
      if (!sameListener(recoveryIdentity, recoveryAfterProbe)) throw new Error("Recovery listener changed during readiness probes");
    }
    finally { await recoverySession.close(); }
    await removeRestartMarker(blockedMarkerFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let session = await dependencies.connect();
  let currentIdentity: Task4ListenerIdentity;
  try { currentIdentity = await dependencies.observeListener(); assertIdentity(currentIdentity, "initial"); session.assertHealthy(); }
  catch (error) {
    const cleanup: unknown[] = []; try { await session.close(); } catch (closeError) { cleanup.push(closeError); }
    throw combinedError(error, cleanup, "Initial Task 4 session validation failed and close was not fully verified");
  }
  let system: Record<string, unknown>; let objects: Record<string, unknown>;
  try {
    system = await session.systemStats(); objects = await session.objectInfo(); assertProbeSchemas(system, objects);
    const folders = [...new Set(packages.flatMap((pkg) => pkg.manifest.requirements.models.map((model) => model.folder)))];
    const models = new Map<string, string[]>(); for (const folder of folders) models.set(folder, await session.models(folder));
    for (const pkg of packages) assertInventory(pkg, objects, models);
  } catch (error) { await session.close().catch(() => undefined); throw error; }
  if (options.mode === "inventory-only") {
    await session.close();
    return { mode: options.mode, packages: packages.map((pkg) => pkg.packageName), archiveFiles: [], evidenceFiles: [] };
  }

  const committedDir = path.resolve(options.committedDir ?? options.evidenceDir);
  try { await fs.lstat(committedDir); throw new Error("Task 4 committed set already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { await session.close().catch(() => undefined); throw error; } }
  await fs.mkdir(path.dirname(committedDir), { recursive: true });
  const runToken = randomUUID();
  const runDir = path.join(path.dirname(committedDir), `.${path.basename(committedDir)}.run-${runToken}`);
  await fs.mkdir(runDir, { recursive: false }); await fs.mkdir(path.join(runDir, "artifacts"), { recursive: false }); await fs.mkdir(path.join(runDir, "evidence"), { recursive: false });
  const windowStartedAtMs = now(); const archiveRelative: string[] = []; const evidenceRelative: string[] = [];
  const evidenceFacts: Array<{ pkg: PackageInventory; payload: Record<string, unknown> }> = [];
  let previousAfter: (Task4ListenerIdentity & { connectionId: string }) | undefined;
  let referenceAudioName: string | undefined; const privateKey = options.privateKey ?? await loadProductionTask4PrivateKey();
  try {
    for (const pkg of packages) {
      session.assertHealthy();
      const packageIdentity = await dependencies.observeListener(); assertIdentity(packageIdentity, `${pkg.packageName} pre-run`);
      const beforeConnectionId = session.connectionId;
      const packageBefore = { ...packageIdentity, connectionId: beforeConnectionId };
      if (previousAfter && canonicalize(previousAfter) !== canonicalize(packageBefore)) throw new Error(`${pkg.packageName} listener.before does not continue the previous package restart.after chain`);
      if (!sameListener(packageIdentity, currentIdentity)) throw new Error(`${pkg.packageName} listener changed spontaneously before submit`);
      const backendFingerprint = hash(canonicalize({ baseUrl: BASE_URL, system, objects, listener: packageIdentity }));
      const parameters = { ...(options.parameters[pkg.packageName] ?? {}) };
      for (const binding of pkg.compiled.bindings) {
        if (binding.source !== "voice-reference") continue;
        if (!options.referenceAudioFile) throw new Error(`${pkg.packageName} requires a controlled reference audio file`);
        if (!referenceAudioName) {
          const stat = await fs.lstat(options.referenceAudioFile);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 12 || stat.size > 20 * 1024 * 1024) throw new Error("Reference audio must be a bounded regular no-link file");
          const referenceBytes = await fs.readFile(options.referenceAudioFile);
          if (path.extname(options.referenceAudioFile).toLowerCase() !== ".wav" || referenceBytes.subarray(0, 4).toString("ascii") !== "RIFF" || referenceBytes.subarray(8, 12).toString("ascii") !== "WAVE") throw new Error("Reference audio must be a controlled WAV file");
          referenceAudioName = await session.uploadReferenceAudio({ filename: path.basename(options.referenceAudioFile), bytes: referenceBytes, mimeType: "audio/wav" });
        }
        parameters[binding.key] = referenceAudioName;
      }
      const workflow = bindWorkflow(pkg.workflow, pkg.compiled, parameters, `task4/${pkg.packageName}/${randomUUID()}`);
      const startedAtMs = now(); let promptId = ""; let primaryError: unknown; let submitted = false;
      let artifact: { sha256: string; byteLength: number; mediaKind: "audio" | "image" | "video" } | undefined;
      let artifactRelative = ""; let completedAtMs = 0;
      try {
        await writeRestartMarker(blockedMarkerFile, { schemaVersion: 2, state: "restart-required", generationDigest: options.expectedGenerationDigest,
          packageName: pkg.packageName, runToken, listener: packageIdentity, connectionId: beforeConnectionId, token: randomUUID(), createdAtMs: now() });
        await dependencies.afterRestartMarker?.();
        submitted = true;
        try { promptId = await session.submit(workflow, session.connectionId); }
        catch (error) { throw new Error(`ComfyUI submission outcome is uncertain for ${pkg.packageName}`, { cause: error }); }
        if (!/^[A-Za-z0-9._:-]{1,200}$/.test(promptId)) throw new Error("ComfyUI returned an invalid prompt ID");
        const deadline = Date.now() + completionTimeoutMs; let history: Task4History | undefined;
        for (;;) {
          session.assertHealthy(); history = await session.history(promptId); const outcome = historyOutcome(history);
          if (outcome === "completed") break;
          if (outcome === "cancelled") throw new Error(`${pkg.packageName} execution was cancelled`);
          if (outcome === "failed") throw new Error(`${pkg.packageName} execution failed`);
          if (Date.now() >= deadline) throw new Error(`${pkg.packageName} completion remained unknown until timeout`);
          await sleep(pollIntervalMs);
        }
        if (!history) throw new Error(`${pkg.packageName} completion history disappeared`);
        const output = pkg.compiled.outputs[0]; const rawItems = record(history.outputs[output.nodeId], `${pkg.packageName} history output`)[output.field];
        if (!Array.isArray(rawItems) || rawItems.length !== 1) throw new Error(`${pkg.packageName} output history schema is malformed`);
        const item = record(rawItems[0], `${pkg.packageName} output item`);
        if (typeof item.filename !== "string" || typeof item.subfolder !== "string" || typeof item.type !== "string") throw new Error(`${pkg.packageName} output descriptor is malformed`);
        const extension = path.extname(item.filename).toLowerCase(); if (!/^\.[a-z0-9]{1,10}$/.test(extension)) throw new Error("ComfyUI output extension is unsafe");
        artifactRelative = path.join("artifacts", `${pkg.packageName}-${promptId}${extension}`);
        artifact = await session.downloadToFile({ filename: item.filename, subfolder: item.subfolder, type: item.type }, path.join(runDir, artifactRelative), pkg.manifest.limits.maxOutputBytes);
        if (artifact.mediaKind !== output.mediaKind || artifact.byteLength < 1 || artifact.byteLength > pkg.manifest.limits.maxOutputBytes) throw new Error(`${pkg.packageName} downloaded output is invalid or oversized`);
        completedAtMs = now();
      } catch (error) { primaryError = error; }

      let restart: { stoppedAtMs: number; restartedAtMs: number } | undefined; let afterIdentity: Task4ListenerIdentity | undefined;
      let afterSystem: Record<string, unknown> | undefined; let afterObjects: Record<string, unknown> | undefined; let reconnectedAtMs = 0; let readinessAtMs = 0;
      const cleanupErrors: unknown[] = [];
      if (submitted) {
        try {
          const preStopIdentity = await dependencies.observeListener(); assertIdentity(preStopIdentity, `${pkg.packageName} pre-stop`);
          if (!sameListener(preStopIdentity, packageIdentity)) throw new Error(`${pkg.packageName} listener changed spontaneously before stop`);
        } catch (error) { cleanupErrors.push(error); }
        try { await session.close(); } catch (error) { cleanupErrors.push(error); }
        try {
          restart = await dependencies.restart();
          session = await dependencies.connect(); session.assertHealthy();
          afterIdentity = await dependencies.observeListener(); assertIdentity(afterIdentity, `${pkg.packageName} post-restart`); reconnectedAtMs = now();
          if (sameListener(packageIdentity, afterIdentity) || session.connectionId.length < 8 || session.connectionId === beforeConnectionId) throw new Error("ComfyUI listener process/connection identity did not change after restart");
          afterSystem = await session.systemStats(); afterObjects = await session.objectInfo(); assertProbeSchemas(afterSystem, afterObjects); readinessAtMs = now();
          const afterModels = new Map<string, string[]>();
          for (const folder of [...new Set(pkg.manifest.requirements.models.map((model) => model.folder))]) afterModels.set(folder, await session.models(folder));
          assertInventory(pkg, afterObjects, afterModels); session.assertHealthy();
          const postProbeIdentity = await dependencies.observeListener(); assertIdentity(postProbeIdentity, `${pkg.packageName} post-probe`);
          if (!sameListener(afterIdentity, postProbeIdentity)) throw new Error(`${pkg.packageName} listener changed during readiness probes`);
          if (!(completedAtMs < restart.stoppedAtMs && restart.stoppedAtMs < restart.restartedAtMs && restart.restartedAtMs < reconnectedAtMs && reconnectedAtMs <= readinessAtMs)) throw new Error("Fresh restart/reconnection/readiness timeline is invalid");
          await removeRestartMarker(blockedMarkerFile); currentIdentity = afterIdentity; system = afterSystem; objects = afterObjects;
        } catch (error) { cleanupErrors.push(error); }
      }
      if (primaryError || cleanupErrors.length) throw combinedError(primaryError, cleanupErrors, `${pkg.packageName} failed and cleanup/restart was not fully verified`);
      if (!artifact || !restart || !afterIdentity || !afterSystem || !afterObjects) throw new Error(`${pkg.packageName} verification state is incomplete`);
      const beforeEvidence = packageBefore;
      const afterEvidence = { ...afterIdentity, connectionId: session.connectionId };
      const run = { runId: promptId, startedAtMs, completedAtMs, backendFingerprint, listener: { ...packageIdentity, connectionId: beforeEvidence.connectionId }, artifact };
      const payload = { schemaVersion: 1, producer: "ai-m/task4-comfyui-live-verify-v1", windowStartedAtMs,
        generationDigest: options.expectedGenerationDigest, packageName: pkg.packageName, packageDigest: pkg.packageDigest, backendFingerprint,
        listener: { baseUrl: BASE_URL, ...afterEvidence }, liveRuns: [run], restart: { before: beforeEvidence, after: afterEvidence, ...restart, readinessAtMs, reconnectedAtMs },
        readiness: { checkedAtMs: readinessAtMs, systemStats: { path: "/system_stats", statusCode: 200, responseSha256: hash(canonicalize(afterSystem)) }, objectInfo: { path: "/object_info", statusCode: 200, responseSha256: hash(canonicalize(afterObjects)) } } };
      archiveRelative.push(artifactRelative); evidenceFacts.push({ pkg, payload }); previousAfter = afterEvidence;
    }
    if (!previousAfter) throw new Error("Task 4 package chain is empty");
    session.assertHealthy(); const finalIdentity = await dependencies.observeListener(); assertIdentity(finalIdentity, "final endpoint");
    if (canonicalize({ ...finalIdentity, connectionId: session.connectionId }) !== canonicalize(previousAfter)) throw new Error("Final endpoint is not the last package restart.after identity");
    await session.close();
    await dependencies.beforeFinalCurrentCheck?.(); await assertCurrentGeneration(options);
    const issuedAtMs = now(); const expiresAtMs = issuedAtMs + evidenceTtlMs;
    if (expiresAtMs - windowStartedAtMs > 24 * 60 * 60_000) throw new Error("Task 4 execution window is too long for the maximum evidence validity window");
    for (const { pkg, payload } of evidenceFacts) {
      const evidence = signTask4Evidence({ ...payload, issuedAtMs, expiresAtMs }, privateKey);
      await verifyGenerationPackageForImport({ generationRoot: options.generationRoot, packageName: pkg.packageName, expectedGenerationDigest: options.expectedGenerationDigest, expectedPackageDigest: pkg.packageDigest, verifiedEvidence: evidence, trustRootPublicKey: options.publicKey, nowMs: issuedAtMs });
      const relativePath = path.join("evidence", `${pkg.packageName}.json`); await archiveBytes(path.join(runDir, relativePath), Buffer.from(`${canonicalize(evidence)}\n`)); evidenceRelative.push(relativePath);
    }
    const finalVerificationAtMs = now(); const evidenceDigests: Record<string, string> = {};
    for (const { pkg } of evidenceFacts) {
      const relativePath = path.join("evidence", `${pkg.packageName}.json`);
      const bytes = await fs.readFile(path.join(runDir, relativePath)); const evidence = parseJson(bytes, `${pkg.packageName} final evidence`);
      await verifyGenerationPackageForImport({ generationRoot: options.generationRoot, packageName: pkg.packageName, expectedGenerationDigest: options.expectedGenerationDigest, expectedPackageDigest: pkg.packageDigest, verifiedEvidence: evidence, trustRootPublicKey: options.publicKey, nowMs: finalVerificationAtMs });
      evidenceDigests[pkg.packageName] = hash(bytes);
    }
    await assertCurrentGeneration(options);
    await archiveBytes(path.join(runDir, "commit.json"), Buffer.from(`${canonicalize({ schemaVersion: 1, generationDigest: options.expectedGenerationDigest, packageOrder: packages.map((pkg) => pkg.packageName), finalEndpoint: previousAfter, finalVerificationAtMs, evidenceDigests })}\n`));
    await syncDirectory(path.join(runDir, "artifacts")); await syncDirectory(path.join(runDir, "evidence")); await syncDirectory(runDir);
    await fs.rename(runDir, committedDir); await syncDirectory(path.dirname(committedDir));
    return { mode: options.mode, packages: packages.map((pkg) => pkg.packageName), archiveFiles: archiveRelative.map((file) => path.join(committedDir, file)), evidenceFiles: evidenceRelative.map((file) => path.join(committedDir, file)) };
  } catch (error) {
    await session.close().catch(() => undefined); await fs.rm(runDir, { recursive: true, force: true }); throw error;
  }
}

export async function verifySingleComfyUI(options: VerifySingleOptions, dependencies: Task4Dependencies): Promise<{
  mode: VerifySingleOptions["mode"];
  packages: string[];
  archiveFiles: string[];
  evidenceFiles: string[];
}> {
  const stagingDir = path.dirname(path.dirname(path.resolve(options.generationRoot)));
  const prepareLockFile = path.resolve(options.prepareLockFile ?? path.join(stagingDir, "prepare.lock"));
  const lockFile = path.resolve(options.lockFile ?? path.join(stagingDir, "task4.lock"));
  if (prepareLockFile === lockFile) throw new Error("prepare.lock and task4.lock must be distinct");
  const prepareOwned = await acquireTask4Lock(prepareLockFile, dependencies);
  let owned: Task4LockRecord;
  try { owned = await acquireTask4Lock(lockFile, dependencies); }
  catch (error) {
    const cleanup: unknown[] = []; try { await releaseTask4Lock(prepareLockFile, prepareOwned); } catch (releaseError) { cleanup.push(releaseError); }
    throw combinedError(error, cleanup, "Task 4 lock acquisition failed and prepare.lock release was not fully verified");
  }
  let result: Awaited<ReturnType<typeof verifySingleComfyUILocked>> | undefined; let primary: unknown;
  try { result = await verifySingleComfyUILocked(options, dependencies); } catch (error) { primary = error; }
  const cleanup: unknown[] = [];
  try { await releaseTask4Lock(lockFile, owned); } catch (error) { cleanup.push(error); }
  try { await releaseTask4Lock(prepareLockFile, prepareOwned); } catch (error) { cleanup.push(error); }
  if (primary || cleanup.length) throw combinedError(primary, cleanup, "Task 4 failed and lock release was not fully verified");
  return result!;
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
  if (required("AI_M_MANAGED_COMFYUI_BASE_URL") !== BASE_URL) throw new Error("AI_M_MANAGED_COMFYUI_BASE_URL must exactly equal http://127.0.0.1:8000");
  const dataRoot = path.resolve(required("AI_M_MANAGED_COMFYUI_DATA_ROOT"));
  const pythonExe = path.resolve(required("AI_M_MANAGED_COMFYUI_PYTHON_EXE"));
  const comfyUIRoot = path.resolve(required("AI_M_MANAGED_COMFYUI_ROOT"));
  const commandTimeoutMs = safeInteger(Number(required("AI_M_MANAGED_COMFYUI_COMMAND_TIMEOUT_MS")), 0, 600_000, "command timeout");
  const readyTimeoutMs = safeInteger(Number(required("AI_M_MANAGED_COMFYUI_READY_TIMEOUT_MS")), 0, 900_000, "ready timeout");
  for (const [value, kind, label] of [[dataRoot, "directory", "data root"], [comfyUIRoot, "directory", "ComfyUI root"], [pythonExe, "file", "Python executable"]] as const) {
    const stat = await fs.stat(value);
    if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) throw new Error(`${label} has the wrong path type`);
  }
  const connect = async () => createHttpSession();
  const observeListener = async (): Promise<Task4ListenerIdentity> => {
    if (process.platform !== "win32") throw new Error("Task 4 listener identity observation requires Windows");
    const script = [
      "$ErrorActionPreference='Stop'",
      "$listeners=@(Get-NetTCPConnection -State Listen -LocalPort 8000 | Where-Object {$_.LocalAddress -eq '127.0.0.1'})",
      "if($listeners.Count -ne 1){throw ('Expected exactly one 127.0.0.1:8000 listener; found '+$listeners.Count)}",
      "$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listeners[0].OwningProcess)",
      "$os=Get-CimInstance Win32_OperatingSystem",
      "[ordered]@{pid=[int]$p.ProcessId;createdMs=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds();bootMs=([DateTimeOffset]$os.LastBootUpTime).ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress",
    ].join(";");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 });
    return parseTask4ListenerObservation(parseJson(Buffer.from(stdout), "listener identity"));
  };
  const runner = createPowerShellCommandRunner();
  const runScript = async (name: "stop_backend.ps1" | "start_backend.ps1") => {
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(pixelleRoot, "scripts", "comfyui", name), "-Json", "-DataRoot", dataRoot, "-PythonExe", pythonExe, "-ComfyUIRoot", comfyUIRoot, "-HostAddress", "127.0.0.1", "-Port", "8000"];
    if (name === "start_backend.ps1") args.push("-ReadyTimeoutSeconds", String(Math.max(1, Math.ceil(readyTimeoutMs / 1000))));
    const result = await runner({ executable: "powershell.exe", args, cwd: pixelleRoot, timeoutMs: commandTimeoutMs, maxOutputBytes: 64 * 1024, windowsHide: true });
    if (result.exitCode !== 0 || result.truncated) throw new Error(`${name} failed or returned oversized output`);
  };
  const committedDir = path.resolve(process.env.TASK4_COMMITTED_DIR?.trim() || path.join(stagingDir, "task4-committed", current.generationDigest));
  const result = await verifySingleComfyUI({
    baseUrl: BASE_URL, mode, pixelleRoot,
    generationRoot: path.join(stagingDir, "generations", current.generationDigest), expectedGenerationDigest: current.generationDigest,
    evidenceDir: committedDir, archiveDir: path.join(committedDir, "artifacts"), committedDir,
    blockedMarkerFile: path.join(stagingDir, "task4-restart-blocked.json"), recoveryConfirmation: process.env.TASK4_RECOVERY_CONFIRM?.trim(),
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
