import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preparePixelleSingleBackendPackages } from "../prepare-pixelle-single-backend";

const temporaryDirectories: string[] = [];
const STAGING_MARKER = ".ai-m-pixelle-staging.json";

function node(classType: string, title: string, inputs: Record<string, unknown>) {
  return { class_type: classType, _meta: { title }, inputs };
}

function indexWorkflow(lowVram = false): Record<string, unknown> {
  return {
    "3": node("PrimitiveStringMultiline", "$text.value!", { value: "sample" }),
    "5": node("IndexTTS2BaseNode", lowVram ? "Index TTS 2 - Base (8G VRAM)" : "Index TTS 2 - Base", {
      text: ["3", 0], reference_audio: ["12", 0], cache_control: ["13", 0],
    }),
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
    "7": node("SaveAudio", "Save Audio (FLAC)", { filename_prefix: "audio/ComfyUI_omnivoice", audio: ["6", 0] }),
    ...(clone
      ? { "8": node("PixelleDurationInput", "$duration.value", { value: 8 }) }
      : { "9": node("OmniVoiceWhisperLoader", "OmniVoice Whisper Loader", { model: "whisper-large-v3" }) }),
  };
}

function imageWorkflow(): Record<string, unknown> {
  return {
    "3": node("KSampler", "KSampler", { seed: 0, model: ["37", 0] }),
    "37": node("UNETLoader", "Load Diffusion Model", { unet_name: "z_image_turbo_bf16.safetensors", weight_dtype: "default" }),
    "38": node("CLIPLoader", "Load CLIP", { clip_name: "qwen_3_4b.safetensors", type: "lumina2" }),
    "39": node("VAELoader", "Load VAE", { vae_name: "ae.safetensors" }),
    "46": node("PrimitiveStringMultiline", "$prompt.value!", { value: "a dog" }),
    "60": node("SaveImage", "Save Image", { filename_prefix: "ComfyUI", images: ["8", 0] }),
    "90": node("easy int", "$width.value", { value: 768 }),
    "91": node("easy int", "$height.value", { value: 768 }),
  };
}

