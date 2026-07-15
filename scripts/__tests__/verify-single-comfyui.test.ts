import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalize } from "../../src/lib/generation/workflows/canonical";
import { compileWorkflowBindings } from "../../src/lib/generation/workflows/compiler";
import { bindWorkflow } from "../../src/lib/generation/workflows/binder";
import type { ComfyWorkflow, WorkflowManifest } from "../../src/lib/generation/workflows/types";
import { verifyGenerationPackageForImport } from "../verify-generation-package";
import { parseTask4Mode, verifySingleComfyUI, writeAllBytes, type Task4Session } from "../verify-single-comfyui";
import { preparePixelleSingleBackendPackages } from "../prepare-pixelle-single-backend";
import { comparePixelleProcessIdentity, getPixelleProcessIdentity } from "../pixelle-process-identity";
import { createHash } from "node:crypto";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fixture(kind: "image" | "speech" | "video" = "image", requestedPackageNames?: string[], modelFilename = "model.safetensors") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "task4-single-")); roots.push(root);
  const pixelleRoot = path.join(root, "Pixelle");
  await fs.mkdir(path.join(pixelleRoot, "scripts", "comfyui"), { recursive: true });
  await fs.mkdir(path.join(pixelleRoot, "workflows", "selfhost"), { recursive: true });
  await fs.writeFile(path.join(pixelleRoot, "scripts", "comfyui", "start_backend.ps1"), "# fixed start");
  await fs.writeFile(path.join(pixelleRoot, "scripts", "comfyui", "stop_backend.ps1"), "# fixed stop");
  const workflow: ComfyWorkflow = kind === "image" ? {
    "1": { class_type: "PrimitiveStringMultiline", _meta: { title: "$prompt.value!" }, inputs: { value: "sample" } },
    "2": { class_type: "SaveImage", _meta: { title: "Save Image" }, inputs: { images: ["1", 0], filename_prefix: "x" } },
  } : kind === "speech" ? {
    "1": { class_type: "PrimitiveStringMultiline", _meta: { title: "$text.value!" }, inputs: { value: "sample" } },
    "2": { class_type: "VHS_LoadAudioUpload", _meta: { title: "$reference_audio.value!" }, inputs: { audio: "old.wav" } },
    "3": { class_type: "SaveAudio", _meta: { title: "Save Audio (FLAC)" }, inputs: { audio: ["2", 0], filename_prefix: "x" } },
  } : {
    "1": { class_type: "PrimitiveStringMultiline", _meta: { title: "$prompt.value!" }, inputs: { value: "sample" } },
    "2": { class_type: "VHS_VideoCombine", _meta: { title: "Video Combine" }, inputs: { images: ["1", 0], filename_prefix: "x" } },
  };
  const manifest: WorkflowManifest = kind === "image" ? {
    schemaVersion: 1, workflowId: "pixelle.image.test", version: "1.0.0", displayName: "Task4 test", capability: "image",
    workflowFile: "workflow.api.json",
    bindings: [{ key: "prompt", inputName: "value", valueType: "string", source: "request", required: true, userOverride: true, selector: { classType: "PrimitiveStringMultiline", metaTitle: "$prompt.value!" } }],
    outputs: [{ key: "image", selector: { classType: "SaveImage", metaTitle: "Save Image" }, field: "images", mediaKind: "image", maxItems: 1 }],
    requirements: { nodeClasses: ["PrimitiveStringMultiline", "SaveImage"], models: [{ folder: "checkpoints", filename: modelFilename }], referenceModes: ["off"] },
    limits: { maxPromptChars: 10_000, maxPixels: 4_000_000, maxBatch: 1, maxOutputs: 1, maxJobMs: 5_000, maxOutputBytes: 1024 },
  } : kind === "speech" ? {
    schemaVersion: 1, workflowId: "pixelle.speech.test", version: "1.0.0", displayName: "Task4 speech test", capability: "speech",
    workflowFile: "workflow.api.json",
    bindings: [
      { key: "text", inputName: "value", valueType: "string", source: "request", required: true, userOverride: true, selector: { classType: "PrimitiveStringMultiline", metaTitle: "$text.value!" } },
      { key: "referenceAudio", inputName: "audio", valueType: "audio", source: "voice-reference", required: true, userOverride: false, selector: { classType: "VHS_LoadAudioUpload", metaTitle: "$reference_audio.value!" } },
    ],
    outputs: [{ key: "audio", selector: { classType: "SaveAudio", metaTitle: "Save Audio (FLAC)" }, field: "audio", mediaKind: "audio", maxItems: 1 }],
    requirements: { nodeClasses: ["PrimitiveStringMultiline", "VHS_LoadAudioUpload", "SaveAudio"], models: [], referenceModes: ["required"] },
    limits: { maxPromptChars: 10_000, maxPixels: 1, maxBatch: 1, maxOutputs: 1, maxJobMs: 5_000, maxOutputBytes: 1024 },
  } : {
    schemaVersion: 1, workflowId: "pixelle.video.test", version: "1.0.0", displayName: "Task4 video test", capability: "video",
    workflowFile: "workflow.api.json",
    bindings: [{ key: "prompt", inputName: "value", valueType: "string", source: "request", required: true, userOverride: true, selector: { classType: "PrimitiveStringMultiline", metaTitle: "$prompt.value!" } }],
    outputs: [{ key: "video", selector: { classType: "VHS_VideoCombine", metaTitle: "Video Combine" }, field: "gifs", mediaKind: "video", maxItems: 1 }],
    requirements: { nodeClasses: ["PrimitiveStringMultiline", "VHS_VideoCombine"], models: [], referenceModes: ["off"] },
    limits: { maxPromptChars: 10_000, maxPixels: 4_000_000, maxBatch: 1, maxOutputs: 1, maxJobMs: 5_000, maxOutputBytes: 1024 },
  };
  const compiled = compileWorkflowBindings(workflow, manifest);
  const files = {
    "compiled-bindings.json": Buffer.from(`${canonicalize(compiled)}\n`),
    "manifest.json": Buffer.from(`${canonicalize(manifest)}\n`),
    "package.lock.json": Buffer.from("{}\n"),
    "workflow.api.json": Buffer.from(`${canonicalize(workflow)}\n`),
  };
  const fileDigests = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha(bytes)]));
  const packageDigest = sha(Buffer.from(canonicalize(fileDigests)));
  const packageName = kind === "image" ? "image-test" : kind === "speech" ? "speech-test" : "video-test";
  const packageNames = requestedPackageNames ?? [packageName];
  const packageDigests = Object.fromEntries(packageNames.map((name) => [name, packageDigest]));
  const generationDigest = sha(Buffer.from(canonicalize({ schemaVersion: 1, packageDigests })));
  const generationRoot = path.join(root, "staging", "generations", generationDigest);
  for (const name of packageNames) {
    await fs.mkdir(path.join(generationRoot, name), { recursive: true });
    await Promise.all(Object.entries(files).map(([filename, bytes]) => fs.writeFile(path.join(generationRoot, name, filename), bytes)));
  }
  await fs.writeFile(path.join(generationRoot, "generation.json"), `${canonicalize({ schemaVersion: 1, generationDigest, packageDigests, state: "prepared-environment-unverified" })}\n`);
  await fs.writeFile(path.join(root, "staging", ".ai-m-pixelle-staging.json"), `${canonicalize({ schemaVersion: 2, producer: "ai-m/pixelle-single-backend", canonicalStagingPath: path.join(root, "staging") })}\n`);
  await fs.writeFile(path.join(root, "staging", "current.json"), `${canonicalize({ schemaVersion: 1, generationDigest })}\n`);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    root, pixelleRoot, generationRoot, generationDigest, packageDigest, packageName, packageNames,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }), publicKey: publicKey.export({ type: "spki", format: "pem" }),
  };
}

