import type { Capability, ModelRef, Provider } from "@/stores/model-store";

export interface LocalProfileOption {
  id: string;
  displayName: string;
  adapterKind: string;
}

export interface ModelPickerOption {
  stableId: string;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  source: "provider" | "profile";
}

function profileStableId(profileRevisionId: string): string {
  return `profile:${profileRevisionId}`;
}

function providerStableId(providerId: string, modelId: string): string {
  return `provider:${providerId}:model:${modelId}`;
}

/**
 * Merge browser-configured providers with server-managed profile revisions.
 *
 * Browser-stored ComfyUI entries are not executable provider models: the
 * server API accepts only current database profile revisions. Exclude those
 * legacy entries instead of presenting options that will deterministically fail.
 */
export function buildModelPickerOptions(
  providers: readonly Provider[],
  capability: Capability,
  localProfiles: readonly LocalProfileOption[],
): ModelPickerOption[] {
  const profilesById = new Map<string, LocalProfileOption>();
  for (const profile of localProfiles) {
    if (profile.adapterKind !== "comfyui") continue;
    const id = profile.id.trim();
    if (!id || profilesById.has(id)) continue;
    profilesById.set(id, { ...profile, id });
  }

  const result: ModelPickerOption[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    if (provider.capability !== capability) continue;
    if (provider.protocol === "comfyui") continue;
    for (const model of provider.models) {
      if (!model.checked) continue;
      const stableId = providerStableId(provider.id, model.id);
      if (seen.has(stableId)) continue;
      seen.add(stableId);
      result.push({
        stableId,
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        modelName: model.name,
        source: "provider",
      });
    }
  }

  for (const profile of profilesById.values()) {
    const stableId = profileStableId(profile.id);
    if (seen.has(stableId)) continue;
    seen.add(stableId);
    result.push({
      stableId,
      providerId: "local",
      providerName: "本地工作流",
      modelId: profile.id,
      modelName: profile.displayName,
      source: "profile",
    });
  }
  return result;
}

export function modelRefStableId(
  ref: ModelRef,
): string {
  if (ref.providerId === "local") return profileStableId(ref.modelId);
  return providerStableId(ref.providerId, ref.modelId);
}

export function isServerManagedModelRef(
  ref: ModelRef | null | undefined,
): boolean {
  if (!ref) return false;
  return ref.providerId === "local";
}

export function selectedProfileRevisionId(
  ref: ModelRef | null | undefined,
): string | null {
  if (!ref?.modelId || !isServerManagedModelRef(ref)) return null;
  return ref.modelId;
}
