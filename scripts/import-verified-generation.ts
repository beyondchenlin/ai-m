/** Strict Pixelle generation importer. Task 4 signed evidence is mandatory. */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { generationProfileRevisions, generationProfileStates } from "@/lib/db/schema";
import { id as genId } from "@/lib/id";
import {
  authenticatedOperatorActorId,
  resolveAuthenticatedLocalOperator,
} from "@/lib/security/authenticated-local-operator";
import { canonicalize, compileWorkflowBindings, importWorkflowPackage, normalizeComfyWorkflow, parseCompiledBindings, parseWorkflowManifest, parseWorkflowPackageLock, sha256Canonical } from "@/lib/generation/workflows";
import { readTask4EvidenceFile, verifyGenerationPackageForImport } from "./verify-generation-package";
import { protectPublishedWorkflowTree } from "./workflow-package-storage";

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
}
function parseJsonBytes(bytes: Buffer, name: string): unknown {
  try { return JSON.parse(bytes.toString("utf8")) as unknown; } catch { throw new Error(`${name} is invalid JSON`); }
}
function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function main(): Promise<void> {
  const generationRoot = process.env.WORKFLOW_GENERATION_ROOT?.trim();
  const packageName = process.env.WORKFLOW_PACKAGE_NAME?.trim();
  const expectedGenerationDigest = process.env.EXPECTED_GENERATION_DIGEST?.trim();
  const expectedPackageDigest = process.env.EXPECTED_PACKAGE_DIGEST?.trim();
  if (!generationRoot || !packageName || !expectedGenerationDigest || !expectedPackageDigest) {
    throw new Error("WORKFLOW_GENERATION_ROOT, WORKFLOW_PACKAGE_NAME, EXPECTED_GENERATION_DIGEST and EXPECTED_PACKAGE_DIGEST are required");
  }
  const evidenceFile = process.env.TASK4_VERIFIED_EVIDENCE_FILE?.trim();
  if (!evidenceFile) throw new Error("TASK4_VERIFIED_EVIDENCE_FILE is required for every verified generation import");
  const verified = await verifyGenerationPackageForImport({
    generationRoot, packageName, expectedGenerationDigest, expectedPackageDigest,
    verifiedEvidence: await readTask4EvidenceFile(path.resolve(evidenceFile)),
  });
  const manifestRaw = parseJsonBytes(verified.files["manifest.json"], "manifest.json");
  const manifest = parseWorkflowManifest(manifestRaw);
  const packageLockRaw = parseJsonBytes(verified.files["package.lock.json"], "package.lock.json");
  const packageLock = parseWorkflowPackageLock(packageLockRaw, manifest);
  const verifiedFileDigests: Record<string, string> = {};
  for (const relativeName of Object.keys(packageLock.files)) {
    const bytes = verified.files[relativeName as keyof typeof verified.files];
    if (!bytes) throw new Error(`Package lock names an unavailable file: ${relativeName}`);
    verifiedFileDigests[relativeName] = sha256Bytes(bytes);
  }
  const workflowApi = parseJsonBytes(verified.files["workflow.api.json"], "workflow.api.json");
  const compiledRaw = parseCompiledBindings(parseJsonBytes(verified.files["compiled-bindings.json"], "compiled-bindings.json"));
  const recomputedCompiled = compileWorkflowBindings(normalizeComfyWorkflow(workflowApi), manifest);
  if (canonicalize(compiledRaw) !== canonicalize(recomputedCompiled)) throw new Error("compiled-bindings.json does not match the workflow and manifest contract");
  await protectPublishedWorkflowTree(verified.packageDir);
  const actorId = authenticatedOperatorActorId(await resolveAuthenticatedLocalOperator());
  const imported = await importWorkflowPackage({
    workflowApi, manifest, packageLock, verifiedFileDigests, packagePath: verified.packageDir,
    generationProvenance: {
      generationDigest: verified.generationDigest, packageName: verified.packageName,
      packageDigest: verified.packageDigest, verifiedEvidenceDigest: verified.verifiedEvidenceDigest!,
      verifiedEvidenceExpiresAtMs: verified.verifiedEvidenceExpiresAtMs!,
    },
  }, actorId);
  console.log(JSON.stringify({ workflowDigest: imported.digest, state: imported.state, generationDigest: verified.generationDigest, packageDigest: verified.packageDigest }, null, 2));

  const profileKey = process.env.PROFILE_KEY?.trim();
  if (!profileKey) return;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(profileKey)) throw new Error("PROFILE_KEY is invalid");
  const backendId = process.env.EXECUTION_BACKEND_ID?.trim();
  if (!backendId) throw new Error("EXECUTION_BACKEND_ID is required when PROFILE_KEY is set");
  const configFile = process.env.PROFILE_CONFIG_FILE?.trim();
  const configJson = configFile ? await readJson(path.resolve(configFile)) : { defaultParameters: {} };
  if (!configJson || typeof configJson !== "object" || Array.isArray(configJson)) throw new Error("Profile config must be an object");
  const displayName = process.env.PROFILE_DISPLAY_NAME?.trim() || manifest.displayName;
  const profile = db.transaction((tx) => {
    const revisions = tx.select().from(generationProfileRevisions)
      .where(eq(generationProfileRevisions.profileKey, profileKey))
      .orderBy(desc(generationProfileRevisions.revisionNo)).all();
    const existing = revisions.find((revision) =>
      revision.executionBackendId === backendId
      && revision.workflowPackageDigest === imported.digest
      && revision.adapterKind === "comfyui"
      && revision.capability === manifest.capability
      && revision.displayName === displayName
      && sha256Canonical(revision.configJson) === sha256Canonical(configJson));
    if (existing) {
      tx.insert(generationProfileStates).values({
        generationProfileRevisionId: existing.id,
        enabled: 0,
        visibility: "admin",
        updatedAtMs: Date.now(),
      }).onConflictDoNothing().run();
      return { id: existing.id, revisionNo: existing.revisionNo, reused: true };
    }
    const revisionNo = (revisions[0]?.revisionNo ?? 0) + 1;
    const id = genId();
    const now = Date.now();
    const revisionDigest = sha256Canonical({ profileKey, revisionNo, backendId, workflowDigest: imported.digest, configJson });
    tx.insert(generationProfileRevisions).values({
      id, profileKey, revisionNo, revisionDigest, displayName,
      capability: manifest.capability, adapterKind: "comfyui", executionBackendId: backendId,
      workflowPackageDigest: imported.digest, configJson: configJson as Record<string, unknown>, createdBy: actorId, createdAtMs: now,
    }).run();
    tx.insert(generationProfileStates).values({
      generationProfileRevisionId: id, enabled: 0, visibility: "admin", updatedAtMs: now,
    }).run();
    return { id, revisionNo, reused: false };
  });
  console.log(JSON.stringify({
    profileRevisionId: profile.id,
    profileKey,
    revisionNo: profile.revisionNo,
    state: "disabled",
    reused: profile.reused,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
