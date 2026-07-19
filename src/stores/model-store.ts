import { create } from "zustand";
import { persist } from "zustand/middleware";
import { id as genId } from "@/lib/id";

export type Protocol =
  | "openai"
  | "gemini"
  | "seedance"
  | "ucloud-seedance"
  | "kling"
  | "wan"
  | "dashscope"
  | "comfyui";

export type Capability = "text" | "image" | "video" | "speech";

export interface Model {
  id: string;
  name: string;
  checked: boolean;
}

export interface Provider {
  id: string;
  name: string;
  protocol: Protocol;
  capability: Capability;
  baseUrl: string;
  apiKey: string;
  secretKey?: string;
  models: Model[];
}

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export interface ResolvedModelConfig {
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  secretKey?: string;
  modelId: string;
}

export interface ModelConfig {
  text: ResolvedModelConfig | null;
  image: ResolvedModelConfig | null;
  video: ResolvedModelConfig | null;
  speech: ResolvedModelConfig | null;
}

interface PersistedModelStoreInput {
  providers?: unknown;
  defaultTextModel?: unknown;
  defaultImageModel?: unknown;
  defaultVideoModel?: unknown;
  defaultSpeechModel?: unknown;
}

interface PersistedModelStore {
  providers: Provider[];
  defaultTextModel: ModelRef | null;
  defaultImageModel: ModelRef | null;
  defaultVideoModel: ModelRef | null;
  defaultSpeechModel: ModelRef | null;
}

interface ModelStore {
  providers: Provider[];
  defaultTextModel: ModelRef | null;
  defaultImageModel: ModelRef | null;
  defaultVideoModel: ModelRef | null;
  defaultSpeechModel: ModelRef | null;

  addProvider: (provider: Omit<Provider, "id" | "models">) => string;
  updateProvider: (id: string, updates: Partial<Omit<Provider, "id">>) => void;
  removeProvider: (id: string) => void;
  setModels: (providerId: string, models: Model[]) => void;
  toggleModel: (providerId: string, modelId: string) => void;
  addManualModel: (providerId: string, modelId: string) => void;
  removeModel: (providerId: string, modelId: string) => void;
  setDefaultTextModel: (ref: ModelRef | null) => void;
  setDefaultImageModel: (ref: ModelRef | null) => void;
  setDefaultVideoModel: (ref: ModelRef | null) => void;
  setDefaultSpeechModel: (ref: ModelRef | null) => void;
  getModelConfig: () => ModelConfig;
}

const PROTOCOLS = new Set<Protocol>([
  "openai",
  "gemini",
  "seedance",
  "ucloud-seedance",
  "kling",
  "wan",
  "dashscope",
  "comfyui",
]);
const CAPABILITIES = new Set<Capability>(["text", "image", "video", "speech"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const SESSION_CREDENTIALS_KEY = "ai-m-model-session-credentials-v1";
const CREDENTIAL_MIGRATION_MARKER = "ai-m-browser-secret-migration-v1";

function stripBrowserCredentials(value: unknown): { value: unknown; removed: number } {
  if (Array.isArray(value)) {
    const items = value.map(stripBrowserCredentials);
    return {
      value: items.map((item) => item.value),
      removed: items.reduce((sum, item) => sum + item.removed, 0),
    };
  }
  if (!isRecord(value)) return { value, removed: 0 };
  let removed = 0;
  const clean: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "apiKey" || key === "secretKey") {
      if (typeof item === "string" && item) removed++;
      if (key === "apiKey") clean[key] = "";
      continue;
    }
    const nested = stripBrowserCredentials(item);
    clean[key] = nested.value;
    removed += nested.removed;
  }
  return { value: clean, removed };
}

