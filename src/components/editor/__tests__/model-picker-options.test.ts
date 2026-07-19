import { describe, expect, it } from "vitest";
import type { Provider } from "@/stores/model-store";
import {
  buildModelPickerOptions,
  isServerManagedModelRef,
  modelRefStableId,
  selectedProfileRevisionId,
} from "../model-picker-options";

function provider(input: Partial<Provider> & Pick<Provider, "id" | "protocol" | "capability">): Provider {
  return {
    name: input.id,
    baseUrl: "",
    apiKey: "",
    models: [],
    ...input,
  };
}

describe("model picker option merging", () => {
  it("keeps executable cloud and database-backed configurations while hiding stale manual ComfyUI entries", () => {
    const providers = [
      provider({
        id: "cloud-provider",
        protocol: "openai",
        capability: "image",
        models: [{ id: "cloud-image", name: "Cloud image", checked: true }],
      }),
      provider({
        id: "manual-comfy",
        protocol: "comfyui",
        capability: "image",
        models: [{ id: "manual-profile-revision", name: "Manual workflow", checked: true }],
      }),
    ];

    const options = buildModelPickerOptions(providers, "image", [{
      id: "database-profile-revision",
      displayName: "Database workflow",
      adapterKind: "comfyui",
    }]);

    expect(options.map((option) => [option.providerId, option.modelId])).toEqual([
      ["cloud-provider", "cloud-image"],
      ["local", "database-profile-revision"],
    ]);
  });

  it("deduplicates the same profile revision by stable id and prefers the database entry", () => {
    const providers = [provider({
      id: "manual-comfy",
      protocol: "comfyui",
      capability: "speech",
      models: [{ id: "omnivoice-r7", name: "Stale display name", checked: true }],
    })];

    const options = buildModelPickerOptions(providers, "speech", [
      { id: "omnivoice-r7", displayName: "OmniVoice revision 7", adapterKind: "comfyui" },
      { id: "omnivoice-r7", displayName: "Duplicate", adapterKind: "comfyui" },
    ]);

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      stableId: "profile:omnivoice-r7",
      providerId: "local",
      modelId: "omnivoice-r7",
      modelName: "OmniVoice revision 7",
    });
    expect(modelRefStableId(
      { providerId: "manual-comfy", modelId: "omnivoice-r7" },
    )).not.toBe(options[0]?.stableId);
  });

  it("does not misroute a non-ComfyUI database profile through the local workflow path", () => {
    const options = buildModelPickerOptions([], "image", [{
      id: "remote-profile-revision",
      displayName: "Remote profile",
      adapterKind: "openai",
    }]);

    expect(options).toEqual([]);
  });

  it("recognizes only canonical database-backed server-managed references", () => {
    expect(isServerManagedModelRef(
      { providerId: "local", modelId: "indextts2-r3" },
    )).toBe(true);
    expect(isServerManagedModelRef(
      { providerId: "manual-comfy", modelId: "omnivoice-r7" },
    )).toBe(false);
    expect(isServerManagedModelRef(
      { providerId: "missing", modelId: "omnivoice-r7" },
    )).toBe(false);
    expect(selectedProfileRevisionId(
      { providerId: "manual-comfy", modelId: "omnivoice-r7" },
    )).toBeNull();
    expect(selectedProfileRevisionId(
      { providerId: "missing", modelId: "indextts2-r3" },
    )).toBeNull();
  });
});
