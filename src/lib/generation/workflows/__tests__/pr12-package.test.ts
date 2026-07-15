import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bindWorkflow } from "../binder";
import { compileWorkflowBindings } from "../compiler";
import { parseWorkflowManifest } from "../manifest";
import { normalizeComfyWorkflow } from "../normalize";
import { parseWorkflowPackageLock, verifyLockedFiles } from "../package-lock";

const workflowRaw = {
  "1": { class_type: "TextInput", inputs: { text: "" }, _meta: { title: "Prompt" } },
  "2": { class_type: "SaveImage", inputs: { filename_prefix: "unsafe" }, _meta: { title: "Output" } },
};

const manifestRaw = {
  schemaVersion: 1,
  workflowId: "test.image",
  version: "1.0.0",
  displayName: "Test Image",
  capability: "image",
  workflowFile: "workflow.api.json",
  bindings: [{
    key: "prompt", selector: { nodeId: "1", classType: "TextInput" }, inputName: "text",
    valueType: "string", source: "request", required: true, userOverride: true,
  }],
  outputs: [{
    key: "image", selector: { nodeId: "2", classType: "SaveImage" }, field: "images",
    mediaKind: "image", maxItems: 1,
  }],
  requirements: { nodeClasses: ["TextInput", "SaveImage"], models: [], referenceModes: ["off"] },
  limits: { maxPromptChars: 1000, maxPixels: 1048576, maxBatch: 1, maxOutputs: 1, maxJobMs: 60000, maxOutputBytes: 10485760 },
};

describe("PR-12 workflow package contract", () => {
  it("normalizes official numeric-node API workflows and binds fixed targets", () => {
    const workflow = normalizeComfyWorkflow(workflowRaw);
    const manifest = parseWorkflowManifest(manifestRaw);
    const compiled = compileWorkflowBindings(workflow, manifest);
    const bound = bindWorkflow(workflow, compiled, { prompt: "hello" }, "ai-m/job/attempt");
    expect(bound["1"].inputs.text).toBe("hello");
    expect(bound["2"].inputs.filename_prefix).toBe("ai-m/job/attempt");
  });

  it("rejects selector ambiguity and unlocked package bytes", () => {
    expect(() => parseWorkflowManifest({
      ...manifestRaw,
      bindings: [{ ...manifestRaw.bindings[0], selector: { nodeId: "1", classType: "TextInput", metaTitle: "Prompt" } }],
    })).toThrow(/exactly one/i);

    const manifest = parseWorkflowManifest(manifestRaw);
    const workflowDigest = createHash("sha256").update("workflow").digest("hex");
    const manifestDigest = createHash("sha256").update("manifest").digest("hex");
    const lock = parseWorkflowPackageLock({
      schemaVersion: 1,
      workflowId: manifest.workflowId,
      version: manifest.version,
      files: { "workflow.api.json": workflowDigest, "manifest.json": manifestDigest },
      environmentLockDigest: `sha256:${"1".repeat(64)}`,
    }, manifest);
    expect(() => verifyLockedFiles(lock, {
      "workflow.api.json": workflowDigest,
      "manifest.json": "0".repeat(64),
    })).toThrow(/digest mismatch/i);
  });

  it("enforces numeric binding step contracts at manifest, compiled and bind time", () => {
    const numericManifest = parseWorkflowManifest({
      ...manifestRaw,
      bindings: [{
        key: "duration", selector: { nodeId: "1", classType: "TextInput" }, inputName: "text",
        valueType: "number", source: "request", required: true, userOverride: true,
        minimum: 0.5, maximum: 60, step: 0.5,
      }],
    });
    const workflow = normalizeComfyWorkflow(workflowRaw);
    const compiled = compileWorkflowBindings(workflow, numericManifest);
    expect(compiled.bindings[0]).toMatchObject({ minimum: 0.5, maximum: 60, step: 0.5 });
    expect(bindWorkflow(workflow, compiled, { duration: 0.5 }, "out")["1"].inputs.text).toBe(0.5);
    expect(bindWorkflow(workflow, compiled, { duration: 60 }, "out")["1"].inputs.text).toBe(60);
    expect(() => bindWorkflow(workflow, compiled, { duration: 0.4 }, "out")).toThrow(/minimum/i);
    expect(() => bindWorkflow(workflow, compiled, { duration: 60.5 }, "out")).toThrow(/maximum|exceeds/i);
    expect(() => bindWorkflow(workflow, compiled, { duration: 0.75 }, "out")).toThrow(/step/i);
    expect(() => parseWorkflowManifest({ ...manifestRaw, bindings: [{ ...numericManifest.bindings[0], step: 0 }] })).toThrow(/step/i);
  });
});