export function purgeLegacyBrowserCredentials(
  local: Pick<Storage, "getItem" | "setItem">,
  session: Pick<Storage, "removeItem">,
  completedAtMs = Date.now(),
): number {
  let removed = 0;
  try {
    const raw = local.getItem("model-store");
    if (raw) {
      const stripped = stripBrowserCredentials(JSON.parse(raw) as unknown);
      removed = stripped.removed;
      local.setItem("model-store", JSON.stringify(stripped.value));
    }
  } catch { /* Zustand migration still strips credentials during hydration. */ }
  try { session.removeItem(SESSION_CREDENTIALS_KEY); } catch { /* best effort */ }
  try {
    local.setItem(CREDENTIAL_MIGRATION_MARKER, JSON.stringify({
      schemaVersion: 1,
      completedAtMs,
      removedCredentialFieldCount: removed,
    }));
  } catch { /* best effort */ }
  return removed;
}

function normalizeModel(value: unknown): Model | null {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) return null;
  const id = value.id.trim().slice(0, 512);
  const name = typeof value.name === "string" && value.name.trim()
    ? value.name.trim().slice(0, 240)
    : id;
  return { id, name, checked: value.checked === true };
}

function normalizeProvider(value: unknown): Provider | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id.trim()) return null;
  const legacyCapabilities = Array.isArray(value.capabilities)
    ? value.capabilities.filter((item): item is string => typeof item === "string")
    : [];
  const capabilityCandidate = typeof value.capability === "string"
    ? value.capability
    : legacyCapabilities[0] ?? "text";
  const protocolCandidate = typeof value.protocol === "string" ? value.protocol : "openai";
  if (!CAPABILITIES.has(capabilityCandidate as Capability)) return null;
  if (!PROTOCOLS.has(protocolCandidate as Protocol)) return null;

  const models = Array.isArray(value.models)
    ? value.models.map(normalizeModel).filter((item): item is Model => Boolean(item))
    : [];
  const deduplicated = [...new Map(models.map((model) => [model.id, model])).values()];

  return {
    id: value.id.trim().slice(0, 160),
    name: typeof value.name === "string" && value.name.trim()
      ? value.name.trim().slice(0, 160)
      : "Provider",
    protocol: protocolCandidate as Protocol,
    capability: capabilityCandidate as Capability,
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl.trim().slice(0, 2_048) : "",
    // Browser-persisted credentials are intentionally discarded during migration.
    apiKey: "",
    secretKey: undefined,
    models: deduplicated,
  };
}

function normalizeModelRef(value: unknown, providers: Provider[], capability: Capability): ModelRef | null {
  if (!isRecord(value) || typeof value.providerId !== "string" || typeof value.modelId !== "string") return null;
  const provider = providers.find((item) => item.id === value.providerId && item.capability === capability);
  if (!provider || !provider.models.some((model) => model.id === value.modelId && model.checked)) return null;
  return { providerId: value.providerId, modelId: value.modelId };
}

export function migrateModelStoreState(value: unknown): PersistedModelStore {
  const input = isRecord(value) ? value as PersistedModelStoreInput : {};
  const providers = Array.isArray(input.providers)
    ? input.providers.map(normalizeProvider).filter((item): item is Provider => Boolean(item))
    : [];
  return {
    providers,
    defaultTextModel: normalizeModelRef(input.defaultTextModel, providers, "text"),
    defaultImageModel: normalizeModelRef(input.defaultImageModel, providers, "image"),
    defaultVideoModel: normalizeModelRef(input.defaultVideoModel, providers, "video"),
    defaultSpeechModel: normalizeModelRef(input.defaultSpeechModel, providers, "speech"),
  };
}

function resolveModel(state: ModelStore, ref: ModelRef | null, capability: Capability): ResolvedModelConfig | null {
  if (!ref) return null;
  const provider = state.providers.find((item) => item.id === ref.providerId && item.capability === capability);
  if (!provider || !provider.models.some((model) => model.id === ref.modelId && model.checked)) return null;
  return {
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    secretKey: provider.secretKey,
    modelId: ref.modelId,
  };
}