const identityBefore = { pid: 101, processCreatedAtMs: 1_001, bootId: "boot-1", processIdentity: "boot-1:before" };
const identityAfter = { pid: 102, processCreatedAtMs: 1_002, bootId: "boot-1", processIdentity: "boot-1:after" };

function fakeSession(events: string[], overrides: Partial<Task4Session> = {}): Task4Session {
  return {
    connectionId: "connection-before",
    async systemStats() { events.push("/system_stats"); return { system: { comfyui_version: "1" }, devices: [{ name: "GPU", type: "cuda", index: 0, vram_total: 1 }] }; },
    async objectInfo() { events.push("/object_info"); return { PrimitiveStringMultiline: { input: { required: { value: ["STRING", {}] } }, output: ["STRING"], output_is_list: [false], output_name: ["STRING"], output_node: false, name: "PrimitiveStringMultiline", display_name: "Text", description: "" }, SaveImage: { input: { required: { images: ["IMAGE", {}] } }, output: [], output_is_list: [], output_name: [], output_node: true, name: "SaveImage", display_name: "Save", description: "" } }; },
    async models() { return ["model.safetensors"]; },
    async uploadReferenceAudio() { events.push("upload"); return "ref.wav"; },
    async submit() { events.push("submit"); return "prompt-1"; },
    async history() { events.push("history"); return { status: { status_str: "success", completed: true }, outputs: { "2": { images: [{ filename: "result.png", subfolder: "", type: "output" }] } } }; },
    async downloadToFile(_file, target) { events.push("download"); const bytes = Buffer.from("PNGDATA"); await fs.writeFile(target, bytes); return { sha256: sha(bytes), byteLength: bytes.length, mediaKind: "image" as const }; },
    assertHealthy() {},
    async close() { events.push("close"); },
    ...overrides,
  };
}

