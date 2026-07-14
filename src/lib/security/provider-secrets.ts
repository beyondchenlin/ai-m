import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { keyReferences } from "@/lib/db/schema";
import { decryptSecret } from "./secrets";

interface LegacyProviderAuthConfig {
  keyRefId?: string;
  keyRefIds?: string[];
}

function normalizeKeyIds(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const config = raw as LegacyProviderAuthConfig;
  const candidates = [
    ...(typeof config.keyRefId === "string" ? [config.keyRefId] : []),
    ...(Array.isArray(config.keyRefIds) ? config.keyRefIds : []),
  ];
  const ids = [...new Set(candidates.map((value) => value.trim()).filter(Boolean))];
  if (ids.length > 8 || ids.some((value) => value.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(value))) {
    throw new Error("Backend key references are invalid");
  }
  return ids;
}

/**
 * Compatibility resolver for the pre-v2 cloud supplier facade.
 *
 * It deliberately accepts both the historic `keyRefIds` shape and the v2
 * single-reference shape, but always performs an exact bounded lookup and
 * authenticated decryption. ComfyUI execution must use resolveBackendAuthHeaders.
 */
export async function resolveLegacyProviderSecrets(raw: unknown): Promise<{ apiKey: string; secretKey?: string }> {
  const ids = normalizeKeyIds(raw);
  if (!ids.length) return { apiKey: "" };
  const refs = await db.select().from(keyReferences).where(inArray(keyReferences.id, ids));
  if (refs.length !== ids.length) throw new Error("One or more backend key references do not exist");
  const byId = new Map(refs.map((ref) => [ref.id, ref]));
  const ordered = ids.map((id) => byId.get(id)!);
  const bearer = ordered.find((ref) => ref.keyType === "bearer" || ref.keyType === "header-token");
  const secondary = ordered.find((ref) => ref.keyType === "basic");
  return {
    apiKey: bearer ? decryptSecret(bearer.secretValue) : "",
    ...(secondary ? { secretKey: decryptSecret(secondary.secretValue) } : {}),
  };
}
