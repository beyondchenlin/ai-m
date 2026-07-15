import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  ManagedComfyUIRuntime,
  createPowerShellCommandRunner,
  parseManagedComfyUIRuntimeConfig,
  type ManagedCommandRequest,
  type ManagedRuntimeConfig,
} from "../managed-comfyui-runtime";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makePixelleFixture(): Promise<{ root: string; dataRoot: string; pythonExe: string }> {
  const root = await mkdtemp(join(tmpdir(), "ai-m-pixelle-"));
  temporaryPaths.push(root);
  const scripts = join(root, "scripts", "comfyui");
  const dataRoot = join(root, "data");
  const pythonExe = join(root, "python.exe");
  await mkdir(scripts, { recursive: true });
  await mkdir(dataRoot);
  await writeFile(pythonExe, "fixture");
  await writeFile(join(scripts, "start_backend.ps1"), "exit 0");
  await writeFile(join(scripts, "stop_backend.ps1"), "exit 0");
  return { root, dataRoot, pythonExe };
}

function enabledEnv(fixture: { root: string; dataRoot: string; pythonExe: string }): Record<string, string> {
  return {
    AI_M_MANAGED_COMFYUI_ENABLED: "true",
    AI_M_MANAGED_COMFYUI_BASE_URL: "http://127.0.0.1:8000",
    AI_M_MANAGED_COMFYUI_PIXELLE_ROOT: fixture.root,
    AI_M_MANAGED_COMFYUI_DATA_ROOT: fixture.dataRoot,
    AI_M_MANAGED_COMFYUI_PYTHON_EXE: fixture.pythonExe,
    AI_M_MANAGED_COMFYUI_COMMAND_TIMEOUT_MS: "30000",
    AI_M_MANAGED_COMFYUI_READY_TIMEOUT_MS: "90000",
  };
}

describe("parseManagedComfyUIRuntimeConfig", () => {
  test("is disabled by default and accepts only explicit true or false", async () => {
    expect(parseManagedComfyUIRuntimeConfig({})).toEqual({ enabled: false });
    expect(parseManagedComfyUIRuntimeConfig({ AI_M_MANAGED_COMFYUI_ENABLED: "false" })).toEqual({ enabled: false });
    expect(() => parseManagedComfyUIRuntimeConfig({ AI_M_MANAGED_COMFYUI_ENABLED: "1" })).toThrow(/ENABLED/);
  });

  test("normalizes loopback aliases on port 8000 to the canonical endpoint", async () => {
    const fixture = await makePixelleFixture();
    for (const alias of ["http://localhost:8000", "http://[::1]:8000", "http://127.0.0.1:8000/"]) {
      const config = parseManagedComfyUIRuntimeConfig({ ...enabledEnv(fixture), AI_M_MANAGED_COMFYUI_BASE_URL: alias });
      expect(config).toMatchObject({ enabled: true, baseUrl: "http://127.0.0.1:8000" });
    }
    for (const invalid of ["http://127.0.0.1:8001", "https://127.0.0.1:8000", "http://0.0.0.0:8000", "http://127.0.0.1:8000/api"])
      expect(() => parseManagedComfyUIRuntimeConfig({ ...enabledEnv(fixture), AI_M_MANAGED_COMFYUI_BASE_URL: invalid })).toThrow(/BASE_URL/);
  });

  test("requires existing Pixelle scripts, data root, and Python executable", async () => {
    const fixture = await makePixelleFixture();
    for (const key of ["AI_M_MANAGED_COMFYUI_PIXELLE_ROOT", "AI_M_MANAGED_COMFYUI_DATA_ROOT", "AI_M_MANAGED_COMFYUI_PYTHON_EXE"] as const) {
      const env = enabledEnv(fixture);
      delete env[key];
      expect(() => parseManagedComfyUIRuntimeConfig(env)).toThrow(new RegExp(key));
    }
    await rm(join(fixture.root, "scripts", "comfyui", "stop_backend.ps1"));
    expect(() => parseManagedComfyUIRuntimeConfig(enabledEnv(fixture))).toThrow(/stop_backend\.ps1/);
  });

  test("requires positive bounded integer timeouts", async () => {
    const fixture = await makePixelleFixture();
    for (const [key, values] of [
      ["AI_M_MANAGED_COMFYUI_COMMAND_TIMEOUT_MS", ["0", "1.5", "600001"]],
      ["AI_M_MANAGED_COMFYUI_READY_TIMEOUT_MS", ["-1", "NaN", "900001"]],
    ] as const) {
      for (const value of values)
        expect(() => parseManagedComfyUIRuntimeConfig({ ...enabledEnv(fixture), [key]: value })).toThrow(new RegExp(key));
    }
  });

  test("ignores request/database-like command and script selectors", async () => {
    const fixture = await makePixelleFixture();
    const config = parseManagedComfyUIRuntimeConfig({
      ...enabledEnv(fixture),
      command: "malicious.exe",
      startScript: "evil.ps1",
      DATABASE_COMFYUI_SCRIPT: "evil.ps1",
    });
    expect(config.enabled && config.pixelleRoot).toBe(fixture.root);
    expect(config).not.toHaveProperty("command");
    expect(config).not.toHaveProperty("startScript");
  });
});

