/** Import a real, immutable ComfyUI workflow package. No fake nodes are generated. */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { generationProfileRevisions, generationProfileStates } from "@/lib/db/schema";
import { id as genId } from "@/lib/id";
import { canonicalize, compileWorkflowBindings, importWorkflowPackage, normalizeComfyWorkflow, parseCompiledBindings, parseWorkflowManifest, parseWorkflowPackageLock, sha256 } from "@/lib/generation/workflows";
import { verifyGenerationPackageForImport } from "./verify-generation-package";

async function readJson(file: string): Promise<unknown> {
  const text = await fs.readFile(file, "utf8");
  return JSON.parse(text) as unknown;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJsonBytes(bytes: Buffer, name: string): unknown {
  try { return JSON.parse(bytes.toString("utf8")) as unknown; } catch { throw new Error(`${name} is invalid JSON`); }
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
  const verifiedEvidence = evidenceFile ? await readJson(path.resolve(evidenceFile)) : undefined;
  const verified = await verifyGenerationPackageForImport({
    generationRoot, packageName, expectedGenerationDigest, expectedPackageDigest, verifiedEvidence,
    requireVerifiedEvidence: process.env.REQUIRE_TASK4_VERIFIED_EVIDENCE === "true",
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
  const actorId = process.env.WORKFLOW_IMPORTER_ID?.trim() || "local-admin";
  const imported = await importWorkflowPackage({
    workflowApi,
    manifest,
    packageLock,
    verifiedFileDigests,
    packagePath: verified.packageDir,
    generationProvenance: {
      generationDigest: verified.generationDigest,
      packageName: verified.packageName,
      packageDigest: verified.packageDigest,
      ...(verified.verifiedEvidenceDigest ? { verifiedEvidenceDigest: verified.verifiedEvidenceDigest } : {}),
    },
  }, actorId);
  console.log(JSON.stringify({
    workflowDigest: imported.digest, state: imported.state,
    generationDigest: verified.generationDigest, packageDigest: verified.packageDigest,
  }, null, 2));

  const profileKey = process.env.PROFILE_KEY?.trim();
  if (!profileKey) return;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(profileKey)) throw new Error("PROFILE_KEY is invalid");
  const backendId = process.env.EXECUTION_BACKEND_ID?.trim();
  if (!backendId) throw new Error("EXECUTION_BACKEND_ID is required when PROFILE_KEY is set");
  const [latest] = await db.select({ revisionNo: generationProfileRevisions.revisionNo })
    .from(generationProfileRevisions).where(eq(generationProfileRevisions.profileKey, profileKey))
    .orderBy(desc(generationProfileRevisions.revisionNo)).limit(1);
  const revisionNo = (latest?.revisionNo ?? 0) + 1;
  const configFile = process.env.PROFILE_CONFIG_FILE?.trim();
  const configJson = configFile ? await readJson(path.resolve(configFile)) : { defaultParameters: {} };
  if (!configJson || typeof configJson !== "object" || Array.isArray(configJson)) throw new Error("Profile config must be an object");
  const id = genId();
  const now = Date.now();
  const revisionDigest = sha256(canonicalize({ profileKey, revisionNo, backendId, workflowDigest: imported.digest, configJson }));
  await db.transaction(async (tx) => {
    await tx.insert(generationProfileRevisions).values({
      id, profileKey, revisionNo, revisionDigest,
      displayName: process.env.PROFILE_DISPLAY_NAME?.trim() || manifest.displayName,
      capability: manifest.capability,
      adapterKind: "comfyui",
      executionBackendId: backendId,
      workflowPackageDigest: imported.digest,
      configJson: configJson as Record<string, unknown>,
      createdBy: actorId,
      createdAtMs: now,
    });
    await tx.insert(generationProfileStates).values({
      generationProfileRevisionId: id, enabled: 0, visibility: "admin", updatedAtMs: now,
    });
  });
  console.log(JSON.stringify({ profileRevisionId: id, profileKey, revisionNo, state: "disabled" }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
