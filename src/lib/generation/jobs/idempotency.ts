import type { CreateGenerationJobInput } from "@/lib/generation/contracts";
import { sha256Canonical } from "@/lib/generation/workflows";

export interface GenerationSourceReference {
  id: string;
  role: string;
}

/**
 * Bind one idempotency key to the complete semantic request, not merely text or
 * source bytes. Changing model/profile, target entity, or sources is a conflict.
 */
export function buildIdempotencyRequestDigest(
  input: CreateGenerationJobInput,
  sourceAssets: GenerationSourceReference[],
): string {
  return sha256Canonical({
    capability: input.capability,
    profileRevisionId: input.profileRevisionId,
    request: input.request,
    metadata: input.metadata ?? null,
    sourceAssets,
    businessContext: input.businessContext ?? null,
  });
}

/** Reconstruct the new digest for rows created before the digest column existed. */
export function legacySnapshotIdempotencyDigest(
  capability: string,
  snapshotValue: unknown,
): string | null {
  if (!snapshotValue || typeof snapshotValue !== "object" || Array.isArray(snapshotValue)) return null;
  const snapshot = snapshotValue as Record<string, unknown>;
  if (typeof snapshot.profileRevisionId !== "string"
    || !snapshot.request || typeof snapshot.request !== "object" || Array.isArray(snapshot.request)) return null;
  const sourceAssets = Array.isArray(snapshot.sourceAssets) ? snapshot.sourceAssets : [];
  const businessContext = snapshot.businessContext && typeof snapshot.businessContext === "object"
    && !Array.isArray(snapshot.businessContext) ? snapshot.businessContext : null;
  return sha256Canonical({
    capability,
    profileRevisionId: snapshot.profileRevisionId,
    request: snapshot.request,
    metadata: snapshot.metadata ?? null,
    sourceAssets,
    businessContext,
  });
}
