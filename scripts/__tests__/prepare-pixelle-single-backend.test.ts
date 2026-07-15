import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign as signBytes, type KeyObject } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { bindWorkflow } from "../../src/lib/generation/workflows/binder";
import { canonicalize } from "../../src/lib/generation/workflows/canonical";
import { parseCompiledBindings } from "../../src/lib/generation/workflows/compiled";
import { garbageCollectPixelleGeneration, preparePixelleSingleBackendPackages } from "../prepare-pixelle-single-backend";
import { verifyGenerationPackageForImport, verifyPreparedGenerationPackage } from "../verify-generation-package";
import { SqlitePixelleGcAuditAnchor, verifyPixelleGcAuditChain } from "../pixelle-gc-audit";

const temporaryDirectories: string[] = [];
const ROOT_MARKER = ".ai-m-pixelle-staging.json";
const TEMP_MARKER = ".ai-m-generation-temp.json";

function node(classType: string, title: string, inputs: Record<string, unknown>) {
  return { class_type: classType, _meta: { title }, inputs };
}

function signTask4Payload(payload: Record<string, unknown>, privateKey: KeyObject): Record<string, unknown> {
  return {
    ...payload,
    signature: {
      algorithm: "Ed25519",
      keyId: "pixelle-task4-local-ed25519-v1",
      value: signBytes(null, Buffer.from(canonicalize(payload), "utf8"), privateKey).toString("base64"),
    },
  };
}

function indexWorkflow(lowVram = false): Record<string, unknown> {
  return {
    "3": node("PrimitiveStringMultiline", "$text.value!", { value: "sample" }),
    "5": node("IndexTTS2BaseNode", lowVram ? "Index TTS 2 - Base (8G VRAM)" : "Index TTS 2 - Base", { text: ["3", 0], reference_audio: ["12", 0], cache_control: ["13", 0] }),
    "8": node("SaveAudio", "Save Audio (FLAC)", { filename_prefix: "audio/ComfyUI", audio: ["5", 0] }),
    "12": node("VHS_LoadAudioUpload", "$ref_audio.~audio!", { audio: "ref_audio.wav", start_time: 0, duration: 0 }),
    "13": node("IndexTTS2CacheControlNode", "Index TTS 2 Cache Control", { keep_models_cached: true }),
  };
}

function omniWorkflow(clone: boolean): Record<string, unknown> {
  return {
    "3": node("PrimitiveStringMultiline", "$text.value!", { value: "sample" }),
    "4": node("PrimitiveStringMultiline", "$reference_audio_text.value", { value: "" }),
    "5": node("VHS_LoadAudioUpload", "$ref_audio.~audio!", { audio: "ref_audio.wav", start_time: 0, duration: 0 }),
    "6": node(clone ? "OmniVoiceVoiceCloneTTS" : "OmniVoiceLongformTTS", clone ? "OmniVoice Voice Clone TTS" : "OmniVoice Longform TTS", {
      model: "OmniVoice-bf16", text: ["3", 0], ref_text: ["4", 0], ref_audio: ["5", 0], speed: 0.9,
      ...(clone ? { duration: ["8", 0] } : { duration: 0, whisper_model: ["9", 0] }),
    }),
    "7": node("SaveAudio", "Save Audio (FLAC)", { filename_prefix: "audio/ComfyUI", audio: ["6", 0] }),
    ...(clone ? { "8": node("PixelleDurationInput", "$duration.value", { value: 8 }) } : { "9": node("OmniVoiceWhisperLoader", "OmniVoice Whisper Loader", { model: "whisper-large-v3" }) }),
  };
}

function imageWorkflow(): Record<string, unknown> {
  return {
    "3": node("KSampler", "KSampler", { seed: 0 }),
    "37": node("UNETLoader", "Load Diffusion Model", { unet_name: "z_image_turbo_bf16.safetensors" }),
    "38": node("CLIPLoader", "Load CLIP", { clip_name: "qwen_3_4b.safetensors" }),
    "39": node("VAELoader", "Load VAE", { vae_name: "ae.safetensors" }),
    "46": node("PrimitiveStringMultiline", "$prompt.value!", { value: "a dog" }),
    "60": node("SaveImage", "Save Image", { filename_prefix: "ComfyUI", images: ["8", 0] }),
    "90": node("easy int", "$width.value", { value: 768 }),
    "91": node("easy int", "$height.value", { value: 768 }),
  };
}

