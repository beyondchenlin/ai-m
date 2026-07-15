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

async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolveKill) => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => resolveKill());
      killer.once("exit", () => resolveKill());
    });
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}

export function createPowerShellCommandRunner(): ManagedCommandRunner {
  return (request) => new Promise<ManagedCommandResult>((resolveRun, rejectRun) => {
    if (request.signal?.aborted) { rejectRun(request.signal.reason ?? new Error("Managed ComfyUI command aborted")); return; }
    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      windowsHide: request.windowsHide,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
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
      if (child.pid) await terminateProcessTree(child.pid);
      rejectRun(error);
    };
    const onAbort = () => { void finishError(request.signal?.reason instanceof Error ? request.signal.reason : new Error("Managed ComfyUI command aborted")); };
    const timer = setTimeout(() => { void finishError(new Error(`Managed ComfyUI command timed out after ${request.timeoutMs}ms`)); }, request.timeoutMs);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => { void finishError(new Error(`Managed ComfyUI command failed to launch: ${error.message}`)); });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      resolveRun({
        exitCode: code ?? -1,
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
    const timer = setTimeout(resolveDelay, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timer); rejectDelay(signal.reason ?? new Error("Managed ComfyUI restart aborted")); }, { once: true });
  });
}

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
    this.restarting = true;
    try {
      await this.runFixedScript("stop_backend.ps1", "stop", signal);
      await this.runFixedScript("start_backend.ps1", "start", signal);
      await this.waitUntilReady(signal);
    } finally {
      this.restarting = false;
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
