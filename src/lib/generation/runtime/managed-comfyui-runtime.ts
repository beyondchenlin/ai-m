import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type ManagedRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      baseUrl: "http://127.0.0.1:8000";
      pixelleRoot: string;
      dataRoot: string;
      pythonExe: string;
      commandTimeoutMs: number;
      readyTimeoutMs: number;
    };

export interface ManagedCommandRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  windowsHide: true;
  signal?: AbortSignal;
}

export interface ManagedCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export type ManagedCommandRunner = (request: ManagedCommandRequest) => Promise<ManagedCommandResult>;

interface ManagedChildProcess {
  readonly pid?: number;
  readonly stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
  readonly stderr: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
}

export interface PowerShellCommandRunnerOptions {
  spawnProcess?: (executable: string, args: readonly string[], options: { cwd: string; windowsHide: true; detached: boolean }) => ManagedChildProcess;
  terminateProcessTree?: (pid: number) => Promise<void>;
  cleanupTimeoutMs?: number;
  stdioDrainTimeoutMs?: number;
}

export class ManagedProcessCleanupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManagedProcessCleanupError";
  }
}

export class ManagedCommandStdioDrainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedCommandStdioDrainError";
  }
}

export interface ManagedProbeTransport {
  get(path: "/system_stats" | "/object_info", options?: { signal?: AbortSignal }): Promise<Response>;
  close(): Promise<void> | void;
}

export type ManagedComfyUIEndpointState =
  | { state: "idle" }
  | { state: "active" }
  | { state: "blocked"; reasonCode: "process-cleanup-unconfirmed" };

export class ManagedComfyUIEndpointRegistry {
  private readonly states = new Map<string, ManagedComfyUIEndpointState>();

  constructor(private readonly recoveryToken: string) {
    if (!recoveryToken) throw new Error("Managed ComfyUI recovery token must not be empty");
  }

  getState(baseUrl: string): ManagedComfyUIEndpointState {
    return this.states.get(baseUrl) ?? { state: "idle" };
  }

  begin(baseUrl: string): void {
    const current = this.getState(baseUrl);
    if (current.state === "blocked") throw new Error("Managed ComfyUI endpoint restart is blocked after an unconfirmed process cleanup");
    if (current.state === "active") throw new Error("Managed ComfyUI endpoint restart is already in progress in this process");
    this.states.set(baseUrl, { state: "active" });
  }

  finish(baseUrl: string): void {
    if (this.getState(baseUrl).state === "active") this.states.delete(baseUrl);
  }

  block(baseUrl: string): void {
    this.states.set(baseUrl, { state: "blocked", reasonCode: "process-cleanup-unconfirmed" });
  }

  async acknowledgeRecovery(
    baseUrl: string,
    evidence: { recoveryToken: string; externallyVerified: boolean },
  ): Promise<void> {
    if (evidence.recoveryToken !== this.recoveryToken) throw new Error("Managed ComfyUI recovery token is invalid");
    if (!evidence.externallyVerified) throw new Error("Managed ComfyUI external recovery verification is required");
    if (this.getState(baseUrl).state !== "blocked") throw new Error("Managed ComfyUI endpoint is not blocked");
    this.states.delete(baseUrl);
  }
}

export interface ManagedRuntimeDependencies {
  commandRunner?: ManagedCommandRunner;
  probeFactory: (baseUrl: "http://127.0.0.1:8000") => ManagedProbeTransport;
  readinessPollMs?: number;
  endpointRegistry?: ManagedComfyUIEndpointRegistry;
}