function runtimeConfig(fixture: { root: string; dataRoot: string; pythonExe: string }, overrides: Partial<Extract<ManagedRuntimeConfig, { enabled: true }>> = {}): Extract<ManagedRuntimeConfig, { enabled: true }> {
  return { enabled: true, baseUrl: "http://127.0.0.1:8000", pixelleRoot: fixture.root, dataRoot: fixture.dataRoot, pythonExe: fixture.pythonExe, commandTimeoutMs: 1_000, readyTimeoutMs: 1_000, ...overrides };
}

describe("ManagedComfyUIRuntime", () => {
  test("runs fixed stop then start scripts and requires both probes on a fresh transport", async () => {
    const fixture = await makePixelleFixture();
    const events: string[] = [];
    const commandRunner = async (request: ManagedCommandRequest) => {
      events.push(request.args[request.args.indexOf("-File") + 1].endsWith("stop_backend.ps1") ? "stop" : "start");
      expect(request.executable.toLowerCase()).toContain("powershell");
      expect(request.windowsHide).toBe(true);
      return { exitCode: 0, stdout: "", stderr: "", truncated: false };
    };
    const runtime = new ManagedComfyUIRuntime(runtimeConfig(fixture), {
      commandRunner,
      probeFactory: () => ({
        async get(path) { events.push(path); return new Response("{}", { status: 200 }); },
        close() { events.push("close"); },
      }),
      readinessPollMs: 1,
    });
    await runtime.restartAfterJob();
    expect(events).toEqual(["stop", "start", "/system_stats", "/object_info", "close"]);
  });

  test("rejects concurrent restarts instead of interleaving them", async () => {
    const fixture = await makePixelleFixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const runtime = new ManagedComfyUIRuntime(runtimeConfig(fixture), {
      commandRunner: async () => { await blocked; return { exitCode: 0, stdout: "", stderr: "", truncated: false }; },
      probeFactory: () => ({ get: async () => new Response("{}"), close() {} }),
    });
    const first = runtime.restartAfterJob();
    await expect(runtime.restartAfterJob()).rejects.toThrow(/already in progress/);
    release();
    await first;
  });

  test("stops immediately on non-zero command exit without leaking captured output", async () => {
    const fixture = await makePixelleFixture();
    const runner = vi.fn(async () => ({ exitCode: 17, stdout: "secret".repeat(1000), stderr: "token".repeat(1000), truncated: true }));
    const runtime = new ManagedComfyUIRuntime(runtimeConfig(fixture), { commandRunner: runner, probeFactory: () => ({ get: async () => new Response("{}"), close() {} }) });
    await expect(runtime.restartAfterJob()).rejects.toThrow(/stop.*17/i);
    await expect(runtime.restartAfterJob()).rejects.not.toThrow(/secret|token/);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  test("retries fresh dual HTTP probes until ready and always closes each transport", async () => {
    const fixture = await makePixelleFixture();
    let attempts = 0;
    let closes = 0;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (++attempts < 3) { response.statusCode = 503; response.end("{}"); return; }
      response.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const runtime = new ManagedComfyUIRuntime(runtimeConfig(fixture), {
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "", truncated: false }),
      probeFactory: () => ({ get: (path, options) => fetch(`http://127.0.0.1:${address.port}${path}`, { signal: options?.signal }), close: () => { closes++; } }),
      readinessPollMs: 1,
    });
    try { await runtime.restartAfterJob(); } finally { server.close(); }
    expect(attempts).toBeGreaterThanOrEqual(4);
    expect(closes).toBeGreaterThanOrEqual(2);
  });

  test("times out readiness and closes the final probe transport", async () => {
    const fixture = await makePixelleFixture();
    let closes = 0;
    const runtime = new ManagedComfyUIRuntime(runtimeConfig(fixture, { readyTimeoutMs: 20 }), {
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "", truncated: false }),
      probeFactory: () => ({ get: async () => new Response("{}", { status: 503 }), close: () => { closes++; } }),
      readinessPollMs: 1,
    });
    await expect(runtime.restartAfterJob()).rejects.toThrow(/readiness.*timed out/i);
    expect(closes).toBeGreaterThan(0);
  });

  test("aborts a hanging probe at the readiness deadline", async () => {
    const fixture = await makePixelleFixture();
    let closes = 0;
    const runtime = new ManagedComfyUIRuntime(runtimeConfig(fixture, { readyTimeoutMs: 20 }), {
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "", truncated: false }),
      probeFactory: () => ({
        get: (_path, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true })),
        close: () => { closes++; },
      }),
      readinessPollMs: 1,
    });
    await expect(runtime.restartAfterJob()).rejects.toThrow(/readiness.*timed out/i);
    expect(closes).toBe(1);
  });

  test("passes shutdown abort to a running stop command", async () => {
    const fixture = await makePixelleFixture();
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const runtime = new ManagedComfyUIRuntime(runtimeConfig(fixture), {
      commandRunner: (request) => new Promise((_, reject) => {
        observed = request.signal;
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
      }),
      probeFactory: () => ({ get: async () => new Response("{}"), close() {} }),
    });
    const restart = runtime.restartAfterJob(controller.signal);
    controller.abort(new Error("shutdown"));
    await expect(restart).rejects.toThrow(/shutdown/);
    expect(observed).toBe(controller.signal);
  });
});

