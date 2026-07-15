import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";

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
}

export class ManagedProcessCleanupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ManagedProcessCleanupError";
  }
}

export interface ManagedProbeTransport {
  get(path: "/system_stats" | "/object_info", options?: { signal?: AbortSignal }): Promise<Response>;
  close(): void;
}

export interface ManagedRuntimeDependencies {
  commandRunner?: ManagedCommandRunner;
  probeFactory: (baseUrl: "http://127.0.0.1:8000") => ManagedProbeTransport;
  readinessPollMs?: number;
}

const CANONICAL_BASE_URL = "http://127.0.0.1:8000" as const;
const MAX_COMMAND_TIMEOUT_MS = 600_000;
const MAX_READY_TIMEOUT_MS = 900_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000;
const activeRestartEndpoints = new Set<string>();
const blockedRestartEndpoints = new Set<string>();

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
  const spawnProcess = options.spawnProcess ?? ((executable, args, spawnOptions) => spawn(executable, [...args], {
    ...spawnOptions,
    stdio: ["ignore", "pipe", "pipe"],
  }));
  const treeTerminator = options.terminateProcessTree ?? ((pid) => terminateProcessTree(pid, cleanupTimeoutMs));
  return (request) => new Promise<ManagedCommandResult>((resolveRun, rejectRun) => {
    if (request.signal?.aborted) { rejectRun(request.signal.reason ?? new Error("Managed ComfyUI command aborted")); return; }
    const child = spawnProcess(request.executable, request.args, {
      cwd: request.cwd,
      windowsHide: request.windowsHide,
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const outState = { bytes: 0, truncated: false };
    const errState = { bytes: 0, truncated: false };
    child.stdout.on("data", (chunk: Buffer) => appendBounded(stdout, chunk, outState, request.maxOutputBytes));
    child.stderr.on("data", (chunk: Buffer) => appendBounded(stderr, chunk, errState, request.maxOutputBytes));

    let settled = false;
    const finishError = async (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      if (!child.pid) { rejectRun(new ManagedProcessCleanupError("Managed ComfyUI process-tree cleanup failed: child PID is unavailable", { cause: error })); return; }
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
    child.once("exit", (code) => { exitCode = code; });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

/**
 * Process-local controller for the sole canonical ComfyUI endpoint.
 * Construct it once per worker. A shared endpoint guard also rejects accidental
 * concurrent use by multiple controller instances in the same process.
 */
export class ManagedComfyUIRuntime {
  private readonly commandRunner: ManagedCommandRunner;
  private readonly readinessPollMs: number;
  private restarting = false;

  constructor(
    private readonly config: Extract<ManagedRuntimeConfig, { enabled: true }>,
    private readonly dependencies: ManagedRuntimeDependencies,
  ) {
    this.commandRunner = dependencies.commandRunner ?? createPowerShellCommandRunner();
    this.readinessPollMs = dependencies.readinessPollMs ?? 250;
  }

  async restartAfterJob(signal?: AbortSignal): Promise<void> {
    if (this.restarting) throw new Error("Managed ComfyUI restart is already in progress");
    if (blockedRestartEndpoints.has(this.config.baseUrl)) throw new Error("Managed ComfyUI endpoint restart is blocked after an unconfirmed process cleanup");
    if (activeRestartEndpoints.has(this.config.baseUrl)) throw new Error("Managed ComfyUI endpoint restart is already in progress in this process");
    this.restarting = true;
    activeRestartEndpoints.add(this.config.baseUrl);
    try {
      await this.runFixedScript("stop_backend.ps1", "stop", signal);
      await this.runFixedScript("start_backend.ps1", "start", signal);
      await this.waitUntilReady(signal);
    } catch (error) {
      if (error instanceof ManagedProcessCleanupError) blockedRestartEndpoints.add(this.config.baseUrl);
      throw error;
    } finally {
      this.restarting = false;
      activeRestartEndpoints.delete(this.config.baseUrl);
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
        if (!system.ok) throw new Error("system probe not ready");
        const objects = await probe.get("/object_info", { signal: probeSignal });
        lastStatus = objects.status;
        if (!objects.ok) throw new Error("object probe not ready");
        return;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
      } finally {
        probe.close();
      }
      await abortableDelay(Math.min(this.readinessPollMs, Math.max(1, deadline - Date.now())), signal);
    }
    throw new Error(`Managed ComfyUI readiness timed out${lastStatus === undefined ? "" : ` (last status ${lastStatus})`}`);
  }
}
