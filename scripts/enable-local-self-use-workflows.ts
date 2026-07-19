/**
 * Activate exact imported workflow revisions for an explicitly configured
 * single-user machine. Local validation provenance is isolated from release
 * approval provenance and is ignored unless local self-use mode remains on.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { eq, inArray } from "drizzle-orm";
import { db, runMigrations } from "../src/lib/db";
import {
  executionBackends,
  generationProfileRevisions,
  generationProfileStates,
  workflowBackendValidations,
  workflowPackageRevisions,
  workflowPackageStates,
} from "../src/lib/db/schema";
import { verifyRequiredModelFiles, type VerifiedModelInventory } from "../src/lib/generation/model-file-inventory";
import {
  createComfyUITransport,
  probeBackendEnvironment,
  probeModelFolder,
} from "../src/lib/generation/transports";
import {
  assertWorkflowPromotionPolicy,
  localSelfUseModeEnabled,
  normalizeComfyWorkflow,
  parseWorkflowManifest,
  sha256Canonical,
  workflowValidationId,
} from "../src/lib/generation/workflows";
import { resolveBackendAuthHeaders } from "../src/lib/security";

const LOCAL_ACTOR = "local-self-use";
const DEFAULT_LOCAL_BACKEND_IDS = new Set([
  "comfy-visual-8000",
  "comfy-index-8001",
  "comfy-omni-8002",
]);
const ACTIVATABLE_WORKFLOW_STATES = new Set(["installed", "reviewed", "active"]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

type CandidateRow = {
  profile: typeof generationProfileRevisions.$inferSelect;
  profileState: typeof generationProfileStates.$inferSelect;
  workflow: typeof workflowPackageRevisions.$inferSelect;
  workflowState: typeof workflowPackageStates.$inferSelect;
};

export type PreparedLocalActivation = Map<string, {
  backend: typeof executionBackends.$inferSelect;
  features: Awaited<ReturnType<typeof probeBackendEnvironment>>["features"];
  rows: CandidateRow[];
  inventories: Map<string, VerifiedModelInventory>;
}>;

export function assertLoopbackBackendUrl(value: string): URL {
  const url = new URL(value);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (
    url.protocol !== "http:"
    || !loopbackHosts.has(url.hostname.toLowerCase())
    || !url.port
    || url.username
    || url.password
    || (url.pathname !== "/" && url.pathname !== "")
    || url.search
    || url.hash
  ) {
    throw new Error(`Local self-use mode only accepts a plain loopback HTTP backend: ${value}`);
  }
  return url;
}

function parseBoundedStringArray(
  raw: string | undefined,
  variableName: string,
  options: { optional: boolean; maxItems: number },
): Set<string> | null {
  if (!raw?.trim()) {
    if (options.optional) return null;
    throw new Error(`${variableName} is required`);
  }
  if (raw.length > 32_768) throw new Error(`${variableName} is too large`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${variableName} must be valid JSON`);
  }
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > options.maxItems
    || value.some((item) => typeof item !== "string" || !IDENTIFIER_PATTERN.test(item.trim()))
  ) {
    throw new Error(`${variableName} must be a bounded non-empty identifier array`);
  }
  const normalized = value.map((item) => item.trim());
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${variableName} cannot contain duplicates`);
  }
  return new Set(normalized);
}

export function parseRequestedProfileKeys(raw: string | undefined): Set<string> | null {
  return parseBoundedStringArray(raw, "AI_M_LOCAL_SELF_USE_PROFILE_KEYS_JSON", {
    optional: true,
    maxItems: 256,
  });
}

export function selectLatestProfileRevisions(
  rows: CandidateRow[],
  requestedKeys: Set<string> | null,
  allowedBackendIds: Set<string> = DEFAULT_LOCAL_BACKEND_IDS,
): CandidateRow[] {
  const eligibleKeys = new Set(rows.filter((row) => (
    row.profile.adapterKind === "comfyui"
    && Boolean(row.profile.executionBackendId)
    && allowedBackendIds.has(row.profile.executionBackendId!)
  )).map((row) => row.profile.profileKey));
  const candidates = rows.filter((row) => (
    eligibleKeys.has(row.profile.profileKey)
    && (requestedKeys ? requestedKeys.has(row.profile.profileKey) : true)
  ));
  const byKey = new Map<string, CandidateRow[]>();
  for (const row of candidates) {
    const revisions = byKey.get(row.profile.profileKey) ?? [];
    revisions.push(row);
    byKey.set(row.profile.profileKey, revisions);
  }
  const selected = [...byKey.entries()].map(([profileKey, revisions]) => {
    revisions.sort((left, right) => right.profile.revisionNo - left.profile.revisionNo);
    if (revisions.length > 1 && revisions[0].profile.revisionNo === revisions[1].profile.revisionNo) {
      throw new Error(`Profile key has ambiguous latest revisions: ${profileKey}`);
    }
    const latest = revisions[0];
    if (
      latest.profile.adapterKind !== "comfyui"
      || !latest.profile.executionBackendId
      || !allowedBackendIds.has(latest.profile.executionBackendId)
    ) {
      throw new Error(`Latest profile revision is not bound to an allowed local backend: ${profileKey}`);
    }
    if (!ACTIVATABLE_WORKFLOW_STATES.has(latest.workflowState.state)) {
      throw new Error(`Latest profile revision is not activatable: ${profileKey}`);
    }
    return latest;
  });
  if (requestedKeys) {
    const missing = [...requestedKeys].filter((key) => !byKey.has(key));
    if (missing.length) throw new Error(`Requested local profiles were not found: ${missing.join(", ")}`);
  }
  if (!selected.length) throw new Error("No imported local workflow profiles matched the request");
  return selected.sort((left, right) => left.profile.profileKey.localeCompare(right.profile.profileKey));
}

export function resolveModelsRootForBackend(backendId: string): string {
  const rawMap = process.env.AI_M_LOCAL_SELF_USE_MODELS_ROOTS_JSON?.trim();
  if (rawMap) {
    if (rawMap.length > 32_768) throw new Error("AI_M_LOCAL_SELF_USE_MODELS_ROOTS_JSON is too large");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMap);
    } catch {
      throw new Error("AI_M_LOCAL_SELF_USE_MODELS_ROOTS_JSON must be valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("AI_M_LOCAL_SELF_USE_MODELS_ROOTS_JSON must be an object");
    }
    const entries = Object.entries(parsed);
    if (entries.length > 32 || entries.some(([key, value]) => (
      !IDENTIFIER_PATTERN.test(key)
      || typeof value !== "string"
      || !value.trim()
      || value.length > 2_048
    ))) {
      throw new Error("AI_M_LOCAL_SELF_USE_MODELS_ROOTS_JSON contains an invalid entry");
    }
    const configured = (parsed as Record<string, string>)[backendId]?.trim();
    if (configured) return path.resolve(configured);
  }
  const shared = process.env.AI_M_MANAGED_COMFYUI_MODELS_ROOT?.trim()
    || (process.env.AI_M_MANAGED_COMFYUI_DATA_ROOT?.trim()
      ? path.resolve(process.env.AI_M_MANAGED_COMFYUI_DATA_ROOT, "models")
      : "");
  if (!shared) throw new Error(`Models root is required for backend ${backendId}`);
  return path.resolve(shared);
}

export function commitLocalActivation(
  prepared: PreparedLocalActivation,
  rows: CandidateRow[],
  now: number,
): void {
  db.transaction((tx) => {
    for (const group of prepared.values()) {
      const currentBackend = tx.select().from(executionBackends)
        .where(eq(executionBackends.id, group.backend.id)).get();
      if (!currentBackend || currentBackend.updatedAtMs !== group.backend.updatedAtMs) {
        throw new Error(`Backend changed during local activation: ${group.backend.id}`);
      }
      for (const row of group.rows) {
        const currentProfileState = tx.select().from(generationProfileStates)
          .where(eq(generationProfileStates.generationProfileRevisionId, row.profile.id)).get();
        const currentWorkflowState = tx.select().from(workflowPackageStates)
          .where(eq(workflowPackageStates.workflowPackageDigest, row.workflow.digest)).get();
        if (!currentProfileState || currentProfileState.updatedAtMs !== row.profileState.updatedAtMs) {
          throw new Error(`Profile changed during local activation: ${row.profile.profileKey}`);
        }
        if (!currentWorkflowState
          || currentWorkflowState.updatedAtMs !== row.workflowState.updatedAtMs
          || !ACTIVATABLE_WORKFLOW_STATES.has(currentWorkflowState.state)) {
          throw new Error(`Workflow changed during local activation: ${row.profile.profileKey}`);
        }
        for (const historical of rows.filter((candidate) => (
          candidate.profile.profileKey === row.profile.profileKey
          && candidate.profile.id !== row.profile.id
        ))) {
          const currentHistoricalState = tx.select().from(generationProfileStates)
            .where(eq(generationProfileStates.generationProfileRevisionId, historical.profile.id)).get();
          if (!currentHistoricalState
            || currentHistoricalState.updatedAtMs !== historical.profileState.updatedAtMs) {
            throw new Error(`Historical profile changed during local activation: ${row.profile.profileKey}`);
          }
        }
      }
    }

    for (const [backendId, group] of prepared) {
      tx.update(executionBackends).set({
        environmentFingerprint: group.features.environmentFingerprint,
        featureSnapshotJson: group.features as unknown as Record<string, unknown>,
        validatedAtMs: now,
        enabled: 1,
        updatedAtMs: now,
      }).where(eq(executionBackends.id, backendId)).run();

      for (const row of group.rows) {
        const pairDigest = sha256Canonical({
          workflowPackageDigest: row.workflow.digest,
          executionBackendId: backendId,
        });
        const inventory = group.inventories.get(row.workflow.digest)!;
        const report = {
          activationMode: LOCAL_ACTOR,
          backendId,
          profileKey: row.profile.profileKey,
          environmentFingerprint: group.features.environmentFingerprint,
          environmentLockDigest: row.workflow.environmentLockDigest,
          modelInventoryDigest: inventory.inventoryDigest,
          verifiedModels: inventory.models,
          activatedAtMs: now,
        };
        tx.insert(workflowBackendValidations).values({
          id: workflowValidationId("local-self-use", pairDigest),
          workflowPackageDigest: row.workflow.digest,
          executionBackendId: backendId,
          validationKind: "local-self-use",
          environmentFingerprint: group.features.environmentFingerprint,
          environmentLockDigest: row.workflow.environmentLockDigest,
          reviewerId: LOCAL_ACTOR,
          reportJson: report,
          validatedAtMs: now,
          updatedAtMs: now,
        }).onConflictDoUpdate({
          target: [
            workflowBackendValidations.workflowPackageDigest,
            workflowBackendValidations.executionBackendId,
            workflowBackendValidations.validationKind,
          ],
          set: {
            environmentFingerprint: group.features.environmentFingerprint,
            environmentLockDigest: row.workflow.environmentLockDigest,
            reviewerId: LOCAL_ACTOR,
            reportJson: report,
            validatedAtMs: now,
            updatedAtMs: now,
          },
        }).run();
        const historicalIds = rows.filter((candidate) => (
          candidate.profile.profileKey === row.profile.profileKey
          && candidate.profile.id !== row.profile.id
        )).map((candidate) => candidate.profile.id);
        if (historicalIds.length) {
          tx.update(generationProfileStates).set({
            enabled: 0,
            visibility: "admin",
            updatedAtMs: now,
          }).where(inArray(generationProfileStates.generationProfileRevisionId, historicalIds)).run();
        }
        tx.update(generationProfileStates).set({
          enabled: 1,
          visibility: "workspace",
          revokedAtMs: null,
          updatedAtMs: now,
        }).where(eq(generationProfileStates.generationProfileRevisionId, row.profile.id)).run();
      }
    }
  });
}

export async function enableLocalSelfUseWorkflows(): Promise<{
  backendIds: string[];
  profileKeys: string[];
}> {
  if (!localSelfUseModeEnabled()) {
    throw new Error(
      "Local self-use requires AI_M_LOCAL_SELF_USE=true, single-user identity mode, and a valid single-user id",
    );
  }
  runMigrations();
  const requestedKeys = parseRequestedProfileKeys(process.env.AI_M_LOCAL_SELF_USE_PROFILE_KEYS_JSON);
  const configuredBackends = parseBoundedStringArray(
    process.env.AI_M_LOCAL_SELF_USE_BACKEND_IDS_JSON,
    "AI_M_LOCAL_SELF_USE_BACKEND_IDS_JSON",
    { optional: true, maxItems: 32 },
  ) ?? DEFAULT_LOCAL_BACKEND_IDS;

  const rows = await db.select({
    profile: generationProfileRevisions,
    profileState: generationProfileStates,
    workflow: workflowPackageRevisions,
    workflowState: workflowPackageStates,
  })
    .from(generationProfileRevisions)
    .innerJoin(
      generationProfileStates,
      eq(generationProfileStates.generationProfileRevisionId, generationProfileRevisions.id),
    )
    .innerJoin(
      workflowPackageRevisions,
      eq(workflowPackageRevisions.digest, generationProfileRevisions.workflowPackageDigest),
    )
    .innerJoin(
      workflowPackageStates,
      eq(workflowPackageStates.workflowPackageDigest, workflowPackageRevisions.digest),
    );
  const selected = selectLatestProfileRevisions(rows, requestedKeys, configuredBackends);
  const allRevisions = await db.select({
    profileKey: generationProfileRevisions.profileKey,
    revisionNo: generationProfileRevisions.revisionNo,
  }).from(generationProfileRevisions);
  const globalLatestByKey = new Map<string, number>();
  for (const revision of allRevisions) {
    globalLatestByKey.set(
      revision.profileKey,
      Math.max(globalLatestByKey.get(revision.profileKey) ?? 0, revision.revisionNo),
    );
  }
  for (const row of selected) {
    if (globalLatestByKey.get(row.profile.profileKey) !== row.profile.revisionNo) {
      throw new Error(`Latest profile revision is not an importable local workflow: ${row.profile.profileKey}`);
    }
  }
  const backendIds = [...new Set(selected.map((row) => row.profile.executionBackendId!))].sort();
  const backends = await db.select().from(executionBackends);
  const backendById = new Map(backends.map((backend) => [backend.id, backend]));
  const prepared: PreparedLocalActivation = new Map();

  for (const backendId of backendIds) {
    const backend = backendById.get(backendId);
    if (!backend) throw new Error(`Execution backend not found: ${backendId}`);
    assertLoopbackBackendUrl(backend.baseUrl);
    if (backend.adapterKind !== "comfyui" || backend.topology !== "same-host") {
      throw new Error(`Local self-use backend must be same-host ComfyUI: ${backendId}`);
    }
    const headers = await resolveBackendAuthHeaders(backend.authType, backend.authConfigJson);
    const resolvedAddresses = Array.isArray(
      (backend.networkPolicyJson as { resolvedAddresses?: unknown }).resolvedAddresses,
    )
      ? (backend.networkPolicyJson as { resolvedAddresses: unknown[] }).resolvedAddresses
        .filter((value): value is string => typeof value === "string")
      : [];
    const transport = await createComfyUITransport(
      backend.baseUrl,
      backend.topology,
      headers,
      resolvedAddresses,
      { policyRevision: sha256Canonical(backend.networkPolicyJson) },
    );
    try {
      const environment = await probeBackendEnvironment(transport);
      const backendRows = selected.filter((row) => row.profile.executionBackendId === backendId);
      const modelFolders = new Map<string, string[]>();
      const inventories = new Map<string, VerifiedModelInventory>();
      for (const row of backendRows) {
        const workflow = normalizeComfyWorkflow(row.workflow.workflowApiJson);
        assertWorkflowPromotionPolicy(workflow);
        if (row.workflow.workflowSha256 !== sha256Canonical(workflow)) {
          throw new Error(`Workflow content digest mismatch: ${row.profile.profileKey}`);
        }
        const manifest = parseWorkflowManifest(row.workflow.manifestJson);
        if (manifest.capability !== row.profile.capability) {
          throw new Error(`Profile capability mismatch: ${row.profile.profileKey}`);
        }
        const missingNodes = manifest.requirements.nodeClasses.filter(
          (classType) => !environment.objectInfo[classType],
        );
        if (missingNodes.length) {
          throw new Error(
            `Backend ${backendId} is missing nodes for ${row.profile.profileKey}: ${missingNodes.join(", ")}`,
          );
        }
        for (const model of manifest.requirements.models) {
          if (!model.sha256 || !model.sizeBytes) {
            throw new Error(`Model identity is incomplete: ${row.profile.profileKey}`);
          }
          if (model.runtimeVisible === false) continue;
          const folder = model.runtimeFolder ?? model.folder;
          if (!modelFolders.has(folder)) {
            modelFolders.set(folder, await probeModelFolder(transport, folder));
          }
          const filename = model.filename.replace(/\\/g, "/");
          if (!modelFolders.get(folder)?.includes(filename)) {
            throw new Error(
              `Backend ${backendId} is missing model for ${row.profile.profileKey}: ${folder}/${filename}`,
            );
          }
        }
        if (!inventories.has(row.workflow.digest)) {
          inventories.set(row.workflow.digest, manifest.requirements.models.length
            ? await verifyRequiredModelFiles(
                resolveModelsRootForBackend(backendId),
                manifest.requirements.models,
              )
            : {
                schemaVersion: 1,
                models: [],
                inventoryDigest: sha256Canonical({ schemaVersion: 1, models: [] }),
              });
        }
      }
      prepared.set(backendId, { backend, features: environment.features, rows: backendRows, inventories });
    } finally {
      transport.close();
    }
  }

  commitLocalActivation(prepared, rows, Date.now());

  return {
    backendIds,
    profileKeys: selected.map((row) => row.profile.profileKey),
  };
}

async function main(): Promise<void> {
  const result = await enableLocalSelfUseWorkflows();
  console.log(JSON.stringify({ mode: LOCAL_ACTOR, ...result }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