const CANONICAL_BASE_URL = "http://127.0.0.1:8000" as const;
const MAX_COMMAND_TIMEOUT_MS = 600_000;
const MAX_READY_TIMEOUT_MS = 900_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000;
const DEFAULT_STDIO_DRAIN_TIMEOUT_MS = 1_000;
const defaultEndpointRegistry = new ManagedComfyUIEndpointRegistry(randomUUID());

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when managed ComfyUI is enabled`);
  return value;
}

function existingPath(env: Record<string, string | undefined>, name: string, kind: "file" | "directory"): string {
  const path = resolve(required(env, name));
  try {
    const stat = statSync(path);
    if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) throw new Error("wrong path type");
  } catch {
    throw new Error(`${name} must reference an existing ${kind}`);
  }
  return path;
}

function boundedInteger(env: Record<string, string | undefined>, name: string, maximum: number): number {
  const raw = required(env, name);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum)
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  return value;
}

function canonicalizeBaseUrl(raw: string): typeof CANONICAL_BASE_URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("AI_M_MANAGED_COMFYUI_BASE_URL must be canonical loopback port 8000"); }
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
  if (url.protocol !== "http:" || !loopback || url.port !== "8000" || url.pathname !== "/" || url.search || url.hash || url.username || url.password)
    throw new Error("AI_M_MANAGED_COMFYUI_BASE_URL must be canonical loopback port 8000");
  return CANONICAL_BASE_URL;
}

export function parseManagedComfyUIRuntimeConfig(env: Record<string, string | undefined>): ManagedRuntimeConfig {
  const enabled = env.AI_M_MANAGED_COMFYUI_ENABLED?.trim() || "false";
  if (enabled !== "true" && enabled !== "false") throw new Error("AI_M_MANAGED_COMFYUI_ENABLED must be exactly true or false");
  if (enabled === "false") return { enabled: false };

  const pixelleRoot = existingPath(env, "AI_M_MANAGED_COMFYUI_PIXELLE_ROOT", "directory");
  for (const script of ["start_backend.ps1", "stop_backend.ps1"] as const) {
    const scriptPath = join(pixelleRoot, "scripts", "comfyui", script);
    try { if (!statSync(scriptPath).isFile()) throw new Error("not a file"); }
    catch { throw new Error(`Pixelle managed script is missing: ${script}`); }
  }

  return {
    enabled: true,
    baseUrl: canonicalizeBaseUrl(required(env, "AI_M_MANAGED_COMFYUI_BASE_URL")),
    pixelleRoot,
    dataRoot: existingPath(env, "AI_M_MANAGED_COMFYUI_DATA_ROOT", "directory"),
    pythonExe: existingPath(env, "AI_M_MANAGED_COMFYUI_PYTHON_EXE", "file"),
    commandTimeoutMs: boundedInteger(env, "AI_M_MANAGED_COMFYUI_COMMAND_TIMEOUT_MS", MAX_COMMAND_TIMEOUT_MS),
    readyTimeoutMs: boundedInteger(env, "AI_M_MANAGED_COMFYUI_READY_TIMEOUT_MS", MAX_READY_TIMEOUT_MS),
  };
}

function appendBounded(chunks: Buffer[], chunk: Buffer, state: { bytes: number; truncated: boolean }, limit: number): void {
  const remaining = limit - state.bytes;
  if (remaining <= 0) { state.truncated = true; return; }
  if (chunk.byteLength > remaining) {
    chunks.push(chunk.subarray(0, remaining));
    state.bytes += remaining;
    state.truncated = true;
  } else {
    chunks.push(chunk);
    state.bytes += chunk.byteLength;
  }
}

async function terminateProcessTree(pid: number, deadlineMs: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolveKill, rejectKill) => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killer.kill("SIGKILL");
        rejectKill(new Error(`taskkill timed out after ${deadlineMs}ms`));
      }, deadlineMs);
      killer.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectKill(new Error(`taskkill failed to launch: ${error.message}`));
      });
      killer.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolveKill();
        else rejectKill(new Error(`taskkill exited with code ${code ?? "unknown"}`));
      });
    });
    return;
  }
  try { process.kill(-pid, "SIGKILL"); }
  catch (groupError) {
    try { process.kill(pid, "SIGKILL"); }
    catch (processError) { throw new Error("Process-tree termination failed", { cause: processError ?? groupError }); }
  }
}

function withCleanupDeadline(cleanup: Promise<void>, deadlineMs: number): Promise<void> {
  return new Promise((resolveCleanup, rejectCleanup) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectCleanup(new ManagedProcessCleanupError(`Managed ComfyUI process-tree cleanup timed out after ${deadlineMs}ms`));
    }, deadlineMs);
    cleanup.then(
      () => { if (!settled) { settled = true; clearTimeout(timer); resolveCleanup(); } },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const detail = error instanceof Error ? error.message : "unknown cleanup error";
        rejectCleanup(new ManagedProcessCleanupError(`Managed ComfyUI process-tree cleanup failed: ${detail}`, { cause: error }));
      },
    );
  });
}

export function createPowerShellCommandRunner(options: PowerShellCommandRunnerOptions = {}): ManagedCommandRunner {
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const stdioDrainTimeoutMs = options.stdioDrainTimeoutMs ?? DEFAULT_STDIO_DRAIN_TIMEOUT_MS;
  const spawnProcess = options.spawnProcess ?? ((executable, args, spawnOptions) => spawn(executable, [...args], {
    ...spawnOptions,
    stdio: ["ignore", "pipe", "pipe"],
  }));
  const treeTerminator = options.terminateProcessTree ?? ((pid) => terminateProcessTree(pid, cleanupTimeoutMs));
  return (request) => new Promise<ManagedCommandResult>((resolveRun, rejectRun) => {
    if (request.signal?.aborted) { rejectRun(request.signal.reason ?? new Error("Managed ComfyUI command aborted")); return; }
    let child: ManagedChildProcess;
    try {
      child = spawnProcess(request.executable, request.args, {
        cwd: request.cwd,
        windowsHide: request.windowsHide,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown launch error";
      rejectRun(new Error(`Managed ComfyUI command failed to launch: ${detail}`, { cause: error }));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const outState = { bytes: 0, truncated: false };
    const errState = { bytes: 0, truncated: false };
    child.stdout.on("data", (chunk: Buffer) => appendBounded(stdout, chunk, outState, request.maxOutputBytes));
    child.stderr.on("data", (chunk: Buffer) => appendBounded(stderr, chunk, errState, request.maxOutputBytes));

    let settled = false;
    let exited = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const finishError = async (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      request.signal?.removeEventListener("abort", onAbort);
      if (exited || !child.pid) { rejectRun(error); return; }
      try {
        await withCleanupDeadline(treeTerminator(child.pid), cleanupTimeoutMs);
        rejectRun(error);
      } catch (cleanupError) {
        rejectRun(cleanupError);
      }
    };
    const onAbort = () => { void finishError(request.signal?.reason instanceof Error ? request.signal.reason : new Error("Managed ComfyUI command aborted")); };
    const timer = setTimeout(() => { void finishError(new Error(`Managed ComfyUI command timed out after ${request.timeoutMs}ms`)); }, request.timeoutMs);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => { void finishError(new Error(`Managed ComfyUI command failed to launch: ${error.message}`)); });
    let exitCode: number | null = null;
    child.once("exit", (code) => {
      if (settled) return;
      exited = true;
      exitCode = code;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      drainTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectRun(new ManagedCommandStdioDrainError(`Managed ComfyUI stdio drain timed out after ${stdioDrainTimeoutMs}ms`));
      }, stdioDrainTimeoutMs);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      request.signal?.removeEventListener("abort", onAbort);
      resolveRun({
        exitCode: code ?? exitCode ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        truncated: outState.truncated || errState.truncated,
      });
    });
  });
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal?.aborted) { rejectDelay(signal.reason ?? new Error("Managed ComfyUI restart aborted")); return; }
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      rejectDelay(signal?.reason ?? new Error("Managed ComfyUI restart aborted"));
    };
    const timer = setTimeout(() => { cleanup(); resolveDelay(); }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readResponseJsonObject(response: Response, maximumBytes: number): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("ComfyUI readiness probe returned an empty body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("ComfyUI readiness response exceeded its size limit").catch(() => undefined);
        throw new Error("ComfyUI readiness probe response is too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel("ComfyUI readiness response reading failed").catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("ComfyUI readiness probe returned invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("ComfyUI readiness probe returned an invalid object");
  return parsed as Record<string, unknown>;
}

async function discardResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      total += value.byteLength;
      if (total > 64 * 1024) {
        await reader.cancel("ComfyUI readiness error response exceeded its size limit").catch(() => undefined);
        return;
      }
    }
  } catch {
    await reader.cancel("ComfyUI readiness error response reading failed").catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasRecognizableComfySystemField(system: Record<string, unknown>): boolean {
  return ["os", "python_version", "pytorch_version", "comfyui_version", "required_frontend_version"]
    .some((field) => typeof system[field] === "string")
    || ["ram_total", "ram_free"].some((field) => isFiniteNumber(system[field]))
    || typeof system.embedded_python === "boolean";
}

function isComfyDeviceDescriptor(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const vramTotal = value.vram_total ?? value.vramTotal;
  return typeof value.name === "string"
    && typeof value.type === "string"
    && Number.isInteger(value.index)
    && isFiniteNumber(vramTotal);
}

function isComfyNodeDescriptor(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.input)) return false;
  if (value.input.required !== undefined && !isRecord(value.input.required)) return false;
  if (value.input.optional !== undefined && !isRecord(value.input.optional)) return false;
  if (!Array.isArray(value.output) || !Array.isArray(value.output_is_list) || !Array.isArray(value.output_name)) return false;
  if (value.output.length !== value.output_is_list.length || value.output.length !== value.output_name.length) return false;
  if (!value.output_is_list.every((item) => typeof item === "boolean")) return false;
  if (!value.output_name.every((item) => typeof item === "string")) return false;
  return typeof value.name === "string"
    && typeof value.display_name === "string"
    && typeof value.description === "string";
}

async function assertReadyProbeResponse(response: Response, path: "/system_stats" | "/object_info"): Promise<void> {
  if (!response.ok) {
    await discardResponseBody(response);
    throw new Error(`ComfyUI ${path} readiness probe failed (${response.status})`);
  }
  const payload = await readResponseJsonObject(response, path === "/system_stats" ? 1024 * 1024 : 16 * 1024 * 1024);
  if (path === "/system_stats") {
    const system = payload.system;
    if (!isRecord(system)
      || !hasRecognizableComfySystemField(system)
      || !Array.isArray(payload.devices)
      || !payload.devices.every(isComfyDeviceDescriptor))
      throw new Error("ComfyUI system_stats readiness probe returned an invalid schema");
    return;
  }
  if (Object.keys(payload).length === 0 || !Object.values(payload).some(isComfyNodeDescriptor))
    throw new Error("ComfyUI object_info readiness probe returned an invalid schema");
}

/**
 * Process-local controller for the sole canonical ComfyUI endpoint.
 * Construct it once per worker. A shared endpoint guard also rejects accidental
 * concurrent use by multiple controller instances in the same process.
 */
export class ManagedComfyUIRuntime {
  private readonly commandRunner: ManagedCommandRunner;
  private readonly readinessPollMs: number;
  private readonly endpointRegistry: ManagedComfyUIEndpointRegistry;
  private restarting = false;

  constructor(
    private readonly config: Extract<ManagedRuntimeConfig, { enabled: true }>,
    private readonly dependencies: ManagedRuntimeDependencies,
  ) {
    this.commandRunner = dependencies.commandRunner ?? createPowerShellCommandRunner();
    this.readinessPollMs = dependencies.readinessPollMs ?? 250;
    this.endpointRegistry = dependencies.endpointRegistry ?? defaultEndpointRegistry;
  }

  getEndpointState(): ManagedComfyUIEndpointState {
    return this.endpointRegistry.getState(this.config.baseUrl);
  }

  async restartAfterJob(signal?: AbortSignal): Promise<void> {
    if (this.restarting) throw new Error("Managed ComfyUI restart is already in progress");
    this.endpointRegistry.begin(this.config.baseUrl);
    this.restarting = true;
    try {
      await this.runFixedScript("stop_backend.ps1", "stop", signal);
      await this.runFixedScript("start_backend.ps1", "start", signal);
      await this.waitUntilReady(signal);
    } catch (error) {
      if (error instanceof ManagedProcessCleanupError) this.endpointRegistry.block(this.config.baseUrl);
      throw error;
    } finally {
      this.restarting = false;
      this.endpointRegistry.finish(this.config.baseUrl);
    }
  }

  private async runFixedScript(scriptName: "stop_backend.ps1" | "start_backend.ps1", action: "stop" | "start", signal?: AbortSignal): Promise<void> {
    const script = join(this.config.pixelleRoot, "scripts", "comfyui", scriptName);
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
      "-Json", "-DataRoot", this.config.dataRoot, "-PythonExe", this.config.pythonExe,
      "-HostAddress", "127.0.0.1", "-Port", "8000",
    ];
    if (action === "start") args.push("-ReadyTimeoutSeconds", String(Math.max(1, Math.ceil(this.config.readyTimeoutMs / 1000))));
    const result = await this.commandRunner({
      executable: "powershell.exe",
      args,
      cwd: this.config.pixelleRoot,
      timeoutMs: this.config.commandTimeoutMs,
      maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      windowsHide: true,
      signal,
    });
    if (result.exitCode !== 0) throw new Error(`Managed ComfyUI ${action} command exited with code ${result.exitCode}`);
  }

  private async waitUntilReady(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.config.readyTimeoutMs;
    let lastStatus: number | undefined;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error("Managed ComfyUI restart aborted");
      const probe = this.dependencies.probeFactory(this.config.baseUrl);
      const deadlineSignal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      const probeSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
      try {
        const system = await probe.get("/system_stats", { signal: probeSignal });
        lastStatus = system.status;
        await assertReadyProbeResponse(system, "/system_stats");
        const objects = await probe.get("/object_info", { signal: probeSignal });
        lastStatus = objects.status;
        await assertReadyProbeResponse(objects, "/object_info");
        return;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
      } finally {
        await Promise.resolve(probe.close());
      }
      await abortableDelay(Math.min(this.readinessPollMs, Math.max(1, deadline - Date.now())), signal);
    }
    throw new Error(`Managed ComfyUI readiness timed out${lastStatus === undefined ? "" : ` (last status ${lastStatus})`}`);
  }
}
