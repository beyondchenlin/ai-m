import { describe, expect, it } from "vitest";
import {
  migrateModelStoreState,
  purgeLegacyBrowserCredentials,
  useModelStore,
} from "../model-store";

describe("model store v4 migration", () => {
  it("preserves valid legacy defaults and adds an empty speech default", () => {
    const migrated = migrateModelStoreState({
      providers: [{
        id: "image-provider",
        name: "Image",
        protocol: "openai",
        capability: "image",
        baseUrl: "https://example.invalid",
        apiKey: "secret",
        models: [{ id: "image-model", name: "Image", checked: true }],
      }],
      defaultImageModel: { providerId: "image-provider", modelId: "image-model" },
    });
    expect(migrated.defaultImageModel).toEqual({ providerId: "image-provider", modelId: "image-model" });
    expect(migrated.defaultSpeechModel).toBeNull();
    expect(migrated.providers?.[0]).toMatchObject({ apiKey: "", secretKey: undefined });
  });

  it("accepts a server-managed speech profile and removes invalid defaults", () => {
    const migrated = migrateModelStoreState({
      providers: [{
        id: "speech-provider",
        name: "Local speech",
        protocol: "comfyui",
        capability: "speech",
        baseUrl: "",
        apiKey: "",
        models: [{ id: "profile-revision", name: "IndexTTS2", checked: true }],
      }],
      defaultSpeechModel: { providerId: "speech-provider", modelId: "profile-revision" },
      defaultImageModel: { providerId: "speech-provider", modelId: "profile-revision" },
    });
    expect(migrated.defaultSpeechModel).toEqual({ providerId: "speech-provider", modelId: "profile-revision" });
    expect(migrated.defaultImageModel).toBeNull();
  });

  it("rejects unknown protocols and unchecked default models", () => {
    const migrated = migrateModelStoreState({
      providers: [
        { id: "bad", protocol: "unknown", capability: "speech", models: [] },
        { id: "speech", name: "Speech", protocol: "comfyui", capability: "speech", models: [{ id: "off", checked: false }] },
      ],
      defaultSpeechModel: { providerId: "speech", modelId: "off" },
    });
    expect(migrated.providers).toHaveLength(1);
    expect(migrated.defaultSpeechModel).toBeNull();
  });
});

describe("model store browser credential cleanup", () => {
  it("removes legacy local/session credentials and writes a non-secret audit marker", () => {
    const localValues = new Map<string, string>([[
      "model-store",
      JSON.stringify({
        state: {
          providers: [{
            id: "cloud",
            apiKey: "persisted-secret",
            secretKey: "persisted-secondary",
            nested: { apiKey: "nested-secret" },
          }],
        },
        version: 3,
      }),
    ]]);
    const sessionValues = new Map<string, string>([[
      "ai-m-model-session-credentials-v1",
      JSON.stringify({ cloud: { apiKey: "session-secret" } }),
    ]]);
    const removed = purgeLegacyBrowserCredentials({
      getItem: (key) => localValues.get(key) ?? null,
      setItem: (key, value) => { localValues.set(key, value); },
    }, {
      removeItem: (key) => { sessionValues.delete(key); },
    }, 123);

    expect(removed).toBe(3);
    expect(localValues.get("model-store")).not.toContain("persisted-secret");
    expect(localValues.get("model-store")).not.toContain("persisted-secondary");
    expect(localValues.get("model-store")).not.toContain("nested-secret");
    expect(sessionValues.has("ai-m-model-session-credentials-v1")).toBe(false);
    expect(JSON.parse(localValues.get("ai-m-browser-secret-migration-v1")!)).toEqual({
      schemaVersion: 1,
      completedAtMs: 123,
      removedCredentialFieldCount: 3,
    });
  });
});

describe("model store provider invalidation", () => {
  it("clears stale models and defaults when protocol changes", () => {
    useModelStore.setState({
      providers: [{
        id: "speech-provider",
        name: "Speech",
        protocol: "comfyui",
        capability: "speech",
        baseUrl: "",
        apiKey: "",
        models: [{ id: "profile-revision", name: "IndexTTS2", checked: true }],
      }],
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
      defaultSpeechModel: { providerId: "speech-provider", modelId: "profile-revision" },
    });

    useModelStore.getState().updateProvider("speech-provider", { protocol: "openai" });

    const state = useModelStore.getState();
    expect(state.providers[0]?.models).toEqual([]);
    expect(state.defaultSpeechModel).toBeNull();
  });
});
