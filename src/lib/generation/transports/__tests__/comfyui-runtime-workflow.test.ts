import { describe, expect, it } from "vitest";
import { adaptComfyWorkflowRuntimeChoices } from "../comfyui-runtime-workflow";
import type { ComfyObjectInfo } from "../comfyui";

function objectInfo(choices: string[]): ComfyObjectInfo {
  return {
    UNETLoader: {
      input: { required: { unet_name: [choices] } },
      output: [],
      output_is_list: [],
      output_name: [],
      name: "UNETLoader",
      display_name: "UNETLoader",
      description: "",
      category: "loaders",
      output_node: false,
    },
  };
}

describe("adaptComfyWorkflowRuntimeChoices", () => {
  it("uses the exact Windows runtime spelling without mutating the immutable workflow", () => {
    const workflow = {
      "1": {
        class_type: "UNETLoader",
        inputs: { unet_name: "wan-fusionx/WanT2V_MasterModel.safetensors" },
      },
    };
    const adapted = adaptComfyWorkflowRuntimeChoices(
      workflow,
      objectInfo(["wan-fusionx\\WanT2V_MasterModel.safetensors"]),
    );
    expect((adapted["1"] as { inputs: { unet_name: string } }).inputs.unet_name)
      .toBe("wan-fusionx\\WanT2V_MasterModel.safetensors");
    expect((workflow["1"] as { inputs: { unet_name: string } }).inputs.unet_name)
      .toBe("wan-fusionx/WanT2V_MasterModel.safetensors");
  });

  it("fails closed when the runtime does not expose a normalized match", () => {
    const workflow = {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "missing/model.safetensors" } },
    };
    expect(() => adaptComfyWorkflowRuntimeChoices(
      workflow,
      objectInfo(["other.safetensors"]),
    )).toThrow(/unavailable/i);
  });

  it("fails closed when the runtime exposes an empty choice list", () => {
    const workflow = {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "model.safetensors" } },
    };
    expect(() => adaptComfyWorkflowRuntimeChoices(workflow, objectInfo([]))).toThrow(/unavailable/i);
  });

  it("does not treat a free-text widget as a runtime choice list", () => {
    const info = objectInfo([]);
    info.UNETLoader.input.required = {
      prompt: ["STRING", { multiline: true }],
    };
    const workflow = {
      "1": { class_type: "UNETLoader", inputs: { prompt: "free text" } },
    };
    expect(adaptComfyWorkflowRuntimeChoices(workflow, info)).toEqual(workflow);
  });

  it("does not compare newly uploaded media against a stale runtime choice list", () => {
    const info = objectInfo(["old-runtime-file.png"]);
    info.UNETLoader.input.required = {
      image: [["old-runtime-file.png"]],
    };
    const workflow = {
      "7": { class_type: "UNETLoader", inputs: { image: "system-uploaded-reference.png" } },
    };
    expect(adaptComfyWorkflowRuntimeChoices(
      workflow,
      info,
      new Set(["7:image"]),
    )).toEqual(workflow);
  });

  it("fails closed when normalized runtime choices are ambiguous", () => {
    const workflow = {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "folder/model.safetensors" } },
    };
    expect(() => adaptComfyWorkflowRuntimeChoices(
      workflow,
      objectInfo(["folder/model.safetensors", "folder\\model.safetensors"]),
    )).toThrow(/ambiguous/i);
  });
});