describe("single-endpoint Task 4 verifier", () => {
  it("defaults dry-run/inventory mode and gates verify behind an exact restart acknowledgement", () => {
    expect(parseTask4Mode({})).toBe("inventory-only");
    expect(parseTask4Mode({ TASK4_MODE: "dry-run" })).toBe("inventory-only");
    expect(() => parseTask4Mode({ TASK4_MODE: "verify" })).toThrow(/CONFIRM_RESTART/);
    expect(parseTask4Mode({ TASK4_MODE: "verify", TASK4_CONFIRM_RESTART: "RESTART-127.0.0.1:8000" })).toBe("verify");
  });
  it("inventory-only verifies current bytes and inventory without submit, restart, import or promote", async () => {
    const f = await fixture(); const events: string[] = [];
    const result = await verifySingleComfyUI({
      baseUrl: "http://127.0.0.1:8000", mode: "inventory-only", pixelleRoot: f.pixelleRoot,
      generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest,
      evidenceDir: path.join(f.root, "evidence"), archiveDir: path.join(f.root, "archive"), parameters: {},
    }, { expectedPackageNames: [f.packageName], connect: async () => fakeSession(events), observeListener: async () => identityBefore, restart: async () => { events.push("restart"); return { stoppedAtMs: 10, restartedAtMs: 20 }; } });
    expect(result.mode).toBe("inventory-only");
    expect(events).toEqual(["/system_stats", "/object_info", "close"]);
    expect(result.packages).toEqual(["image-test"]);
  });

  it("executes, archives, closes, restarts, reconnects and emits self-verifiable signed evidence", async () => {
    const f = await fixture(); const events: string[] = []; let connections = 0; let now = 2_000_000_000_000;
    const result = await verifySingleComfyUI({
      baseUrl: "http://127.0.0.1:8000", mode: "verify", pixelleRoot: f.pixelleRoot,
      generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest,
      evidenceDir: path.join(f.root, "evidence"), archiveDir: path.join(f.root, "archive"),
      parameters: { "image-test": { prompt: "hello" } }, privateKey: f.privateKey, publicKey: f.publicKey,
    }, {
      now: () => ++now,
      expectedPackageNames: [f.packageName],
      connect: async () => { connections += 1; return fakeSession(events, { connectionId: connections === 1 ? "connection-before" : "connection-after" }); },
      observeListener: async () => connections < 2 ? identityBefore : identityAfter,
      restart: async () => { events.push("stop"); events.push("start"); return { stoppedAtMs: ++now, restartedAtMs: ++now }; },
    });
    expect(events).toEqual(["/system_stats", "/object_info", "submit", "history", "download", "close", "stop", "start", "/system_stats", "/object_info", "close"]);
    const evidence = JSON.parse(await fs.readFile(result.evidenceFiles[0], "utf8"));
    expect(evidence.expiresAtMs - evidence.issuedAtMs).toBe(60 * 60_000);
    await expect(verifyGenerationPackageForImport({
      generationRoot: f.generationRoot, packageName: "image-test", expectedGenerationDigest: f.generationDigest,
      expectedPackageDigest: f.packageDigest, verifiedEvidence: evidence, trustRootPublicKey: f.publicKey, nowMs: evidence.issuedAtMs,
    })).resolves.toMatchObject({ packageName: "image-test" });
    expect(await fs.readFile(result.archiveFiles[0], "utf8")).toBe("PNGDATA");
  });

  it("uploads a controlled speech reference and binds the returned ComfyUI name", async () => {
    const f = await fixture("speech"); const events: string[] = []; let connections = 0; let now = 2_000_000_100_000; let submitted: Record<string, unknown> | undefined;
    const captured = JSON.parse(await fs.readFile(path.join(__dirname, "fixtures", "comfyui-object-info-captured.json"), "utf8"));
    const referenceAudioFile = path.join(f.root, "controlled.wav");
    await fs.writeFile(referenceAudioFile, "RIFF0000WAVE-controlled-audio");
    const speechObjects = {
      PrimitiveStringMultiline: { input: { required: { value: ["STRING", {}] } }, output: ["STRING"], output_is_list: [false], output_name: ["STRING"], output_node: false, name: "PrimitiveStringMultiline", display_name: "Text", description: "" },
      VHS_LoadAudioUpload: { input: { required: { audio: ["STRING", {}] } }, output: ["AUDIO"], output_is_list: [false], output_name: ["audio"], output_node: false, name: "VHS_LoadAudioUpload", display_name: "Audio", description: "" },
      SaveAudio: captured.SaveAudio,
    };
    const result = await verifySingleComfyUI({
      baseUrl: "http://127.0.0.1:8000", mode: "verify", pixelleRoot: f.pixelleRoot,
      generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest,
      evidenceDir: path.join(f.root, "evidence"), archiveDir: path.join(f.root, "archive"), referenceAudioFile,
      parameters: { "speech-test": { text: "hello" } }, privateKey: f.privateKey, publicKey: f.publicKey,
    }, {
      now: () => ++now,
      expectedPackageNames: [f.packageName],
      connect: async () => {
        connections += 1;
        return fakeSession(events, {
          connectionId: connections === 1 ? "connection-before" : "connection-after",
          objectInfo: async () => { events.push("/object_info"); return speechObjects; },
          uploadReferenceAudio: async ({ bytes }) => { events.push("upload"); expect(bytes.toString()).toBe("RIFF0000WAVE-controlled-audio"); return "task4/ref.wav"; },
          submit: async (workflow) => { events.push("submit"); submitted = workflow; return "speech-prompt"; },
          history: async () => { events.push("history"); return { status: { status_str: "success", completed: true }, outputs: { "3": { audio: [{ filename: "speech.flac", subfolder: "", type: "output" }] } } }; },
          downloadToFile: async (_file, target) => { events.push("download"); const bytes = Buffer.from("FLACDATA"); await fs.writeFile(target, bytes); return { sha256: sha(bytes), byteLength: bytes.length, mediaKind: "audio" }; },
        });
      },
      observeListener: async () => connections < 2 ? identityBefore : identityAfter,
      restart: async () => ({ stoppedAtMs: ++now, restartedAtMs: ++now }),
    });
    expect(events.filter((event) => event === "upload")).toHaveLength(1);
    expect((submitted?.["2"] as { inputs: { audio: string } }).inputs.audio).toBe("task4/ref.wav");
    expect(await fs.readFile(result.archiveFiles[0], "utf8")).toBe("FLACDATA");
  });

  it("compiles and binds the four Pixelle parameter/schema groups without guessing", () => {
    const cases = [
      { name: "index speech", capability: "speech" as const, bindings: [
        ["text", "string", "request", "Text", "value", "hello"], ["referenceAudio", "audio", "voice-reference", "Audio", "audio", "ref.wav"],
      ], output: ["SaveAudio", "audio", "audio"] },
      { name: "omni clone", capability: "speech" as const, bindings: [
        ["text", "string", "request", "Text", "value", "hello"], ["referenceText", "string", "request", "Reference", "value", "spoken"],
        ["speed", "number", "request", "Speed", "value", 1.25], ["duration", "number", "request", "Duration", "value", 4.5],
        ["referenceAudio", "audio", "voice-reference", "Audio", "audio", "ref.wav"],
      ], output: ["SaveAudio", "audio", "audio"] },
      { name: "image", capability: "image" as const, bindings: [
        ["prompt", "string", "request", "Prompt", "value", "cat"], ["width", "integer", "request", "Width", "value", 768], ["height", "integer", "request", "Height", "value", 1024], ["seed", "integer", "request", "Seed", "value", 7],
      ], output: ["SaveImage", "images", "image"] },
      { name: "video", capability: "video" as const, bindings: [
        ["prompt", "string", "request", "Prompt", "value", "cat"], ["width", "integer", "request", "Width", "value", 832], ["height", "integer", "request", "Height", "value", 480], ["seed", "integer", "request", "Seed", "value", 9],
      ], output: ["VHS_VideoCombine", "gifs", "video"] },
    ];
    for (const testCase of cases) {
      const workflow: Record<string, { class_type: string; _meta: { title: string }; inputs: Record<string, unknown> }> = {};
      const bindings: WorkflowManifest["bindings"] = [];
      const parameters: Record<string, unknown> = {};
      testCase.bindings.forEach(([key, valueType, source, title, inputName, value], index) => {
        workflow[String(index + 1)] = { class_type: String(title), _meta: { title: String(title) }, inputs: { [String(inputName)]: null } };
        bindings.push({ key: String(key), valueType: valueType as WorkflowManifest["bindings"][number]["valueType"], source: source as WorkflowManifest["bindings"][number]["source"], required: true, userOverride: source === "request", inputName: String(inputName), selector: { classType: String(title), metaTitle: String(title) } });
        parameters[String(key)] = value;
      });
      const outputId = String(testCase.bindings.length + 1); const [outputClass, outputField, mediaKind] = testCase.output;
      workflow[outputId] = { class_type: outputClass, _meta: { title: outputClass }, inputs: {} };
      const manifest: WorkflowManifest = { schemaVersion: 1, workflowId: `pixelle.${testCase.name.replace(/ /g, ".")}`, version: "1.0.0", displayName: testCase.name, capability: testCase.capability, workflowFile: "workflow.api.json", bindings,
        outputs: [{ key: "result", selector: { classType: outputClass, metaTitle: outputClass }, field: outputField, mediaKind: mediaKind as "audio" | "image" | "video", maxItems: 1 }], requirements: { nodeClasses: [...new Set(Object.values(workflow).map((node) => node.class_type))], models: [], referenceModes: testCase.capability === "speech" ? ["required"] : ["off"] }, limits: { maxPromptChars: 10_000, maxPixels: 4_000_000, maxBatch: 1, maxOutputs: 1, maxJobMs: 5_000, maxOutputBytes: 1024 } };
      const compiled = compileWorkflowBindings(workflow, manifest);
      const bound = bindWorkflow(workflow, compiled, parameters, `task4/${testCase.name}`);
      testCase.bindings.forEach(([key, , , , inputName, value], index) => expect(bound[String(index + 1)].inputs[String(inputName)], String(key)).toBe(value));
      expect(compiled.outputs[0]).toMatchObject({ nodeId: outputId, field: outputField, mediaKind });
    }
  });

  it.each([
    ["missing node", { objectInfo: async () => ({ SaveImage: {} }) }, /node/i],
    ["missing actual binding", { objectInfo: async () => ({ PrimitiveStringMultiline: { input: { required: {} }, output: ["STRING"], output_is_list: [false], output_name: ["STRING"], output_node: false, name: "PrimitiveStringMultiline", display_name: "Text", description: "" }, SaveImage: { input: { required: { images: ["IMAGE", {}] } }, output: [], output_is_list: [], output_name: [], output_node: true, name: "SaveImage", display_name: "Save", description: "" } }) }, /binding/i],
    ["missing model", { models: async () => [] }, /model/i],
    ["cancelled", { history: async () => ({ status: { status_str: "error", completed: false, messages: [["execution_interrupted", {}]] }, outputs: {} }) }, /cancel/i],
    ["malformed unknown", { history: async () => ({ status: { status_str: "mystery", completed: false }, outputs: {} }) }, /unknown|timeout/i],
    ["backend crash", { history: async () => { throw new Error("backend crashed"); } }, /crash/i],
    ["uncertain submission", { submit: async () => { throw new Error("socket reset"); } }, /uncertain/i],
    ["malformed output", { history: async () => ({ status: { status_str: "success", completed: true }, outputs: { "2": { images: [{ filename: 7 }] } } }) }, /descriptor|malformed/i],
  ])("fails closed for %s", async (_label, overrides, pattern) => {
    const f = await fixture(); const events: string[] = [];
    await expect(verifySingleComfyUI({
      baseUrl: "http://127.0.0.1:8000", mode: "verify", pixelleRoot: f.pixelleRoot,
      generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest,
      evidenceDir: path.join(f.root, "evidence"), archiveDir: path.join(f.root, "archive"),
      parameters: { "image-test": { prompt: "hello" } }, privateKey: f.privateKey, publicKey: f.publicKey, completionTimeoutMs: 20,
    }, { expectedPackageNames: [f.packageName], connect: async () => fakeSession(events, overrides), observeListener: async () => identityBefore, restart: async () => ({ stoppedAtMs: 10, restartedAtMs: 20 }), sleep: async () => undefined })).rejects.toThrow(pattern);
  });

  it("rejects noncanonical endpoint and restart timeout without producing evidence", async () => {
    const f = await fixture();
    await expect(verifySingleComfyUI({ baseUrl: "http://localhost:8000", mode: "inventory-only", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: path.join(f.root, "e"), archiveDir: path.join(f.root, "a"), parameters: {} }, { expectedPackageNames: [f.packageName], connect: async () => fakeSession([]), observeListener: async () => identityBefore, restart: async () => ({ stoppedAtMs: 1, restartedAtMs: 2 }) })).rejects.toThrow(/127\.0\.0\.1:8000/);
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "verify", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: path.join(f.root, "e"), archiveDir: path.join(f.root, "a"), parameters: { "image-test": { prompt: "x" } }, privateKey: f.privateKey, publicKey: f.publicKey }, { expectedPackageNames: [f.packageName], connect: async () => fakeSession([]), observeListener: async () => identityBefore, restart: async () => { throw new Error("restart timeout"); } })).rejects.toThrow(/restart timeout/);
  });

  it("rejects a restart whose process and connection identity did not change", async () => {
    const f = await fixture(); let now = 2_000_000_200_000;
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "verify", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: path.join(f.root, "e"), archiveDir: path.join(f.root, "a"), parameters: { "image-test": { prompt: "x" } }, privateKey: f.privateKey, publicKey: f.publicKey }, {
      now: () => ++now, expectedPackageNames: [f.packageName], connect: async () => fakeSession([], { connectionId: "connection-before" }), observeListener: async () => identityBefore,
      restart: async () => ({ stoppedAtMs: ++now, restartedAtMs: ++now }),
    })).rejects.toThrow(/identity did not change/i);
  });

  it("restarts and performs fresh readiness even when submission is uncertain", async () => {
    const f = await fixture(); const events: string[] = []; let connections = 0; let now = 2_000_000_300_000;
    const committedDir = path.join(f.root, "committed");
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "verify", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: committedDir, archiveDir: path.join(f.root, "unused"), parameters: { "image-test": { prompt: "x" } }, privateKey: f.privateKey, publicKey: f.publicKey }, {
      now: () => ++now, expectedPackageNames: [f.packageName],
      connect: async () => { connections += 1; return fakeSession(events, { connectionId: `connection-${connections}-fresh`, submit: async () => { events.push("submit"); throw new Error("socket reset"); } }); },
      observeListener: async () => connections === 1 ? identityBefore : identityAfter,
      restart: async () => { events.push("stop"); const stoppedAtMs = ++now; events.push("start"); return { stoppedAtMs, restartedAtMs: ++now }; },
    })).rejects.toThrow(/uncertain/i);
    expect(events).toEqual(expect.arrayContaining(["submit", "close", "stop", "start", "/system_stats", "/object_info"]));
    await expect(fs.lstat(committedDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["cancelled", { history: async () => ({ status: { status_str: "error", completed: false, messages: [["execution_interrupted", {}] as [string, Record<string, unknown>]] }, outputs: {} }) }, /cancel/i],
    ["history crash", { history: async () => { throw new Error("history crash"); } }, /history crash/i],
    ["archive failure", { downloadToFile: async () => { throw new Error("archive fsync failed"); } }, /archive fsync failed/i],
  ])("always restarts after submit when %s occurs and publishes nothing", async (_label, override, pattern) => {
    const f = await fixture(); let connections = 0; let restarts = 0; let now = 2_000_000_350_000; const events: string[] = [];
    const committedDir = path.join(f.root, "committed");
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "verify", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: committedDir, archiveDir: path.join(f.root, "unused"), parameters: { "image-test": { prompt: "x" } }, privateKey: f.privateKey, publicKey: f.publicKey }, {
      now: () => ++now, expectedPackageNames: [f.packageName], connect: async () => { connections += 1; return fakeSession(events, { connectionId: `connection-${connections}-fresh`, ...override }); },
      observeListener: async () => connections === 1 ? identityBefore : identityAfter,
      restart: async () => { restarts += 1; return { stoppedAtMs: ++now, restartedAtMs: ++now }; },
    })).rejects.toThrow(pattern);
    expect(restarts).toBe(1); expect(events).toContain("close");
    await expect(fs.lstat(committedDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves both the original failure and close/restart cleanup failures", async () => {
    const f = await fixture(); const events: string[] = []; let now = 2_000_000_400_000;
    let thrown: unknown;
    try {
      await verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "verify", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: path.join(f.root, "committed"), archiveDir: path.join(f.root, "unused"), parameters: { "image-test": { prompt: "x" } }, privateKey: f.privateKey, publicKey: f.publicKey }, {
        now: () => ++now, expectedPackageNames: [f.packageName], connect: async () => fakeSession(events, { history: async () => { throw new Error("history crash"); }, close: async () => { events.push("close"); throw new Error("WS close timeout"); } }),
        observeListener: async () => identityBefore, restart: async () => { events.push("restart"); throw new Error("restart uncertain"); },
      });
    } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AggregateError);
    const messages = (thrown as AggregateError).errors.map((error) => (error as Error).message).join("|");
    expect(messages).toMatch(/history crash/); expect(messages).toMatch(/WS close timeout/); expect(messages).toMatch(/restart uncertain/);
  });

  it("fails closed on spontaneous listener change but still performs the controlled restart", async () => {
    const f = await fixture(); const events: string[] = []; let observations = 0; let connections = 0; let now = 2_000_000_500_000;
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "verify", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: path.join(f.root, "committed"), archiveDir: path.join(f.root, "unused"), parameters: { "image-test": { prompt: "x" } }, privateKey: f.privateKey, publicKey: f.publicKey }, {
      now: () => ++now, expectedPackageNames: [f.packageName], connect: async () => { connections += 1; return fakeSession(events, { connectionId: `connection-${connections}-fresh` }); },
      observeListener: async () => { observations += 1; return observations === 3 ? { ...identityBefore, pid: 999, processIdentity: "boot-1:unexpected" } : connections === 1 ? identityBefore : identityAfter; },
      restart: async () => { events.push("restart"); return { stoppedAtMs: ++now, restartedAtMs: ++now }; },
    })).rejects.toThrow(/spontaneously/i);
    expect(events).toContain("restart");
  });

  it("removes an oversized partial stream and never publishes its run directory", async () => {
    const f = await fixture(); const rootEntriesBefore = await fs.readdir(f.root); let connections = 0; let now = 2_000_000_600_000;
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "verify", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: path.join(f.root, "committed"), archiveDir: path.join(f.root, "unused"), parameters: { "image-test": { prompt: "x" } }, privateKey: f.privateKey, publicKey: f.publicKey }, {
      now: () => ++now, expectedPackageNames: [f.packageName], connect: async () => { connections += 1; return fakeSession([], { connectionId: `connection-${connections}-fresh`, downloadToFile: async (_file, target) => { await fs.writeFile(target, Buffer.alloc(2048)); throw new Error("stream oversized"); } }); },
      observeListener: async () => connections === 1 ? identityBefore : identityAfter, restart: async () => ({ stoppedAtMs: ++now, restartedAtMs: ++now }),
    })).rejects.toThrow(/oversized/i);
    const rootEntriesAfter = await fs.readdir(f.root);
    expect(rootEntriesAfter.filter((name) => name.includes(".committed.run-"))).toEqual([]);
    expect(rootEntriesAfter.length).toBe(rootEntriesBefore.length);
  });

  it("removes staged artifacts/evidence when a later package crashes", async () => {
    const names = ["image-first", "image-second"]; const f = await fixture("image", names); let connections = 0; let submits = 0; let now = 2_000_000_700_000;
    const committedDir = path.join(f.root, "committed");
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "verify", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: committedDir, archiveDir: path.join(f.root, "unused"), parameters: { "image-first": { prompt: "one" }, "image-second": { prompt: "two" } }, privateKey: f.privateKey, publicKey: f.publicKey }, {
      now: () => ++now, expectedPackageNames: names, connect: async () => { connections += 1; return fakeSession([], { connectionId: `connection-${connections}-fresh`, submit: async () => { submits += 1; return `prompt-${submits}`; }, history: async () => { if (submits === 2) throw new Error("second package crash"); return { status: { status_str: "success", completed: true }, outputs: { "2": { images: [{ filename: "result.png", subfolder: "", type: "output" }] } } }; } }); },
      observeListener: async () => ({ pid: 100 + connections, processCreatedAtMs: 1_000 + connections, bootId: "boot-1", processIdentity: `boot-1:${connections}` }),
      restart: async () => ({ stoppedAtMs: ++now, restartedAtMs: ++now }),
    })).rejects.toThrow(/second package crash/i);
    await expect(fs.lstat(committedDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(f.root)).filter((name) => name.includes(".committed.run-"))).toEqual([]);
  });

  it("rejects a current generation missing the exact six packages before connecting", async () => {
    const f = await fixture(); let connected = false;
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "inventory-only", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: path.join(f.root, "e"), archiveDir: path.join(f.root, "a"), parameters: {} }, {
      connect: async () => { connected = true; return fakeSession([]); }, observeListener: async () => identityBefore, restart: async () => ({ stoppedAtMs: 1, restartedAtMs: 2 }),
    })).rejects.toThrow(/exact fixed Pixelle package set/i);
    expect(connected).toBe(false);
  });

  it("persists an uncertain restart block and only clears it after explicit external recovery probes", async () => {
    const f = await fixture(); const marker = path.join(f.root, "restart-blocked.json"); let now = 2_000_000_800_000;
    const options = { baseUrl: "http://127.0.0.1:8000", mode: "verify" as const, pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: path.join(f.root, "committed"), archiveDir: path.join(f.root, "unused"), blockedMarkerFile: marker, parameters: { "image-test": { prompt: "x" } }, privateKey: f.privateKey, publicKey: f.publicKey };
    await expect(verifySingleComfyUI(options, { now: () => ++now, expectedPackageNames: [f.packageName], connect: async () => fakeSession([]), observeListener: async () => identityBefore, restart: async () => { throw new Error("restart uncertain"); } })).rejects.toThrow(/restart uncertain/i);
    await expect(fs.lstat(marker)).resolves.toMatchObject({ isFile: expect.any(Function) });
    let connected = false;
    await expect(verifySingleComfyUI({ ...options, mode: "inventory-only" }, { expectedPackageNames: [f.packageName], connect: async () => { connected = true; return fakeSession([]); }, observeListener: async () => identityBefore, restart: async () => ({ stoppedAtMs: 1, restartedAtMs: 2 }) })).rejects.toThrow(/blocked pending explicit external recovery/i);
    expect(connected).toBe(false);
    await expect(verifySingleComfyUI({ ...options, mode: "inventory-only", recoveryConfirmation: `RECOVER-${f.generationDigest}` }, { expectedPackageNames: [f.packageName], connect: async () => fakeSession([]), observeListener: async () => identityBefore, restart: async () => ({ stoppedAtMs: 1, restartedAtMs: 2 }) })).resolves.toMatchObject({ mode: "inventory-only" });
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a pre-existing committed set without touching it", async () => {
    const f = await fixture(); const committedDir = path.join(f.root, "committed"); await fs.mkdir(committedDir); await fs.writeFile(path.join(committedDir, "owner.txt"), "existing");
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "verify", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: committedDir, archiveDir: path.join(f.root, "unused"), parameters: { "image-test": { prompt: "x" } }, privateKey: f.privateKey, publicKey: f.publicKey }, { expectedPackageNames: [f.packageName], connect: async () => fakeSession([]), observeListener: async () => identityBefore, restart: async () => ({ stoppedAtMs: 1, restartedAtMs: 2 }) })).rejects.toThrow(/committed set already exists/i);
    expect(await fs.readFile(path.join(committedDir, "owner.txt"), "utf8")).toBe("existing");
  });

  it("accepts locally captured SaveImage object_info with empty RETURN_TYPES", async () => {
    const f = await fixture(); const captured = JSON.parse(await fs.readFile(path.join(__dirname, "fixtures", "comfyui-object-info-captured.json"), "utf8"));
    const primitive = { input: { required: { value: ["STRING", {}] } }, output: ["STRING"], output_is_list: [false], output_name: ["STRING"], output_node: false, name: "PrimitiveStringMultiline", display_name: "Text", description: "" };
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "inventory-only", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: path.join(f.root, "e"), archiveDir: path.join(f.root, "a"), parameters: {} }, {
      expectedPackageNames: [f.packageName], processIdentityForPid: async () => "current-process-identity",
      connect: async () => fakeSession([], { objectInfo: async () => ({ PrimitiveStringMultiline: primitive, SaveImage: captured.SaveImage }) }), observeListener: async () => identityBefore, restart: async () => ({ stoppedAtMs: 1, restartedAtMs: 2 }),
    })).resolves.toMatchObject({ mode: "inventory-only" });
  });

  it("accepts locally captured VHS output_node with VHS_FILENAMES while keeping gifs history-only", async () => {
    const f = await fixture("video"); const captured = JSON.parse(await fs.readFile(path.join(__dirname, "fixtures", "comfyui-object-info-captured.json"), "utf8"));
    const primitive = { input: { required: { value: ["STRING", {}] } }, output: ["STRING"], output_is_list: [false], output_name: ["STRING"], output_node: false, name: "PrimitiveStringMultiline", display_name: "Text", description: "" };
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "inventory-only", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: path.join(f.root, "e"), archiveDir: path.join(f.root, "a"), parameters: {} }, {
      expectedPackageNames: [f.packageName], processIdentityForPid: async () => "current-process-identity", connect: async () => fakeSession([], { objectInfo: async () => ({ PrimitiveStringMultiline: primitive, VHS_VideoCombine: captured.VHS_VideoCombine }) }), observeListener: async () => identityBefore, restart: async () => ({ stoppedAtMs: 1, restartedAtMs: 2 }),
    })).resolves.toMatchObject({ mode: "inventory-only" });
  });

  it("normalizes both model inventory and manifest path separators", async () => {
    const f = await fixture("image", undefined, "nested/model.safetensors");
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "inventory-only", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: path.join(f.root, "e"), archiveDir: path.join(f.root, "a"), parameters: {} }, {
      expectedPackageNames: [f.packageName], processIdentityForPid: async () => "current-process-identity", connect: async () => fakeSession([], { models: async () => ["nested\\model.safetensors"] }), observeListener: async () => identityBefore, restart: async () => ({ stoppedAtMs: 1, restartedAtMs: 2 }),
    })).resolves.toMatchObject({ mode: "inventory-only" });
  });

  it("writes a durable restart-required marker before submit and refuses submit when marker publication fails", async () => {
    const f = await fixture(); let submits = 0; let restarts = 0;
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "verify", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: path.join(f.root, "committed"), archiveDir: path.join(f.root, "a"), parameters: { "image-test": { prompt: "x" } }, privateKey: f.privateKey, publicKey: f.publicKey }, {
      expectedPackageNames: [f.packageName], processIdentityForPid: async () => "current-process-identity", writeRestartMarker: async () => { throw new Error("marker fsync failed"); },
      connect: async () => fakeSession([], { submit: async () => { submits += 1; return "prompt"; } }), observeListener: async () => identityBefore, restart: async () => { restarts += 1; return { stoppedAtMs: 1, restartedAtMs: 2 }; },
    })).rejects.toThrow(/marker fsync failed/i);
    expect(submits).toBe(0); expect(restarts).toBe(0);
  });

  it("leaves the pre-submit marker behind when the process crashes after marker durability", async () => {
    const f = await fixture(); const marker = path.join(f.root, "restart-required.json"); let submits = 0;
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "verify", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: path.join(f.root, "committed"), archiveDir: path.join(f.root, "a"), blockedMarkerFile: marker, parameters: { "image-test": { prompt: "x" } }, privateKey: f.privateKey, publicKey: f.publicKey }, {
      expectedPackageNames: [f.packageName], processIdentityForPid: async () => "current-process-identity", afterRestartMarker: async () => { throw new Error("simulated process crash"); },
      connect: async () => fakeSession([], { submit: async () => { submits += 1; return "prompt"; } }), observeListener: async () => identityBefore, restart: async () => ({ stoppedAtMs: 1, restartedAtMs: 2 }),
    })).rejects.toThrow(/simulated process crash/i);
    expect(submits).toBe(0); expect(JSON.parse(await fs.readFile(marker, "utf8"))).toMatchObject({ schemaVersion: 2, state: "restart-required", packageName: "image-test", connectionId: "connection-before" });
  });

  it("retries short file writes until every byte is written", async () => {
    const written: number[] = [];
    const handle = { async write(bytes: Uint8Array, offset: number, length: number) { const count = Math.min(2, length); written.push(...bytes.subarray(offset, offset + count)); return { bytesWritten: count, buffer: bytes }; } };
    await writeAllBytes(handle as never, Uint8Array.from([1, 2, 3, 4, 5]));
    expect(written).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects a fresh task4.lock owned by another OS process", async () => {
    const f = await fixture(); const lockFile = path.join(f.root, "task4.lock");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { windowsHide: true, stdio: "ignore" });
    try {
      await fs.writeFile(lockFile, `${canonicalize({ schemaVersion: 2, pid: child.pid!, processIdentity: "external-process-identity", token: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", startedAtMs: Date.now() })}\n`);
      await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "inventory-only", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: path.join(f.root, "e"), archiveDir: path.join(f.root, "a"), lockFile, parameters: {} }, {
        expectedPackageNames: [f.packageName], processIdentityForPid: async () => "current-process-identity", connect: async () => fakeSession([]), observeListener: async () => identityBefore, restart: async () => ({ stoppedAtMs: 1, restartedAtMs: 2 }),
      })).rejects.toThrow(/locked by an active task4.lock/i);
    } finally { child.kill(); }
  });

  it("rejects Task 4 while a second OS process owns the shared prepare.lock", async () => {
    const f = await fixture(); const prepareLock = path.join(f.root, "staging", "prepare.lock"); const ready = path.join(f.root, "prepare-ready");
    const helper = path.join(f.root, "prepare-owner.mts");
    const prepareModule = pathToFileURL(path.resolve("scripts/prepare-pixelle-single-backend.ts")).href;
    await fs.writeFile(helper, `import { promises as fs } from "node:fs"; import { preparePixelleSingleBackendPackages } from ${JSON.stringify(prepareModule)}; await preparePixelleSingleBackendPackages({ pixelleRoot: process.env.PIXELLE_ROOT!, stagingDir: process.env.STAGING_DIR!, afterLockAcquired: async () => { await fs.writeFile(process.env.READY_FILE!, "ready"); setInterval(() => {}, 1000); await new Promise(() => {}); } });\n`);
    const child = spawn(process.execPath, ["--import", "tsx", helper], { cwd: process.cwd(), env: { ...process.env, PIXELLE_ROOT: f.pixelleRoot, STAGING_DIR: path.join(f.root, "staging"), READY_FILE: ready }, windowsHide: true, stdio: "ignore" });
    const childClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) { try { await fs.lstat(ready); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } }
      await expect(fs.lstat(ready)).resolves.toBeDefined(); let connected = false;
      const agedPrepareLock = JSON.parse(await fs.readFile(prepareLock, "utf8")); agedPrepareLock.startedAtMs = Date.now() - 16 * 60_000;
      await fs.writeFile(prepareLock, `${canonicalize(agedPrepareLock)}\n`);
      const observedOwner = await getPixelleProcessIdentity(child.pid!); expect(observedOwner).not.toMatch(/unknown|missing/);
      if (process.platform === "win32") {
        const windowsIdentity = /^win:(\d+):(\d+)$/.exec(observedOwner); expect(windowsIdentity).not.toBeNull();
        expect([windowsIdentity![1], windowsIdentity![2]].some((part) => BigInt(part) % BigInt(10_000) !== BigInt(0))).toBe(true);
      }
      expect(comparePixelleProcessIdentity(agedPrepareLock.processIdentity, observedOwner, child.pid!)).toBe(true);
      await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "inventory-only", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: path.join(f.root, "e"), archiveDir: path.join(f.root, "a"), parameters: {} }, {
        expectedPackageNames: [f.packageName], connect: async () => { connected = true; return fakeSession([]); }, observeListener: async () => identityBefore, restart: async () => ({ stoppedAtMs: 1, restartedAtMs: 2 }),
      })).rejects.toThrow(/original live process/i);
      expect(connected).toBe(false);
    } finally { child.kill(); await childClosed; }
  });

  it("keeps a Task4-written aged prepare.lock when its real OS owner is still alive", async () => {
    const f = await fixture(); const ready = path.join(f.root, "task4-ready"); const helper = path.join(f.root, "task4-owner.mts");
    const task4Module = pathToFileURL(path.resolve("scripts/verify-single-comfyui.ts")).href;
    const childOptions = { baseUrl: "http://127.0.0.1:8000", mode: "inventory-only", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: path.join(f.root, "child-e"), archiveDir: path.join(f.root, "child-a"), parameters: {} };
    await fs.writeFile(helper, `import { promises as fs } from "node:fs"; import { verifySingleComfyUI } from ${JSON.stringify(task4Module)}; await verifySingleComfyUI(${JSON.stringify(childOptions)}, { expectedPackageNames: [${JSON.stringify(f.packageName)}], connect: async () => { await fs.writeFile(${JSON.stringify(ready)}, "ready"); setInterval(() => {}, 1000); await new Promise(() => {}); throw new Error("unreachable"); }, observeListener: async () => { throw new Error("unreachable"); }, restart: async () => { throw new Error("unreachable"); } });\n`);
    const child = spawn(process.execPath, ["--import", "tsx", helper], { cwd: process.cwd(), windowsHide: true, stdio: "ignore" });
    const childClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) { try { await fs.lstat(ready); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } }
      await expect(fs.lstat(ready)).resolves.toBeDefined(); const lockFile = path.join(f.root, "staging", "prepare.lock");
      const aged = JSON.parse(await fs.readFile(lockFile, "utf8")); aged.startedAtMs = Date.now() - 16 * 60_000; await fs.writeFile(lockFile, `${canonicalize(aged)}\n`);
      await expect(preparePixelleSingleBackendPackages({ pixelleRoot: f.pixelleRoot, stagingDir: path.join(f.root, "staging") })).rejects.toThrow(/original live process/i);
      expect(JSON.parse(await fs.readFile(lockFile, "utf8"))).toMatchObject({ pid: child.pid, token: aged.token });
    } finally { child.kill(); await childClosed; }
  }, 15_000);

  it("recovers a stale reused-PID lock only when the old identity is conclusively different", async () => {
    const f = await fixture(); const lockFile = path.join(f.root, "task4.lock"); const now = 2_000_000_900_000;
    expect(comparePixelleProcessIdentity("windows-1700000000000:424242:1700000001000", "win:133444736000000000:133444736010000000", 424242)).toBe(true);
    expect(comparePixelleProcessIdentity("windows-1700000000000:424242:1700000001000", "win:133444736000000123:133444736010004567", 424242)).toBe(true);
    expect(comparePixelleProcessIdentity("win:133444736000000123:133444736010004567", "win:133444736000000124:133444736010004567", 424242)).toBe(false);
    expect(comparePixelleProcessIdentity("old-boot:424242:1000", "win:133444736000000000:133444736010000000", 424242)).toBe("unknown");
    const old = { schemaVersion: 2, pid: 424242, processIdentity: "win:133000000000000000:133000000001000000", token: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", startedAtMs: now - 10_000 };
    await fs.writeFile(lockFile, `${canonicalize(old)}\n`);
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "inventory-only", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: path.join(f.root, "e"), archiveDir: path.join(f.root, "a"), lockFile, parameters: {} }, {
      now: () => now, lockStaleMs: 1_000, expectedPackageNames: [f.packageName], isProcessAlive: async () => true, processIdentityForPid: async (pid) => pid === process.pid ? "current-process-identity" : "win:133000000000000000:133000000009000000",
      connect: async () => fakeSession([]), observeListener: async () => identityBefore, restart: async () => ({ stoppedAtMs: 1, restartedAtMs: 2 }),
    })).resolves.toMatchObject({ mode: "inventory-only" });
    await expect(fs.lstat(`${lockFile}.stale.${old.token}`)).resolves.toBeDefined();
  });

  it("keeps a stale lock blocked when the old process identity is uncertain", async () => {
    const f = await fixture(); const lockFile = path.join(f.root, "task4.lock"); const now = 2_000_000_950_000;
    await fs.writeFile(lockFile, `${canonicalize({ schemaVersion: 2, pid: 424242, processIdentity: "old-boot:424242:1000", token: "cccccccc-cccc-cccc-cccc-cccccccccccc", startedAtMs: now - 10_000 })}\n`);
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "inventory-only", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: path.join(f.root, "e"), archiveDir: path.join(f.root, "a"), lockFile, parameters: {} }, {
      now: () => now, lockStaleMs: 1_000, expectedPackageNames: [f.packageName], isProcessAlive: async () => true, processIdentityForPid: async (pid) => pid === process.pid ? "current-process-identity" : "unknown",
      connect: async () => fakeSession([]), observeListener: async () => identityBefore, restart: async () => ({ stoppedAtMs: 1, restartedAtMs: 2 }),
    })).rejects.toThrow(/identity is uncertain/i);
  });

  it("does not steal an aged live legacy Windows lock when canonical identity has 100ns remainder", async () => {
    const f = await fixture(); const lockFile = path.join(f.root, "task4.lock"); const now = 2_000_000_975_000;
    const lock = { schemaVersion: 2, pid: 424242, processIdentity: "windows-1700000000000:424242:1700000001000", token: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", startedAtMs: now - 16 * 60_000 };
    await fs.writeFile(lockFile, `${canonicalize(lock)}\n`);
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "inventory-only", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: path.join(f.root, "e"), archiveDir: path.join(f.root, "a"), lockFile, parameters: {} }, {
      now: () => now, expectedPackageNames: [f.packageName], isProcessAlive: async () => true,
      processIdentityForPid: async (pid) => pid === process.pid ? "current-process-identity" : "win:133444736000000123:133444736010004567",
      connect: async () => fakeSession([]), observeListener: async () => identityBefore, restart: async () => ({ stoppedAtMs: 1, restartedAtMs: 2 }),
    })).rejects.toThrow(/original live process/i);
    expect(JSON.parse(await fs.readFile(lockFile, "utf8"))).toMatchObject({ token: lock.token });
  });

  it("chains all six package restarts and publishes the last package after as final endpoint", async () => {
    const names = ["tts-index2", "tts-index2-8g", "tts-omnivoice-longform-bf16", "tts-omnivoice-clone-duration-bf16", "image-z-image-turbo", "video-wan2.1-fusionx"];
    const f = await fixture("image", names); let connections = 0; let now = 2_000_001_000_000; let restarts = 0;
    const parameters = Object.fromEntries(names.map((name) => [name, { prompt: name }])); const committedDir = path.join(f.root, "committed");
    const result = await verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "verify", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: committedDir, archiveDir: path.join(f.root, "a"), parameters, privateKey: f.privateKey, publicKey: f.publicKey }, {
      now: () => ++now, processIdentityForPid: async () => "current-process-identity", connect: async () => { connections += 1; return fakeSession([], { connectionId: `connection-${connections}-fresh` }); },
      observeListener: async () => ({ pid: 100 + connections, processCreatedAtMs: 1_000 + connections, bootId: "boot-1", processIdentity: `boot-1:${connections}` }), restart: async () => { restarts += 1; return { stoppedAtMs: ++now, restartedAtMs: ++now }; },
    });
    expect(restarts).toBe(6); expect(result.evidenceFiles).toHaveLength(6);
    const evidence = await Promise.all(result.evidenceFiles.map(async (file) => JSON.parse(await fs.readFile(file, "utf8"))));
    for (let index = 0; index < evidence.length - 1; index += 1) expect(evidence[index].restart.after).toEqual(evidence[index + 1].restart.before);
    const commit = JSON.parse(await fs.readFile(path.join(committedDir, "commit.json"), "utf8"));
    expect(commit.finalEndpoint).toEqual(evidence.at(-1).restart.after);
  });

  it("revalidates every evidence TTL at final commit time", async () => {
    const f = await fixture(); let connections = 0; let now = 2_000_002_000_000; const committedDir = path.join(f.root, "committed");
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "verify", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: committedDir, archiveDir: path.join(f.root, "a"), parameters: { "image-test": { prompt: "x" } }, privateKey: f.privateKey, publicKey: f.publicKey, evidenceTtlMs: 1 }, {
      now: () => (now += 2), expectedPackageNames: [f.packageName], processIdentityForPid: async () => "current-process-identity", connect: async () => { connections += 1; return fakeSession([], { connectionId: `connection-${connections}-fresh` }); }, observeListener: async () => connections === 1 ? identityBefore : identityAfter, restart: async () => ({ stoppedAtMs: (now += 2), restartedAtMs: (now += 2) }),
    })).rejects.toThrow(/stale/i);
    await expect(fs.lstat(committedDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects evidence TTL above the strict 24 hour maximum", async () => {
    const f = await fixture();
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "verify", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: path.join(f.root, "e"), archiveDir: path.join(f.root, "a"), parameters: { "image-test": { prompt: "x" } }, evidenceTtlMs: 7 * 24 * 60 * 60_000 }, {
      expectedPackageNames: [f.packageName], processIdentityForPid: async () => "current-process-identity", connect: async () => fakeSession([]), observeListener: async () => identityBefore, restart: async () => ({ stoppedAtMs: 1, restartedAtMs: 2 }),
    })).rejects.toThrow(/evidence TTL.*bounded range/i);
  });

  it("freshly re-signs every package together after a long six-package run", async () => {
    const names = ["tts-index2", "tts-index2-8g", "tts-omnivoice-longform-bf16", "tts-omnivoice-clone-duration-bf16", "image-z-image-turbo", "video-wan2.1-fusionx"];
    const f = await fixture("image", names); let connections = 0; let now = 2_000_003_000_000; const committedDir = path.join(f.root, "committed");
    const result = await verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "verify", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: committedDir, archiveDir: path.join(f.root, "a"), parameters: Object.fromEntries(names.map((name) => [name, { prompt: name }])), privateKey: f.privateKey, publicKey: f.publicKey }, {
      now: () => ++now, processIdentityForPid: async () => "current-process-identity", connect: async () => { connections += 1; return fakeSession([], { connectionId: `connection-${connections}-fresh` }); },
      observeListener: async () => ({ pid: 100 + connections, processCreatedAtMs: 1_000 + connections, bootId: "boot-1", processIdentity: `boot-1:${connections}` }), restart: async () => { const stoppedAtMs = ++now; now += 2 * 60 * 60_000; return { stoppedAtMs, restartedAtMs: ++now }; },
    });
    const evidence = await Promise.all(result.evidenceFiles.map(async (file) => JSON.parse(await fs.readFile(file, "utf8"))));
    expect(new Set(evidence.map((item) => item.issuedAtMs)).size).toBe(1);
    expect(evidence.every((item) => item.expiresAtMs - item.issuedAtMs === 60 * 60_000)).toBe(true);
    expect(evidence[0].issuedAtMs).toBeGreaterThan(evidence.at(-1).liveRuns[0].completedAtMs);
  });

  it("fails without commit when the run window plus fresh TTL exceeds 24 hours", async () => {
    const f = await fixture(); let connections = 0; let now = 2_000_004_000_000; const committedDir = path.join(f.root, "committed");
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "verify", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: committedDir, archiveDir: path.join(f.root, "a"), parameters: { "image-test": { prompt: "x" } }, privateKey: f.privateKey, publicKey: f.publicKey }, {
      now: () => ++now, expectedPackageNames: [f.packageName], processIdentityForPid: async () => "current-process-identity", connect: async () => { connections += 1; return fakeSession([], { connectionId: `connection-${connections}-fresh` }); }, observeListener: async () => connections === 1 ? identityBefore : identityAfter,
      restart: async () => { const stoppedAtMs = ++now; now += 24 * 60 * 60_000; return { stoppedAtMs, restartedAtMs: ++now }; },
    })).rejects.toThrow(/execution window is too long/i);
    await expect(fs.lstat(committedDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a current.json switch at final commit while both locks are held", async () => {
    const f = await fixture(); let connections = 0; let now = 2_000_005_000_000; const committedDir = path.join(f.root, "committed");
    await expect(verifySingleComfyUI({ baseUrl: "http://127.0.0.1:8000", mode: "verify", pixelleRoot: f.pixelleRoot, generationRoot: f.generationRoot, expectedGenerationDigest: f.generationDigest, evidenceDir: committedDir, archiveDir: path.join(f.root, "a"), parameters: { "image-test": { prompt: "x" } }, privateKey: f.privateKey, publicKey: f.publicKey }, {
      now: () => ++now, expectedPackageNames: [f.packageName], processIdentityForPid: async () => "current-process-identity", connect: async () => { connections += 1; return fakeSession([], { connectionId: `connection-${connections}-fresh` }); }, observeListener: async () => connections === 1 ? identityBefore : identityAfter, restart: async () => ({ stoppedAtMs: ++now, restartedAtMs: ++now }),
      beforeFinalCurrentCheck: async () => { await fs.writeFile(path.join(f.root, "staging", "current.json"), `${canonicalize({ schemaVersion: 1, generationDigest: "0".repeat(64) })}\n`); },
    })).rejects.toThrow(/current\.json changed away/i);
    await expect(fs.lstat(committedDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