describe("createPowerShellCommandRunner", () => {
  test("bounds stdout and stderr capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-m-powershell-"));
    temporaryPaths.push(root);
    const script = join(root, "output.ps1");
    await writeFile(script, "[Console]::Out.Write(('o' * 5000)); [Console]::Error.Write(('e' * 5000))");
    const result = await createPowerShellCommandRunner()({ executable: "powershell.exe", args: ["-NoProfile", "-File", script], cwd: root, timeoutMs: 5_000, maxOutputBytes: 128, windowsHide: true });
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(256);
    expect(result.truncated).toBe(true);
  });

  test("kills the entire child process tree on timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-m-powershell-"));
    temporaryPaths.push(root);
    const marker = join(root, "child-survived.txt");
    const child = join(root, "child.ps1");
    const parent = join(root, "parent.ps1");
    await writeFile(child, `Start-Sleep -Milliseconds 1200; Set-Content -LiteralPath '${marker.replace(/'/g, "''")}' -Value survived`);
    await writeFile(parent, `Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-File','${child.replace(/'/g, "''")}'); Start-Sleep -Seconds 30`);
    await expect(createPowerShellCommandRunner()({ executable: "powershell.exe", args: ["-NoProfile", "-File", parent], cwd: root, timeoutMs: 250, maxOutputBytes: 256, windowsHide: true })).rejects.toThrow(/timed out/i);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await expect(readFile(marker)).rejects.toThrow();
  }, 10_000);
});
