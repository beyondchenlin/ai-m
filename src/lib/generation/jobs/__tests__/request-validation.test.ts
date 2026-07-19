import { describe, expect, it } from "vitest";
import type { CompiledBindings } from "@/lib/generation/workflows";
import {
  GenerationRequestValidationError,
  normalizeCompiledWorkflowRequest,
} from "../request-validation";

const compiled: CompiledBindings = {
  schemaVersion: 1,
  compilerVersion: "test",
  workflowId: "request-validation",
  version: "1.0.0",
  workflowSha256: `sha256:${"1".repeat(64)}`,
  authorContractSha256: `sha256:${"2".repeat(64)}`,
  bindings: [
    {
      key: "prompt", inputName: "text", valueType: "string", source: "request",
      required: true, userOverride: true, nodeId: "1", classType: "Text",
    },
    {
      key: "steps", inputName: "steps", valueType: "integer", source: "request",
      required: false, userOverride: true, default: 20, minimum: 10, maximum: 40, step: 2,
      nodeId: "2", classType: "Sampler",
    },
    {
      key: "locked", inputName: "locked", valueType: "boolean", source: "request",
      required: true, userOverride: false, nodeId: "2", classType: "Sampler",
    },
    {
      key: "options", inputName: "options", valueType: "json", source: "request",
      required: false, userOverride: true, nodeId: "2", classType: "Sampler",
    },
    {
      key: "voiceReference", inputName: "audio", valueType: "audio", source: "voice-reference",
      required: true, userOverride: false, nodeId: "3", classType: "Audio",
    },
  ],
  outputs: [{ key: "result", field: "images", mediaKind: "image", maxItems: 1, nodeId: "4", classType: "Save" }],
};

function expectCode(fn: () => unknown, status: 400 | 413, code: string): void {
  try {
    fn();
    throw new Error("expected validation failure");
  } catch (error) {
    expect(error).toBeInstanceOf(GenerationRequestValidationError);
    expect(error).toMatchObject({ status, code });
  }
}

describe("compiled workflow request normalization", () => {
  it("normalizes defaults once in compiled binding order", () => {
    expect(normalizeCompiledWorkflowRequest(compiled, { prompt: "hello" }, { locked: true, steps: 22 }))
      .toEqual({ prompt: "hello", steps: 22, locked: true });
  });

  it.each([
    ["unknown", { prompt: "x", extra: true }, {}, "workflow_input_unknown"],
    ["non-request source", { prompt: "x", voiceReference: "escape.wav" }, {}, "workflow_input_unknown"],
    ["forbidden override", { prompt: "x", locked: false }, { locked: true }, "workflow_input_override_forbidden"],
    ["missing required", {}, { locked: true }, "workflow_input_required"],
    ["wrong type", { prompt: "x", steps: "20" }, { locked: true }, "workflow_input_number_invalid"],
    ["non-finite", { prompt: "x", steps: Number.POSITIVE_INFINITY }, { locked: true }, "workflow_input_number_invalid"],
    ["below minimum", { prompt: "x", steps: 8 }, { locked: true }, "workflow_input_out_of_range"],
    ["above maximum", { prompt: "x", steps: 42 }, { locked: true }, "workflow_input_out_of_range"],
    ["invalid step", { prompt: "x", steps: 21 }, { locked: true }, "workflow_input_out_of_range"],
  ])("rejects %s with a stable semantic code", (_name, request, defaults, code) => {
    expectCode(() => normalizeCompiledWorkflowRequest(compiled, request, defaults), 400, code);
  });

  it("rejects excessive depth with 413", () => {
    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 18; index++) nested = { child: nested };
    expectCode(
      () => normalizeCompiledWorkflowRequest(compiled, { prompt: "x", options: nested }, { locked: true }),
      413,
      "workflow_input_too_deep",
    );
  });

  it("rejects excessive collection size and normalized bytes with 413", () => {
    expectCode(
      () => normalizeCompiledWorkflowRequest(
        compiled,
        { prompt: "x", options: Array.from({ length: 1_001 }, () => 1) },
        { locked: true },
      ),
      413,
      "workflow_input_collection_too_large",
    );
    expectCode(
      () => normalizeCompiledWorkflowRequest(compiled, { prompt: "x".repeat(100_001) }, { locked: true }),
      413,
      "workflow_input_string_too_large",
    );
  });
});