export const useModelStore = create<ModelStore>()(
  persist(
    (set, get) => ({
      providers: [],
      defaultTextModel: null,
      defaultImageModel: null,
      defaultVideoModel: null,
      defaultSpeechModel: null,

      addProvider: (provider) => {
        const id = genId();
        set((state) => ({ providers: [...state.providers, { ...provider, id, models: [] }] }));
        return id;
      },

      updateProvider: (id, updates) => {
        set((state) => {
          const current = state.providers.find((provider) => provider.id === id);
          if (!current) return state;
          const protocolChanged = updates.protocol !== undefined && updates.protocol !== current.protocol;
          const capabilityChanged = updates.capability !== undefined && updates.capability !== current.capability;
          const baseUrlChanged = updates.baseUrl !== undefined && updates.baseUrl.trim() !== current.baseUrl.trim();
          const invalidateModels = protocolChanged || capabilityChanged || baseUrlChanged;
          const providers = state.providers.map((provider) => provider.id === id
            ? { ...provider, ...updates, ...(invalidateModels ? { models: [] } : {}) }
            : provider);
          if (!invalidateModels) return { providers };
          return {
            providers,
            defaultTextModel: state.defaultTextModel?.providerId === id ? null : state.defaultTextModel,
            defaultImageModel: state.defaultImageModel?.providerId === id ? null : state.defaultImageModel,
            defaultVideoModel: state.defaultVideoModel?.providerId === id ? null : state.defaultVideoModel,
            defaultSpeechModel: state.defaultSpeechModel?.providerId === id ? null : state.defaultSpeechModel,
          };
        });
      },

      removeProvider: (id) => {
        set((state) => ({
          providers: state.providers.filter((provider) => provider.id !== id),
          defaultTextModel: state.defaultTextModel?.providerId === id ? null : state.defaultTextModel,
          defaultImageModel: state.defaultImageModel?.providerId === id ? null : state.defaultImageModel,
          defaultVideoModel: state.defaultVideoModel?.providerId === id ? null : state.defaultVideoModel,
          defaultSpeechModel: state.defaultSpeechModel?.providerId === id ? null : state.defaultSpeechModel,
        }));
      },

      setModels: (providerId, models) => {
        set((state) => {
          const provider = state.providers.find((item) => item.id === providerId);
          const normalized = [...new Map(models.map((model) => [model.id, model])).values()];
          const validIds = new Set(normalized.filter((model) => model.checked).map((model) => model.id));
          const clears = provider
            ? {
                defaultTextModel: provider.capability === "text" && state.defaultTextModel?.providerId === providerId && !validIds.has(state.defaultTextModel.modelId) ? null : state.defaultTextModel,
                defaultImageModel: provider.capability === "image" && state.defaultImageModel?.providerId === providerId && !validIds.has(state.defaultImageModel.modelId) ? null : state.defaultImageModel,
                defaultVideoModel: provider.capability === "video" && state.defaultVideoModel?.providerId === providerId && !validIds.has(state.defaultVideoModel.modelId) ? null : state.defaultVideoModel,
                defaultSpeechModel: provider.capability === "speech" && state.defaultSpeechModel?.providerId === providerId && !validIds.has(state.defaultSpeechModel.modelId) ? null : state.defaultSpeechModel,
              }
            : {};
          return {
            providers: state.providers.map((item) => item.id === providerId ? { ...item, models: normalized } : item),
            ...clears,
          };
        });
      },

      toggleModel: (providerId, modelId) => {
        set((state) => {
          const provider = state.providers.find((item) => item.id === providerId);
          const nextProviders = state.providers.map((item) => item.id === providerId
            ? { ...item, models: item.models.map((model) => model.id === modelId ? { ...model, checked: !model.checked } : model) }
            : item);
          const stillChecked = nextProviders.find((item) => item.id === providerId)?.models.find((model) => model.id === modelId)?.checked === true;
          if (!provider || stillChecked) return { providers: nextProviders };
          return {
            providers: nextProviders,
            defaultTextModel: provider.capability === "text" && state.defaultTextModel?.providerId === providerId && state.defaultTextModel.modelId === modelId ? null : state.defaultTextModel,
            defaultImageModel: provider.capability === "image" && state.defaultImageModel?.providerId === providerId && state.defaultImageModel.modelId === modelId ? null : state.defaultImageModel,
            defaultVideoModel: provider.capability === "video" && state.defaultVideoModel?.providerId === providerId && state.defaultVideoModel.modelId === modelId ? null : state.defaultVideoModel,
            defaultSpeechModel: provider.capability === "speech" && state.defaultSpeechModel?.providerId === providerId && state.defaultSpeechModel.modelId === modelId ? null : state.defaultSpeechModel,
          };
        });
      },

      addManualModel: (providerId, modelId) => {
        const normalizedId = modelId.trim();
        if (!normalizedId || normalizedId.length > 512) return;
        set((state) => ({
          providers: state.providers.map((provider) => provider.id === providerId && !provider.models.some((model) => model.id === normalizedId)
            ? { ...provider, models: [...provider.models, { id: normalizedId, name: normalizedId, checked: true }] }
            : provider),
        }));
      },

      removeModel: (providerId, modelId) => {
        set((state) => {
          const provider = state.providers.find((item) => item.id === providerId);
          return {
            providers: state.providers.map((item) => item.id === providerId ? { ...item, models: item.models.filter((model) => model.id !== modelId) } : item),
            defaultTextModel: provider?.capability === "text" && state.defaultTextModel?.providerId === providerId && state.defaultTextModel.modelId === modelId ? null : state.defaultTextModel,
            defaultImageModel: provider?.capability === "image" && state.defaultImageModel?.providerId === providerId && state.defaultImageModel.modelId === modelId ? null : state.defaultImageModel,
            defaultVideoModel: provider?.capability === "video" && state.defaultVideoModel?.providerId === providerId && state.defaultVideoModel.modelId === modelId ? null : state.defaultVideoModel,
            defaultSpeechModel: provider?.capability === "speech" && state.defaultSpeechModel?.providerId === providerId && state.defaultSpeechModel.modelId === modelId ? null : state.defaultSpeechModel,
          };
        });
      },

      setDefaultTextModel: (ref) => set({ defaultTextModel: ref }),
      setDefaultImageModel: (ref) => set({ defaultImageModel: ref }),
      setDefaultVideoModel: (ref) => set({ defaultVideoModel: ref }),
      setDefaultSpeechModel: (ref) => set({ defaultSpeechModel: ref }),

      getModelConfig: () => {
        const state = get();
        return {
          text: resolveModel(state, state.defaultTextModel, "text"),
          image: resolveModel(state, state.defaultImageModel, "image"),
          video: resolveModel(state, state.defaultVideoModel, "video"),
          speech: resolveModel(state, state.defaultSpeechModel, "speech"),
        };
      },
    }),
    {
      name: "model-store",
      version: 4,
      migrate: (persistedState: unknown) => migrateModelStoreState(persistedState),
      partialize: (state) => ({
        providers: state.providers.map((provider) => ({
          ...provider,
          apiKey: "",
          secretKey: undefined,
        })),
        defaultTextModel: state.defaultTextModel,
        defaultImageModel: state.defaultImageModel,
        defaultVideoModel: state.defaultVideoModel,
        defaultSpeechModel: state.defaultSpeechModel,
      }),
      merge: (persistedState: unknown, currentState) => {
        const migrated = migrateModelStoreState(persistedState);
        if (typeof window !== "undefined") {
          purgeLegacyBrowserCredentials(window.localStorage, window.sessionStorage);
        }
        return { ...currentState, ...migrated };
      },
    },
  ),
);