function videoWorkflow(): Record<string, unknown> {
  return {
    "3": node("KSampler", "KSampler", { seed: 12 }),
    "30": node("VHS_VideoCombine", "Video Combine \u{1F3A5}\u{1F165}\u{1F157}\u{1F162}", { filename_prefix: "Video", format: "video/h264-mp4", save_output: true }),
    "37": node("UNETLoader", "Load Diffusion Model", { unet_name: "wan-fusionx/WanT2V_MasterModel.safetensors" }),
    "38": node("CLIPLoader", "Load CLIP", { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors" }),
    "39": node("VAELoader", "Load VAE", { vae_name: "wan_2.1_vae.safetensors" }),
    "49": node("PrimitiveStringMultiline", "$prompt.value!", { value: "a running dog" }),
    "50": node("easy int", "$width.value", { value: 512 }),
    "51": node("easy int", "$height.value", { value: 288 }),
  };
}

const workflows: Record<string, Record<string, unknown>> = {
  "tts_index2.json": indexWorkflow(), "tts_index2_8g.json": indexWorkflow(true),
  "tts_omnivoice_longform_bf16.json": omniWorkflow(false), "tts_omnivoice_clone_duration_bf16.json": omniWorkflow(true),
  "image_z_image_turbo.json": imageWorkflow(), "video_wan2.1_fusionx.json": videoWorkflow(),
};

async function makeTree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-m-pixelle-immutable-"));
  temporaryDirectories.push(root);
  const sourceDir = path.join(root, "pixelle", "workflows", "selfhost");
  await fs.mkdir(sourceDir, { recursive: true });
  for (const [name, workflow] of Object.entries(workflows)) await fs.writeFile(path.join(sourceDir, name), JSON.stringify(workflow), "utf8");
  const stagingDir = path.join(root, "staging");
  return { root, pixelleRoot: path.join(root, "pixelle"), sourceDir, stagingDir };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("immutable Pixelle workflow preparation", () => {
  it("documents offline-only preparation and a safe post-Task4 import reference", async () => {
    const readme = await fs.readFile(path.resolve("docs/comfyui-single-endpoint/README.md"), "utf8");
    expect(readme).not.toContain("COMFYUI_INVENTORY_FILE");
    expect(readme).toContain("WORKFLOW_PACKAGE_DIR");
    expect(readme).toContain("EXPECTED_GENERATION_DIGEST");
    expect(readme).toContain("EXPECTED_PACKAGE_DIGEST");
    expect(readme).not.toContain("REQUIRE_TASK4_VERIFIED_EVIDENCE");
    expect(await fs.readFile(path.resolve("scripts/import-workflow-package.ts"), "utf8")).not.toContain("REQUIRE_TASK4_VERIFIED_EVIDENCE");
    const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8"));
    expect(packageJson.scripts["workflow:import"]).toContain("import-workflow-package.ts");
    expect(packageJson.scripts["workflow:import:verified-generation"]).toContain("import-verified-generation.ts");
    expect(readme).toContain("workflow:gc:pixelle-single");
    expect(readme).toMatch(/directory fsync[\s\S]*Windows/i);
    expect(readme).toMatch(/process identity[\s\S]*manual recovery audit/i);
    expect(readme).toContain("prepared-environment-unverified");
    expect(readme).toMatch(/Task 4[\s\S]*verified evidence[\s\S]*import\/promote/i);
    expect(readme).toContain("Remove-Item Env:PROFILE_CONFIG_FILE -ErrorAction SilentlyContinue");
    expect(readme).toContain("$env:PIXELLE_WORKFLOW_STAGING_DIR\\logs");
    expect(readme).toMatch(/New-Item[\s\S]*logs[\s\S]*workflow:import:verified-generation[\s\S]*Tee-Object/i);
    expect(readme).toMatch(/日志[\s\S]*(保留|敏感)/);
  });

  it("publishes one immutable content-addressed generation and a small current pointer", async () => {
    const { pixelleRoot, stagingDir } = await makeTree();
    const result = await preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir });
    expect(result.state).toBe("prepared-environment-unverified");
    expect(result.packages).toHaveLength(6);
    expect(result.generationDigest).toMatch(/^[a-f0-9]{64}$/);
    expect("stagingDir" in result).toBe(false);
    const generationDir = path.join(stagingDir, "generations", result.generationDigest);
    expect((await fs.stat(generationDir)).isDirectory()).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(stagingDir, ROOT_MARKER), "utf8"))).toMatchObject({ schemaVersion: 2, producer: "ai-m/pixelle-single-backend" });
    const current = JSON.parse(await fs.readFile(path.join(stagingDir, "current.json"), "utf8"));
    expect(current).toMatchObject({ schemaVersion: 1, generationDigest: result.generationDigest, state: "prepared-environment-unverified" });
    expect(JSON.stringify(current)).not.toContain(stagingDir);
    for (const item of result.packages) {
      expect(item.packageName).toBeTruthy();
      expect(await fs.stat(path.join(generationDir, item.packageName, "package.lock.json"))).toBeTruthy();
      await expect(fs.stat(path.join(generationDir, item.packageName, ROOT_MARKER))).rejects.toThrow();
    }
  });

  it("binds clone duration to the real 0.5..60 step-0.5 Pixelle contract", async () => {
    const { pixelleRoot, stagingDir } = await makeTree();
    const result = await preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir });
    const packageDir = path.join(stagingDir, "generations", result.generationDigest, "tts-omnivoice-clone-duration-bf16");
    const workflow = JSON.parse(await fs.readFile(path.join(packageDir, "workflow.api.json"), "utf8"));
    const compiled = parseCompiledBindings(JSON.parse(await fs.readFile(path.join(packageDir, "compiled-bindings.json"), "utf8")));
    const duration = compiled.bindings.find((binding) => binding.key === "duration");
    const parameters = { text: "x", voiceReference: "voice.wav", speed: 0.5 };
    expect(duration).toMatchObject({ minimum: 0.5, maximum: 60, step: 0.5 });
    expect(bindWorkflow(workflow, compiled, { ...parameters, duration: 0.5 }, "out")["8"].inputs.value).toBe(0.5);
    expect(bindWorkflow(workflow, compiled, { ...parameters, duration: 60 }, "out")["8"].inputs.value).toBe(60);
    expect(() => bindWorkflow(workflow, compiled, { ...parameters, duration: 0.4 }, "out")).toThrow(/minimum/i);
    expect(() => bindWorkflow(workflow, compiled, { ...parameters, duration: 60.5 }, "out")).toThrow(/maximum|exceeds/i);
    expect(() => bindWorkflow(workflow, compiled, { ...parameters, duration: 0.75 }, "out")).toThrow(/step/i);
  });

  it("preserves each package binding, model and output-selector contract", async () => {
    const { pixelleRoot, stagingDir } = await makeTree();
    const result = await preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir });
    const generationRoot = path.join(stagingDir, "generations", result.generationDigest);
    const expected: Record<string, { bindings: string[]; models: string[]; outputClass: string; outputField: string }> = {
      "tts-index2": { bindings: ["text", "voiceReference"], models: [], outputClass: "SaveAudio", outputField: "audio" },
      "tts-index2-8g": { bindings: ["text", "voiceReference"], models: [], outputClass: "SaveAudio", outputField: "audio" },
      "tts-omnivoice-longform-bf16": { bindings: ["referenceText", "speed", "text", "voiceReference"], models: [], outputClass: "SaveAudio", outputField: "audio" },
      "tts-omnivoice-clone-duration-bf16": { bindings: ["duration", "referenceText", "speed", "text", "voiceReference"], models: [], outputClass: "SaveAudio", outputField: "audio" },
      "image-z-image-turbo": {
        bindings: ["height", "prompt", "seed", "width"],
        models: ["diffusion_models/z_image_turbo_bf16.safetensors", "text_encoders/qwen_3_4b.safetensors", "vae/ae.safetensors"],
        outputClass: "SaveImage", outputField: "images",
      },
      "video-wan2.1-fusionx": {
        bindings: ["height", "prompt", "seed", "width"],
        models: ["diffusion_models/wan-fusionx/WanT2V_MasterModel.safetensors", "text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors", "vae/wan_2.1_vae.safetensors"],
        outputClass: "VHS_VideoCombine", outputField: "gifs",
      },
    };
    for (const [packageName, contract] of Object.entries(expected)) {
      const packageDir = path.join(generationRoot, packageName);
      const manifest = JSON.parse(await fs.readFile(path.join(packageDir, "manifest.json"), "utf8"));
      const compiled = JSON.parse(await fs.readFile(path.join(packageDir, "compiled-bindings.json"), "utf8"));
      expect(manifest.bindings.map((item: { key: string }) => item.key).sort()).toEqual(contract.bindings);
      expect(manifest.requirements.models.map((item: { folder: string; filename: string }) => `${item.folder}/${item.filename}`).sort()).toEqual(contract.models);
      expect(manifest.outputs[0]).toMatchObject({ field: contract.outputField, selector: { classType: contract.outputClass } });
      expect(compiled.outputs[0]).toMatchObject({ field: contract.outputField, classType: contract.outputClass });
      expect(compiled.bindings.map((item: { key: string }) => item.key).sort()).toEqual(contract.bindings);
    }
  });

  it("reuses identical generation bytes and digest without deleting immutable content", async () => {
    const { pixelleRoot, stagingDir } = await makeTree();
    const first = await preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir });
    const bytes = await fs.readFile(path.join(stagingDir, "generations", first.generationDigest, "tts-index2", "workflow.api.json"));
    const second = await preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir });
    expect(second.generationDigest).toBe(first.generationDigest);
    expect(await fs.readFile(path.join(stagingDir, "generations", first.generationDigest, "tts-index2", "workflow.api.json"))).toEqual(bytes);
    expect(await fs.readdir(path.join(stagingDir, "generations"))).toEqual([first.generationDigest]);
  });

  it("recomputes generation/package digests offline and always binds Task 4 evidence for import", async () => {
    const { pixelleRoot, stagingDir } = await makeTree();
    const prepared = await preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir });
    const selected = prepared.packages.find((item) => item.packageName === "tts-index2")!;
    const generationRoot = path.join(stagingDir, "generations", prepared.generationDigest);
    const base = {
      generationRoot,
      packageName: selected.packageName,
      expectedGenerationDigest: prepared.generationDigest,
      expectedPackageDigest: selected.packageDigest,
    };
    await expect(verifyPreparedGenerationPackage(base)).resolves.toMatchObject({
      generationDigest: prepared.generationDigest, packageDigest: selected.packageDigest, packageName: "tts-index2",
    });
    await expect(verifyPreparedGenerationPackage({ ...base, expectedGenerationDigest: "0".repeat(64) })).rejects.toThrow(/generation digest/i);
    await expect(verifyPreparedGenerationPackage({ ...base, expectedPackageDigest: "0".repeat(64) })).rejects.toThrow(/package digest/i);
    await expect(verifyGenerationPackageForImport({ ...base, verifiedEvidence: undefined })).rejects.toThrow(/verified evidence/i);
    const nowMs = 2_000_000_000_000;
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const payload = {
      schemaVersion: 1, producer: "ai-m/task4-comfyui-live-verify-v1", windowStartedAtMs: nowMs - 2_000,
      issuedAtMs: nowMs - 100, expiresAtMs: nowMs + 60_000,
      generationDigest: prepared.generationDigest, packageName: selected.packageName, packageDigest: selected.packageDigest,
      backendFingerprint: "1".repeat(64),
      listener: { baseUrl: "http://127.0.0.1:8000", pid: 102, processCreatedAtMs: 1_002, bootId: "boot-session-1", processIdentity: "boot-1:process-after", connectionId: "connection-after" },
      liveRuns: [{
        runId: "run-0001", startedAtMs: nowMs - 1_800, completedAtMs: nowMs - 1_700,
        backendFingerprint: "1".repeat(64),
        listener: { pid: 101, processCreatedAtMs: 1_001, bootId: "boot-session-1", processIdentity: "boot-1:process-before", connectionId: "connection-before" },
        artifact: { sha256: "2".repeat(64), mediaKind: "audio", byteLength: 123 },
      }],
      restart: {
        before: { pid: 101, processCreatedAtMs: 1_001, bootId: "boot-session-1", processIdentity: "boot-1:process-before", connectionId: "connection-before" },
        after: { pid: 102, processCreatedAtMs: 1_002, bootId: "boot-session-1", processIdentity: "boot-1:process-after", connectionId: "connection-after" },
        stoppedAtMs: nowMs - 1_600, restartedAtMs: nowMs - 1_500,
        readinessAtMs: nowMs - 1_400, reconnectedAtMs: nowMs - 1_300,
      },
      readiness: {
        checkedAtMs: nowMs - 1_400,
        systemStats: { path: "/system_stats", statusCode: 200, responseSha256: "3".repeat(64) },
        objectInfo: { path: "/object_info", statusCode: 200, responseSha256: "4".repeat(64) },
      },
    };
    const evidence = {
      ...payload,
      signature: { algorithm: "Ed25519", keyId: "pixelle-task4-local-ed25519-v1", value: signBytes(null, Buffer.from(canonicalize(payload), "utf8"), privateKey).toString("base64") },
    };
    const trustRootPublicKey = publicKey.export({ type: "spki", format: "pem" });
    await expect(verifyGenerationPackageForImport({ ...base, verifiedEvidence: evidence, trustRootPublicKey, nowMs })).resolves.toMatchObject({ packageName: "tts-index2" });
    await expect(verifyGenerationPackageForImport({ ...base, verifiedEvidence: { ...evidence, packageDigest: "f".repeat(64) }, trustRootPublicKey, nowMs })).rejects.toThrow(/verified evidence/i);
    await expect(verifyGenerationPackageForImport({ ...base, verifiedEvidence: { ...evidence, backendFingerprint: "3".repeat(64) }, trustRootPublicKey, nowMs })).rejects.toThrow(/signature|binding/i);
    await expect(verifyGenerationPackageForImport({ ...base, verifiedEvidence: evidence, trustRootPublicKey, nowMs: nowMs + 120_000 })).rejects.toThrow(/stale/i);
    const noRunsPayload = { ...payload, liveRuns: [] };
    const noRunsEvidence = { ...noRunsPayload, signature: { algorithm: "Ed25519", keyId: "pixelle-task4-local-ed25519-v1", value: signBytes(null, Buffer.from(canonicalize(noRunsPayload), "utf8"), privateKey).toString("base64") } };
    await expect(verifyGenerationPackageForImport({ ...base, verifiedEvidence: noRunsEvidence, trustRootPublicKey, nowMs })).rejects.toThrow(/live runs/i);
    const badRestartPayload = { ...payload, restart: { ...payload.restart, before: payload.restart.after } };
    const badRestartEvidence = { ...badRestartPayload, signature: { algorithm: "Ed25519", keyId: "pixelle-task4-local-ed25519-v1", value: signBytes(null, Buffer.from(canonicalize(badRestartPayload), "utf8"), privateKey).toString("base64") } };
    await expect(verifyGenerationPackageForImport({ ...base, verifiedEvidence: badRestartEvidence, trustRootPublicKey, nowMs })).rejects.toThrow(/restart.*identit|listener binding/i);
    const unboundRunPayload = { ...payload, liveRuns: payload.liveRuns.map((run) => ({ ...run, connectionId: undefined, backendFingerprint: "5".repeat(64) })) };
    const unboundRunEvidence = signTask4Payload(unboundRunPayload, privateKey);
    await expect(verifyGenerationPackageForImport({ ...base, verifiedEvidence: unboundRunEvidence, trustRootPublicKey, nowMs })).rejects.toThrow(/live run.*backend|bind/i);
    const badOrderPayload = { ...payload, restart: { ...payload.restart, stoppedAtMs: nowMs - 1_900 } };
    await expect(verifyGenerationPackageForImport({ ...base, verifiedEvidence: signTask4Payload(badOrderPayload, privateKey), trustRootPublicKey, nowMs })).rejects.toThrow(/timeline|order/i);
    const missingHealthPayload = { ...payload, readiness: { ...payload.readiness, objectInfo: undefined } };
    await expect(verifyGenerationPackageForImport({ ...base, verifiedEvidence: signTask4Payload(missingHealthPayload, privateKey), trustRootPublicKey, nowMs })).rejects.toThrow(/object_info|readiness/i);
    const oversizedPayload = { ...payload, liveRuns: [{ ...payload.liveRuns[0], runId: "x".repeat(100_000) }] };
    await expect(verifyGenerationPackageForImport({ ...base, verifiedEvidence: signTask4Payload(oversizedPayload, privateKey), trustRootPublicKey, nowMs })).rejects.toThrow(/size|bounded|length/i);

    await fs.writeFile(path.join(generationRoot, selected.packageName, "workflow.api.json"), "{}\n", "utf8");
    await expect(verifyPreparedGenerationPackage(base)).rejects.toThrow(/package digest|bytes/i);
  });

  it("fails legacy workflow:import closed for Pixelle manifests before touching the database", async () => {
    const { root, pixelleRoot, stagingDir } = await makeTree();
    const prepared = await preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir });
    const packageDir = path.join(stagingDir, "generations", prepared.generationDigest, prepared.packages[0].packageName);
    const child = spawn(process.execPath, ["--import", "tsx", path.resolve("scripts/import-workflow-package.ts"), packageDir], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: `file:${path.join(root, "must-not-be-created.db")}` }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    expect(code).toBe(1);
    expect(stderr).toMatch(/Pixelle.*verified-generation|strict/i);
  }, 10_000);

  it("fails the real verified-generation CLI closed when Task 4 evidence is absent", async () => {
    const { pixelleRoot, stagingDir } = await makeTree();
    const prepared = await preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir });
    const selected = prepared.packages[0];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WORKFLOW_GENERATION_ROOT: path.join(stagingDir, "generations", prepared.generationDigest),
      WORKFLOW_PACKAGE_NAME: selected.packageName,
      EXPECTED_GENERATION_DIGEST: prepared.generationDigest,
      EXPECTED_PACKAGE_DIGEST: selected.packageDigest,
    };
    delete env.TASK4_VERIFIED_EVIDENCE_FILE;
    const child = spawn(process.execPath, ["--import", "tsx", path.resolve("scripts/import-verified-generation.ts")], {
      cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    expect(code).toBe(1);
    expect(stderr).toMatch(/TASK4_VERIFIED_EVIDENCE_FILE.*required/i);
  }, 10_000);

  it("keeps old generations after source content changes", async () => {
    const { pixelleRoot, sourceDir, stagingDir } = await makeTree();
    const first = await preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir });
    const changed = indexWorkflow();
    (changed["3"] as { inputs: { value: string } }).inputs.value = "changed";
    await fs.writeFile(path.join(sourceDir, "tts_index2.json"), JSON.stringify(changed), "utf8");
    const second = await preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir });
    expect(second.generationDigest).not.toBe(first.generationDigest);
    expect((await fs.readdir(path.join(stagingDir, "generations"))).sort()).toEqual([first.generationDigest, second.generationDigest].sort());
  });

  it("rejects unmanaged existing staging without touching it", async () => {
    const { pixelleRoot, stagingDir } = await makeTree();
    await fs.mkdir(stagingDir);
    await fs.writeFile(path.join(stagingDir, "sentinel"), "keep", "utf8");
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir })).rejects.toThrow(/unmanaged|marker/i);
    expect(await fs.readFile(path.join(stagingDir, "sentinel"), "utf8")).toBe("keep");
  });

  it.each(["EEXIST", "ENOTEMPTY"])("cleans its owned init directory after a %s initialization race", async (code) => {
    const { pixelleRoot, stagingDir } = await makeTree();
    const error = Object.assign(new Error("simulated initialization race"), { code });
    const result = await preparePixelleSingleBackendPackages({
      pixelleRoot,
      stagingDir,
      renameInitDir: async () => {
        await fs.mkdir(stagingDir);
        await fs.writeFile(path.join(stagingDir, ROOT_MARKER), JSON.stringify({
          schemaVersion: 2, producer: "ai-m/pixelle-single-backend", canonicalStagingPath: stagingDir,
        }), "utf8");
        await fs.mkdir(path.join(stagingDir, "generations"));
        throw error;
      },
    });
    expect(result.state).toBe("prepared-environment-unverified");
    expect((await fs.readdir(path.dirname(stagingDir))).filter((name) => name.startsWith(`.${path.basename(stagingDir)}.init-`))).toEqual([]);
  });

  it.each(["marker write", "rename"])("cleans its owned init directory after %s failure", async (failure) => {
    const { pixelleRoot, stagingDir } = await makeTree();
    const injected = new Error(`injected init ${failure} failure`);
    await expect(preparePixelleSingleBackendPackages({
      pixelleRoot,
      stagingDir,
      ...(failure === "marker write"
        ? { writeInitMarker: async () => { throw injected; } }
        : { renameInitDir: async () => { throw injected; } }),
    })).rejects.toThrow(/injected init/);
    expect((await fs.readdir(path.dirname(stagingDir))).filter((name) => name.startsWith(`.${path.basename(stagingDir)}.init-`))).toEqual([]);
  });

  it("reports an unfamiliar init orphan instead of silently ignoring it", async () => {
    const { pixelleRoot, stagingDir } = await makeTree();
    await fs.mkdir(path.join(path.dirname(stagingDir), `.${path.basename(stagingDir)}.init-${"a".repeat(32)}`));
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir })).rejects.toThrow(/init orphan/i);
  });

  it("takes a coherent six-file snapshot and rejects same-file or cross-file changes", async () => {
    let tree = await makeTree();
    await expect(preparePixelleSingleBackendPackages({
      pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir,
      afterSourceFileRead: async (name) => {
        if (name === "tts_index2.json") await fs.writeFile(path.join(tree.sourceDir, name), JSON.stringify(indexWorkflow(true)), "utf8");
      },
    })).rejects.toThrow(/source snapshot changed/i);

    tree = await makeTree();
    await expect(preparePixelleSingleBackendPackages({
      pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir,
      afterSourceFileRead: async (_name, index) => {
        if (index === 3) await fs.writeFile(path.join(tree.sourceDir, "tts_index2.json"), JSON.stringify(indexWorkflow(true)), "utf8");
      },
    })).rejects.toThrow(/source snapshot changed/i);
  });

  it("enforces per-file, total and JSON-depth bounds before workflow validation", async () => {
    let tree = await makeTree();
    const oversized = { ...indexWorkflow(), "99": node("PrimitiveStringMultiline", "Padding", { value: "x".repeat(5 * 1024 * 1024) }) };
    await fs.writeFile(path.join(tree.sourceDir, "tts_index2.json"), JSON.stringify(oversized), "utf8");
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir })).rejects.toThrow(/5 MiB|size limit/i);

    tree = await makeTree();
    let nested: unknown = "x";
    for (let index = 0; index < 70; index += 1) nested = [nested];
    await fs.writeFile(path.join(tree.sourceDir, "tts_index2.json"), JSON.stringify(nested), "utf8");
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir })).rejects.toThrow(/depth/i);
  });

  it("holds an exclusive prepare.lock so a concurrent prepare fails locked", async () => {
    const { pixelleRoot, stagingDir } = await makeTree();
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const first = preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir, afterLockAcquired: async () => { entered(); await releasePromise; } });
    await enteredPromise;
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir })).rejects.toThrow(/locked|prepare\.lock/i);
    release();
    await expect(first).resolves.toMatchObject({ state: "prepared-environment-unverified" });
  });

  it("enforces prepare.lock across two operating-system processes", async () => {
    const { root, pixelleRoot, stagingDir } = await makeTree();
    const helperPath = path.join(root, "prepare-child.mts");
    const moduleUrl = pathToFileURL(path.resolve("scripts/prepare-pixelle-single-backend.ts")).href;
    await fs.writeFile(helperPath, `
      import { preparePixelleSingleBackendPackages } from ${JSON.stringify(moduleUrl)};
      try {
        await preparePixelleSingleBackendPackages({
          pixelleRoot: process.env.PIXELLE_ROOT!,
          stagingDir: process.env.STAGING_DIR!,
          afterLockAcquired: async () => new Promise((resolve) => setTimeout(resolve, Number(process.env.HOLD_MS ?? 0))),
        });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    `, "utf8");
    const runChild = (holdMs: number) => {
      const child = spawn(process.execPath, ["--import", "tsx", helperPath], {
        cwd: process.cwd(),
        env: { ...process.env, PIXELLE_ROOT: pixelleRoot, STAGING_DIR: stagingDir, HOLD_MS: String(holdMs) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      return { child, done: new Promise<{ code: number | null; stderr: string }>((resolve) => child.once("close", (code) => resolve({ code, stderr }))) };
    };
    const first = runChild(1_000);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await fs.stat(path.join(stagingDir, "prepare.lock")).then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await fs.stat(path.join(stagingDir, "prepare.lock"))).toBeTruthy();
    const second = runChild(0);
    const secondResult = await second.done;
    const firstResult = await first.done;
    expect(firstResult.code).toBe(0);
    expect(secondResult.code).toBe(1);
    expect(secondResult.stderr).toMatch(/locked|prepare\.lock/i);
  }, 10_000);

  it("recovers a stale dead-pid lock by token-preserving rename but refuses live or uncertain locks", async () => {
    const { pixelleRoot, stagingDir } = await makeTree();
    await preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir });
    const lockPath = path.join(stagingDir, "prepare.lock");
    const stale = { schemaVersion: 2, pid: 999999, processIdentity: "boot-a:created-a", token: "a".repeat(32), startedAtMs: 1_000 };
    await fs.writeFile(lockPath, JSON.stringify(stale), "utf8");
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir, nowMs: 1_000_000, lockStaleMs: 10_000, isProcessAlive: async () => false })).resolves.toBeTruthy();
    expect((await fs.readdir(stagingDir)).some((name) => name.startsWith("prepare.lock.stale."))).toBe(true);

    await fs.writeFile(lockPath, JSON.stringify(stale), "utf8");
    await expect(preparePixelleSingleBackendPackages({
      pixelleRoot, stagingDir, nowMs: 1_000_000, lockStaleMs: 10_000,
      isProcessAlive: async () => true, getProcessIdentity: async () => "boot-a:created-a",
    })).rejects.toThrow(/locked|alive/i);
    await expect(preparePixelleSingleBackendPackages({
      pixelleRoot, stagingDir, nowMs: 1_000_000, lockStaleMs: 10_000,
      isProcessAlive: async () => true, getProcessIdentity: async () => "unknown",
    })).rejects.toThrow(/locked|uncertain|manual recovery/i);

    await fs.writeFile(lockPath, JSON.stringify(stale), "utf8");
    await expect(preparePixelleSingleBackendPackages({
      pixelleRoot, stagingDir, nowMs: 1_000_000, lockStaleMs: 10_000,
      isProcessAlive: async () => true, getProcessIdentity: async () => "boot-a:created-reused-pid",
    })).resolves.toBeTruthy();
  });

  it("writes a process-creation and boot-session identity into prepare.lock", async () => {
    const { pixelleRoot, stagingDir } = await makeTree();
    let observed: unknown;
    await preparePixelleSingleBackendPackages({
      pixelleRoot, stagingDir,
      getProcessIdentity: async () => "boot-session-1:created-123",
      afterLockAcquired: async () => { observed = JSON.parse(await fs.readFile(path.join(stagingDir, "prepare.lock"), "utf8")); },
    });
    expect(observed).toMatchObject({ schemaVersion: 2, pid: process.pid, processIdentity: "boot-session-1:created-123" });
  });

  it("stops publishing and releases a lock only when its token still matches", async () => {
    const { pixelleRoot, stagingDir } = await makeTree();
    await expect(preparePixelleSingleBackendPackages({
      pixelleRoot, stagingDir,
      afterLockAcquired: async () => {
        await fs.writeFile(path.join(stagingDir, "prepare.lock"), JSON.stringify({ schemaVersion: 1, pid: process.pid, token: "f".repeat(32), startedAtMs: Date.now() }), "utf8");
      },
    })).rejects.toThrow(/ownership was lost/i);
    expect(JSON.parse(await fs.readFile(path.join(stagingDir, "prepare.lock"), "utf8")).token).toBe("f".repeat(32));
    await expect(fs.stat(path.join(stagingDir, "current.json"))).rejects.toThrow();
  });

  it("leaves a marked current-token temp orphan on write failure and reports it later", async () => {
    const { pixelleRoot, stagingDir } = await makeTree();
    await preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir });
    let writes = 0;
    await expect(preparePixelleSingleBackendPackages({
      pixelleRoot, stagingDir,
      writeBytes: async (...args: Parameters<typeof fs.writeFile>) => {
        writes += 1;
        if (writes === 2) throw new Error("injected generation write failure");
        return fs.writeFile(...args);
      },
    })).rejects.toThrow(/injected generation write failure/);
    const temps = (await fs.readdir(stagingDir)).filter((name) => name.startsWith(".tmp-generation-"));
    expect(temps).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(path.join(stagingDir, temps[0], TEMP_MARKER), "utf8")).token).toBeTruthy();
    const next = await preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir });
    expect(next.orphanTempCount).toBe(1);
    expect((await fs.readdir(stagingDir)).filter((name) => name.startsWith(".tmp-generation-"))).toEqual(temps);
  });

  it("idempotently recovers marked and empty cleanup tombstones but rejects unfamiliar tombstone content", async () => {
    const { pixelleRoot, stagingDir } = await makeTree();
    await preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir });
    const markedToken = "b".repeat(32);
    const marked = path.join(stagingDir, `.tombstone-generation-${markedToken}`);
    await fs.mkdir(marked);
    await fs.writeFile(path.join(marked, TEMP_MARKER), JSON.stringify({
      schemaVersion: 1, producer: "ai-m/pixelle-single-backend", token: markedToken, pid: 1, startedAtMs: 1,
    }), "utf8");
    const empty = path.join(stagingDir, `.tombstone-generation-${"c".repeat(32)}`);
    await fs.mkdir(empty);
    await preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir });
    await expect(fs.stat(marked)).rejects.toThrow();
    await expect(fs.stat(empty)).rejects.toThrow();

    const unsafe = path.join(stagingDir, `.tombstone-generation-${"d".repeat(32)}`);
    await fs.mkdir(unsafe);
    await fs.writeFile(path.join(unsafe, "unknown"), "keep", "utf8");
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir })).rejects.toThrow(/tombstone.*unfamiliar|unsafe tombstone/i);
    expect(await fs.readFile(path.join(unsafe, "unknown"), "utf8")).toBe("keep");
  });

  it("validates current.json and every selected generation package before publishing again", async () => {
    let tree = await makeTree();
    let prepared = await preparePixelleSingleBackendPackages({ pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir });
    const currentPath = path.join(tree.stagingDir, "current.json");
    const current = JSON.parse(await fs.readFile(currentPath, "utf8"));
    await fs.writeFile(currentPath, JSON.stringify({ ...current, generationDigest: "0".repeat(64) }), "utf8");
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir })).rejects.toThrow(/current.*generation digest|current.*integrity/i);

    tree = await makeTree();
    prepared = await preparePixelleSingleBackendPackages({ pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir });
    await fs.writeFile(path.join(tree.stagingDir, "generations", prepared.generationDigest, "tts-index2", "workflow.api.json"), "{}\n", "utf8");
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir })).rejects.toThrow(/current.*integrity|package digest/i);
  });

  it("fsyncs payload, generation directory, current file and staging directory in publication order", async () => {
    const { pixelleRoot, stagingDir } = await makeTree();
    const events: string[] = [];
    await preparePixelleSingleBackendPackages({ pixelleRoot, stagingDir, afterDurabilityEvent: async (event) => { events.push(event); } });
    const payload = events.indexOf("generation-payload");
    const generations = events.indexOf("generations-directory");
    const currentFile = events.indexOf("current-file");
    const staging = events.indexOf("staging-directory");
    expect(payload).toBeGreaterThanOrEqual(0);
    expect(generations).toBeGreaterThan(payload);
    expect(currentFile).toBeGreaterThan(generations);
    expect(staging).toBeGreaterThan(currentFile);
  });

  it("enforces generation, orphan, byte and free-space publication limits", async () => {
    let tree = await makeTree();
    const first = await preparePixelleSingleBackendPackages({ pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir, maxGenerations: 1 });
    const changed = indexWorkflow();
    (changed["3"] as { inputs: { value: string } }).inputs.value = "new generation";
    await fs.writeFile(path.join(tree.sourceDir, "tts_index2.json"), JSON.stringify(changed), "utf8");
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir, maxGenerations: 1 })).rejects.toThrow(/generation.*limit|quota/i);
    expect(await fs.stat(path.join(tree.stagingDir, "generations", first.generationDigest))).toBeTruthy();

    tree = await makeTree();
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir, maxStagingBytes: 1 })).rejects.toThrow(/byte.*limit|quota/i);

    tree = await makeTree();
    await expect(preparePixelleSingleBackendPackages({
      pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir, minimumFreeBytes: 100, getAvailableBytes: async () => 99,
    })).rejects.toThrow(/free space|low-water/i);

    tree = await makeTree();
    await preparePixelleSingleBackendPackages({ pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir });
    const token = "e".repeat(32);
    const orphan = path.join(tree.stagingDir, `.tmp-generation-${token}`);
    await fs.mkdir(orphan);
    await fs.writeFile(path.join(orphan, TEMP_MARKER), JSON.stringify({ schemaVersion: 1, producer: "ai-m/pixelle-single-backend", token }), "utf8");
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir, maxOrphanTemps: 0 })).rejects.toThrow(/orphan.*limit|quota/i);
  });

  it("quarantines verified non-current generations and detects audit tampering/truncation", async () => {
    const tree = await makeTree();
    const first = await preparePixelleSingleBackendPackages({ pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir });
    const changed = indexWorkflow();
    (changed["3"] as { inputs: { value: string } }).inputs.value = "second";
    await fs.writeFile(path.join(tree.sourceDir, "tts_index2.json"), JSON.stringify(changed), "utf8");
    const second = await preparePixelleSingleBackendPackages({ pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir });
    const auditKey = Buffer.alloc(32, 7);
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE audit_events (id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, details_safe_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL)");
    const auditAnchor = new SqlitePixelleGcAuditAnchor(sqlite);
    await expect(garbageCollectPixelleGeneration({
      stagingDir: tree.stagingDir, generationDigest: first.generationDigest,
      confirmGenerationDigest: first.generationDigest, actor: "operator", auditKey, auditAnchor,
    })).resolves.toMatchObject({ generationDigest: first.generationDigest, quarantined: true });
    await expect(fs.stat(path.join(tree.stagingDir, "generations", first.generationDigest))).rejects.toThrow();
    expect(await fs.stat(path.join(tree.stagingDir, "quarantine", first.generationDigest))).toBeTruthy();
    expect(JSON.parse(await fs.readFile(path.join(tree.stagingDir, "current.json"), "utf8")).generationDigest).toBe(second.generationDigest);
    await expect(verifyPixelleGcAuditChain({ stagingDir: tree.stagingDir, auditKey })).resolves.toMatchObject({ valid: true, entries: 2 });
    const auditDir = path.join(tree.stagingDir, "audit");
    const entry = (await fs.readdir(auditDir)).find((name) => name.startsWith("gc-"))!;
    const original = await fs.readFile(path.join(auditDir, entry));
    await fs.writeFile(path.join(auditDir, entry), Buffer.concat([original, Buffer.from(" ")]));
    await expect(verifyPixelleGcAuditChain({ stagingDir: tree.stagingDir, auditKey })).rejects.toThrow(/audit|signature|digest/i);
    await fs.writeFile(path.join(auditDir, entry), original);
    await fs.unlink(path.join(auditDir, entry));
    await expect(verifyPixelleGcAuditChain({ stagingDir: tree.stagingDir, auditKey })).rejects.toThrow(/audit|truncat|head/i);
    await expect(garbageCollectPixelleGeneration({
      stagingDir: tree.stagingDir, generationDigest: second.generationDigest,
      confirmGenerationDigest: second.generationDigest, actor: "operator", auditKey, auditAnchor,
    })).rejects.toThrow(/current/i);
    sqlite.close();
  });

  it("anchors two-phase quarantine in audit_events and recovers rename failure while rejecting a whole-chain rollback", async () => {
    const tree = await makeTree();
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE audit_events (id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, details_safe_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL)");
    const auditAnchor = new SqlitePixelleGcAuditAnchor(sqlite);
    const auditKey = Buffer.alloc(32, 8);
    const first = await preparePixelleSingleBackendPackages({ pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir });
    const changed = indexWorkflow();
    (changed["3"] as { inputs: { value: string } }).inputs.value = "second-anchor";
    await fs.writeFile(path.join(tree.sourceDir, "tts_index2.json"), JSON.stringify(changed));
    const second = await preparePixelleSingleBackendPackages({ pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir });
    let failed = false;
    await expect(garbageCollectPixelleGeneration({
      stagingDir: tree.stagingDir, generationDigest: first.generationDigest, confirmGenerationDigest: first.generationDigest,
      actor: "operator", auditKey, auditAnchor,
      renameGeneration: async () => { failed = true; throw new Error("injected rename failure"); },
    })).rejects.toThrow(/injected rename failure/);
    expect(failed).toBe(true);
    expect(await fs.stat(path.join(tree.stagingDir, "generations", first.generationDigest))).toBeTruthy();
    const recoveryWorkflow = path.join(tree.stagingDir, "generations", first.generationDigest, "tts-index2", "workflow.api.json");
    const recoveryBytes = await fs.readFile(recoveryWorkflow);
    await fs.writeFile(recoveryWorkflow, "{}\n");
    await expect(garbageCollectPixelleGeneration({
      stagingDir: tree.stagingDir, generationDigest: first.generationDigest, confirmGenerationDigest: first.generationDigest,
      actor: "operator", auditKey, auditAnchor,
    })).rejects.toThrow(/digest|bytes|integrity/i);
    await fs.writeFile(recoveryWorkflow, recoveryBytes);
    await expect(garbageCollectPixelleGeneration({
      stagingDir: tree.stagingDir, generationDigest: first.generationDigest, confirmGenerationDigest: first.generationDigest,
      actor: "operator", auditKey, auditAnchor,
    })).resolves.toMatchObject({ generationDigest: first.generationDigest, quarantined: true, recovered: true });
    const oldAudit = path.join(tree.root, "old-audit");
    await fs.cp(path.join(tree.stagingDir, "audit"), oldAudit, { recursive: true });

    (changed["3"] as { inputs: { value: string } }).inputs.value = "third-anchor";
    await fs.writeFile(path.join(tree.sourceDir, "tts_index2.json"), JSON.stringify(changed));
    await preparePixelleSingleBackendPackages({ pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir });
    await expect(garbageCollectPixelleGeneration({
      stagingDir: tree.stagingDir, generationDigest: second.generationDigest, confirmGenerationDigest: second.generationDigest,
      actor: "operator", auditKey, auditAnchor,
    })).resolves.toMatchObject({ quarantined: true });
    await fs.rm(path.join(tree.stagingDir, "audit"), { recursive: true });
    await fs.cp(oldAudit, path.join(tree.stagingDir, "audit"), { recursive: true });
    await expect(verifyPixelleGcAuditChain({ stagingDir: tree.stagingDir, auditKey, auditAnchor })).rejects.toThrow(/database|anchor|rollback/i);
    sqlite.close();
  });

  it.each([
    { phase: "intent" as const, event: "entry-fsync" as const },
    { phase: "intent" as const, event: "head-temp-fsync" as const },
    { phase: "committed" as const, event: "head-rename" as const },
  ])("rolls the signed audit journal forward after $phase/$event crashes and repeats recovery idempotently", async ({ phase, event }) => {
    const tree = await makeTree();
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE audit_events (id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, details_safe_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL)");
    const auditAnchor = new SqlitePixelleGcAuditAnchor(sqlite);
    const auditKey = Buffer.alloc(32, 9);
    const first = await preparePixelleSingleBackendPackages({ pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir });
    const changed = indexWorkflow();
    (changed["3"] as { inputs: { value: string } }).inputs.value = `${phase}-${event}`;
    await fs.writeFile(path.join(tree.sourceDir, "tts_index2.json"), JSON.stringify(changed));
    await preparePixelleSingleBackendPackages({ pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir });
    let injected = false;
    await expect(garbageCollectPixelleGeneration({
      stagingDir: tree.stagingDir, generationDigest: first.generationDigest, confirmGenerationDigest: first.generationDigest,
      actor: "operator", auditKey, auditAnchor,
      afterAuditDurabilityEvent: async (actualPhase, actualEvent) => {
        if (!injected && actualPhase === phase && actualEvent === event) {
          injected = true;
          throw new Error(`injected ${phase}/${event} crash`);
        }
      },
    })).rejects.toThrow(/injected/);
    expect(injected).toBe(true);
    await expect(garbageCollectPixelleGeneration({
      stagingDir: tree.stagingDir, generationDigest: first.generationDigest, confirmGenerationDigest: first.generationDigest,
      actor: "operator", auditKey, auditAnchor,
    })).resolves.toMatchObject({ quarantined: true, recovered: true });
    await expect(garbageCollectPixelleGeneration({
      stagingDir: tree.stagingDir, generationDigest: first.generationDigest, confirmGenerationDigest: first.generationDigest,
      actor: "operator", auditKey, auditAnchor,
    })).resolves.toMatchObject({ quarantined: true, recovered: true });
    await expect(verifyPixelleGcAuditChain({ stagingDir: tree.stagingDir, auditKey, auditAnchor })).resolves.toMatchObject({ valid: true, entries: 2 });
    expect((await fs.readdir(path.join(tree.stagingDir, "audit"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    sqlite.close();
  });

  it("isolates an inconsistent pending audit tail instead of rolling it forward", async () => {
    const tree = await makeTree();
    const sqlite = new Database(":memory:");
    sqlite.exec("CREATE TABLE audit_events (id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, details_safe_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL)");
    const auditAnchor = new SqlitePixelleGcAuditAnchor(sqlite);
    const auditKey = Buffer.alloc(32, 10);
    const first = await preparePixelleSingleBackendPackages({ pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir });
    const changed = indexWorkflow();
    (changed["3"] as { inputs: { value: string } }).inputs.value = "tampered-tail";
    await fs.writeFile(path.join(tree.sourceDir, "tts_index2.json"), JSON.stringify(changed));
    await preparePixelleSingleBackendPackages({ pixelleRoot: tree.pixelleRoot, stagingDir: tree.stagingDir });
    await expect(garbageCollectPixelleGeneration({
      stagingDir: tree.stagingDir, generationDigest: first.generationDigest, confirmGenerationDigest: first.generationDigest,
      actor: "operator", auditKey, auditAnchor,
      afterAuditDurabilityEvent: async (phase, event) => {
        if (phase === "intent" && event === "entry-fsync") throw new Error("injected tail crash");
      },
    })).rejects.toThrow(/injected tail crash/);
    const auditDir = path.join(tree.stagingDir, "audit");
    const tail = (await fs.readdir(auditDir)).find((name) => name.startsWith("gc-"))!;
    await fs.appendFile(path.join(auditDir, tail), " ");
    await expect(garbageCollectPixelleGeneration({
      stagingDir: tree.stagingDir, generationDigest: first.generationDigest, confirmGenerationDigest: first.generationDigest,
      actor: "operator", auditKey, auditAnchor,
    })).rejects.toThrow(/isolat|recovery.*blocked/i);
    expect((await fs.readdir(path.join(tree.stagingDir, "audit-recovery-quarantine"))).length).toBeGreaterThan(0);
    sqlite.close();
  });

});