function videoWorkflow(): Record<string, unknown> {
  return {
    "3": node("KSampler", "KSampler", { seed: 12, model: ["37", 0] }),
    "30": node("VHS_VideoCombine", "Video Combine \u{1F3A5}\u{1F165}\u{1F157}\u{1F162}", { filename_prefix: "Video", format: "video/h264-mp4", save_output: true }),
    "37": node("UNETLoader", "Load Diffusion Model", { unet_name: "wan-fusionx/WanT2V_MasterModel.safetensors" }),
    "38": node("CLIPLoader", "Load CLIP", { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan" }),
    "39": node("VAELoader", "Load VAE", { vae_name: "wan_2.1_vae.safetensors" }),
    "49": node("PrimitiveStringMultiline", "$prompt.value!", { value: "a running dog" }),
    "50": node("easy int", "$width.value", { value: 512 }),
    "51": node("easy int", "$height.value", { value: 288 }),
  };
}

const workflows: Record<string, Record<string, unknown>> = {
  "tts_index2.json": indexWorkflow(),
  "tts_index2_8g.json": indexWorkflow(true),
  "tts_omnivoice_longform_bf16.json": omniWorkflow(false),
  "tts_omnivoice_clone_duration_bf16.json": omniWorkflow(true),
  "image_z_image_turbo.json": imageWorkflow(),
  "video_wan2.1_fusionx.json": videoWorkflow(),
};

async function makePixelleTree(overrides: Record<string, unknown> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-m-pixelle-"));
  temporaryDirectories.push(root);
  const workflowDir = path.join(root, "workflows", "selfhost");
  await fs.mkdir(workflowDir, { recursive: true });
  for (const [name, workflow] of Object.entries({ ...workflows, ...overrides })) {
    await fs.writeFile(path.join(workflowDir, name), `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
  }
  const stagingDir = path.join(root, "..", `${path.basename(root)}-staging`);
  temporaryDirectories.push(stagingDir);
  return { root, workflowDir, stagingDir };
}

function partialInventory() {
  const classes = new Set<string>();
  for (const workflow of Object.values(workflows)) {
    for (const item of Object.values(workflow) as Array<{ class_type: string }>) classes.add(item.class_type);
  }
  classes.delete("PixelleDurationInput");
  return {
    schemaVersion: 1,
    objectInfo: Object.fromEntries([...classes].map((classType) => [classType, {}])),
    models: {
      diffusion_models: ["z_image_turbo_bf16.safetensors"],
      text_encoders: ["qwen_3_4b.safetensors", "umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
      vae: ["ae.safetensors"],
    },
    backendFingerprint: { baseUrl: "http://127.0.0.1:8000", objectInfoSha256: "fixture" },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("preparePixelleSingleBackendPackages", () => {
  it("exposes the prepare-only command and documents the single endpoint review gate", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8"));
    expect(packageJson.scripts["workflow:prepare:pixelle-single"]).toBe("tsx scripts/prepare-pixelle-single-backend.ts");
    const readme = await fs.readFile(path.resolve("docs/comfyui-single-endpoint/README.md"), "utf8");
    expect(readme).toContain("D:\\demo1\\Pixelle\\Pixelle");
    expect(readme).toContain("http://127.0.0.1:8000");
    expect(readme).toMatch(/prepare[\s\S]+review[\s\S]+import[\s\S]+promote/i);
    expect(readme).toContain("prepared-environment-unverified");
    for (const name of [
      "COMFYUI_INVENTORY_FILE", "WORKFLOW_PACKAGE_DIR", "WORKFLOW_IMPORTER_ID", "PROFILE_KEY",
      "PROFILE_DISPLAY_NAME", "EXECUTION_BACKEND_ID", "PROFILE_CONFIG_FILE", "WORKFLOW_DIGEST",
      "PROFILE_REVISION_ID", "CONFIRM_WORKFLOW_DIGEST", "CONFIRM_ENVIRONMENT_LOCK_DIGEST",
      "WORKFLOW_REVIEWER_ID", "ENABLE_BACKEND",
    ]) expect(readme).toContain(name);
    expect(readme).toContain("PixelleDurationInput");
    expect(readme).toContain("WanT2V_MasterModel.safetensors");
    expect(readme).toContain("wan_2.1_vae.safetensors");
    expect(readme).not.toMatch(/workflow:import\s+</);
  });

  it("prepares all six real API workflow package types with truthful bindings, outputs, and models", async () => {
    const { root, stagingDir } = await makePixelleTree();
    const result = await preparePixelleSingleBackendPackages({ pixelleRoot: root, stagingDir });

    expect(result.packages.map((item) => item.sourceFile)).toEqual(Object.keys(workflows));
    expect(result.packages.every((item) => item.environmentStatus === "unverified")).toBe(true);
    expect(result.state).toBe("prepared-environment-unverified");
    expect(JSON.parse(await fs.readFile(path.join(stagingDir, STAGING_MARKER), "utf8"))).toEqual({
      schemaVersion: 1,
      producer: "ai-m/pixelle-single-backend",
      canonicalStagingPath: path.resolve(stagingDir),
    });
    const packages = await Promise.all(result.packages.map(async (item) => ({
      item,
      manifest: JSON.parse(await fs.readFile(path.join(item.packageDir, "manifest.json"), "utf8")),
      compiled: JSON.parse(await fs.readFile(path.join(item.packageDir, "compiled-bindings.json"), "utf8")),
      lock: JSON.parse(await fs.readFile(path.join(item.packageDir, "package.lock.json"), "utf8")),
    })));

    const index = packages.find(({ item }) => item.sourceFile === "tts_index2.json")!;
    expect(index.manifest.bindings.map((binding: { key: string }) => binding.key)).toEqual(["text", "voiceReference"]);
    expect(index.manifest.requirements.models).toEqual([]);
    expect(index.compiled.outputs[0]).toMatchObject({ classType: "SaveAudio", field: "audio", mediaKind: "audio" });

    const omni = packages.find(({ item }) => item.sourceFile === "tts_omnivoice_longform_bf16.json")!;
    expect(omni.manifest.bindings.map((binding: { key: string }) => binding.key)).toEqual(["text", "voiceReference", "referenceText", "speed"]);
    expect(omni.manifest.bindings.find((binding: { key: string }) => binding.key === "speed").default).toBe(0.9);
    expect(omni.manifest.requirements.models).toEqual([]);

    const clone = packages.find(({ item }) => item.sourceFile === "tts_omnivoice_clone_duration_bf16.json")!;
    expect(clone.manifest.bindings.map((binding: { key: string }) => binding.key)).toEqual(["text", "voiceReference", "referenceText", "speed", "duration"]);

    const image = packages.find(({ item }) => item.sourceFile === "image_z_image_turbo.json")!;
    expect(image.manifest.bindings.map((binding: { key: string }) => binding.key)).toEqual(["prompt", "width", "height", "seed"]);
    expect(image.manifest.requirements.models).toEqual([
      { folder: "diffusion_models", filename: "z_image_turbo_bf16.safetensors" },
      { folder: "text_encoders", filename: "qwen_3_4b.safetensors" },
      { folder: "vae", filename: "ae.safetensors" },
    ]);
    expect(image.compiled.outputs[0]).toMatchObject({ classType: "SaveImage", field: "images", mediaKind: "image" });

    const video = packages.find(({ item }) => item.sourceFile === "video_wan2.1_fusionx.json")!;
    expect(video.manifest.bindings.find((binding: { key: string }) => binding.key === "seed").default).toBe(12);
    expect(video.manifest.requirements.models).toEqual([
      { folder: "diffusion_models", filename: "wan-fusionx/WanT2V_MasterModel.safetensors" },
      { folder: "text_encoders", filename: "umt5_xxl_fp8_e4m3fn_scaled.safetensors" },
      { folder: "vae", filename: "wan_2.1_vae.safetensors" },
    ]);
    expect(video.compiled.outputs[0]).toMatchObject({ classType: "VHS_VideoCombine", field: "gifs", mediaKind: "video" });
    for (const entry of packages) {
      expect(entry.lock.files).toHaveProperty("workflow.api.json");
      expect(entry.lock.files).toHaveProperty("manifest.json");
      expect(entry.lock.files).toHaveProperty("compiled-bindings.json");
    }
  });

  it("marks only inventory-complete candidates validated and reports exact blockers", async () => {
    const { root, stagingDir } = await makePixelleTree();
    const result = await preparePixelleSingleBackendPackages({
      pixelleRoot: root,
      stagingDir,
      inventory: partialInventory(),
    });
    const bySource = Object.fromEntries(result.packages.map((item) => [item.sourceFile, item]));
    expect(bySource["tts_index2.json"].environmentStatus).toBe("validated");
    expect(bySource["tts_index2_8g.json"].environmentStatus).toBe("validated");
    expect(bySource["tts_omnivoice_longform_bf16.json"].environmentStatus).toBe("validated");
    expect(bySource["image_z_image_turbo.json"].environmentStatus).toBe("validated");
    expect(bySource["tts_omnivoice_clone_duration_bf16.json"]).toMatchObject({
      environmentStatus: "blocked",
      blockedReasons: ["missing node class: PixelleDurationInput"],
    });
    expect(bySource["video_wan2.1_fusionx.json"]).toMatchObject({
      environmentStatus: "blocked",
      blockedReasons: [
        "missing model: diffusion_models/wan-fusionx/WanT2V_MasterModel.safetensors",
        "missing model: vae/wan_2.1_vae.safetensors",
      ],
    });
    expect(result.state).toBe("prepared-with-environment-blockers");
  });

  it("is byte-for-byte deterministic and never leaks the absolute Pixelle path", async () => {
    const { root, stagingDir } = await makePixelleTree();
    const first = await preparePixelleSingleBackendPackages({ pixelleRoot: root, stagingDir });
    const firstBytes = await Promise.all(first.packages.flatMap(({ packageDir }) =>
      ["workflow.api.json", "manifest.json", "compiled-bindings.json", "package.lock.json"].map((file) => fs.readFile(path.join(packageDir, file))),
    ));
    const second = await preparePixelleSingleBackendPackages({ pixelleRoot: root, stagingDir });
    const secondBytes = await Promise.all(second.packages.flatMap(({ packageDir }) =>
      ["workflow.api.json", "manifest.json", "compiled-bindings.json", "package.lock.json"].map((file) => fs.readFile(path.join(packageDir, file))),
    ));
    expect(secondBytes.map(String)).toEqual(firstBytes.map(String));
    expect(secondBytes.map(String).join("\n")).not.toContain(path.resolve(root));
  });

  it.each([
    ["UI graph", { nodes: [] }, /API graph|numeric node IDs/i],
    ["missing required node", { ...indexWorkflow(), "5": undefined }, /required node|IndexTTS2BaseNode/i],
    ["missing save output", { ...indexWorkflow(), "8": undefined }, /save output|SaveAudio/i],
  ])("rejects %s", async (_label, invalidWorkflow, expected) => {
    const sanitized = Object.fromEntries(Object.entries(invalidWorkflow as Record<string, unknown>).filter(([, value]) => value !== undefined));
    const { root, stagingDir } = await makePixelleTree({ "tts_index2.json": sanitized });
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot: root, stagingDir })).rejects.toThrow(expected);
  });

  it("rejects missing and duplicate title/class selectors", async () => {
    const missing = indexWorkflow();
    (missing["3"] as { _meta: { title: string } })._meta.title = "$wrong.value!";
    let tree = await makePixelleTree({ "tts_index2.json": missing });
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot: tree.root, stagingDir: tree.stagingDir })).rejects.toThrow(/selector.*found 0|exactly one/i);

    const duplicate = indexWorkflow();
    duplicate["14"] = node("PrimitiveStringMultiline", "$text.value!", { value: "duplicate" });
    tree = await makePixelleTree({ "tts_index2.json": duplicate });
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot: tree.root, stagingDir: tree.stagingDir })).rejects.toThrow(/selector.*found 2|exactly one/i);
  });

  it("refuses a source workflow directory junction that escapes PIXELLE_ROOT", async () => {
    const outer = await fs.mkdtemp(path.join(os.tmpdir(), "ai-m-pixelle-outer-"));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-m-pixelle-root-"));
    const stagingDir = `${root}-staging`;
    temporaryDirectories.push(outer, root, stagingDir);
    await fs.mkdir(path.join(root, "workflows"), { recursive: true });
    await fs.symlink(outer, path.join(root, "workflows", "selfhost"), "junction");
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot: root, stagingDir })).rejects.toThrow(/escape|symbolic|junction/i);
  });

  it("requires explicit, distinct roots before cleaning output", async () => {
    const { root } = await makePixelleTree();
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot: root, stagingDir: root })).rejects.toThrow(/staging|distinct|Pixelle/i);
    expect(await fs.stat(path.join(root, "workflows", "selfhost", "tts_index2.json"))).toBeTruthy();
  });

  it("refuses unmanaged existing staging directories, including empty ones", async () => {
    const { root, stagingDir } = await makePixelleTree();
    await fs.mkdir(stagingDir);
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot: root, stagingDir })).rejects.toThrow(/ownership marker|unmanaged/i);
    await fs.writeFile(path.join(stagingDir, "sentinel.txt"), "keep", "utf8");
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot: root, stagingDir })).rejects.toThrow(/ownership marker|unmanaged/i);
    expect(await fs.readFile(path.join(stagingDir, "sentinel.txt"), "utf8")).toBe("keep");
  });

  it("rejects forged or path-mismatched ownership markers without deleting staging", async () => {
    const { root, stagingDir } = await makePixelleTree();
    await fs.mkdir(stagingDir);
    await fs.writeFile(path.join(stagingDir, "sentinel.txt"), "keep", "utf8");
    await fs.writeFile(path.join(stagingDir, STAGING_MARKER), JSON.stringify({
      schemaVersion: 1,
      producer: "ai-m/pixelle-single-backend",
      canonicalStagingPath: `${path.resolve(stagingDir)}-forged`,
    }), "utf8");
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot: root, stagingDir })).rejects.toThrow(/marker|path|ownership/i);
    expect(await fs.readFile(path.join(stagingDir, "sentinel.txt"), "utf8")).toBe("keep");
  });

  it("keeps the previous owned staging intact when writing the replacement fails", async () => {
    const { root, workflowDir, stagingDir } = await makePixelleTree();
    await preparePixelleSingleBackendPackages({ pixelleRoot: root, stagingDir });
    const oldWorkflow = await fs.readFile(path.join(stagingDir, "tts-index2", "workflow.api.json"));
    const changed = indexWorkflow();
    (changed["3"] as { inputs: { value: string } }).inputs.value = "changed";
    await fs.writeFile(path.join(workflowDir, "tts_index2.json"), JSON.stringify(changed), "utf8");
    let writes = 0;
    await expect(preparePixelleSingleBackendPackages({
      pixelleRoot: root,
      stagingDir,
      writeBytes: async (...args: Parameters<typeof fs.writeFile>) => {
        writes += 1;
        if (writes === 3) throw new Error("injected write failure");
        return fs.writeFile(...args);
      },
    })).rejects.toThrow(/injected write failure/);
    expect(await fs.readFile(path.join(stagingDir, "tts-index2", "workflow.api.json"))).toEqual(oldWorkflow);
    expect(JSON.parse(await fs.readFile(path.join(stagingDir, STAGING_MARKER), "utf8")).canonicalStagingPath).toBe(path.resolve(stagingDir));
  });

  it("rejects the repository root and user profile before touching their contents", async () => {
    const { root } = await makePixelleTree();
    const packageBefore = await fs.readFile(path.resolve("package.json"));
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot: root, stagingDir: path.resolve(".") })).rejects.toThrow(/repository|dangerous|staging/i);
    expect(await fs.readFile(path.resolve("package.json"))).toEqual(packageBefore);
    await expect(preparePixelleSingleBackendPackages({ pixelleRoot: root, stagingDir: os.homedir() })).rejects.toThrow(/user profile|dangerous|staging/i);
  });
});
