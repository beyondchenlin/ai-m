/** Import a real, immutable ComfyUI workflow package. No fake nodes are generated. */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { generationProfileRevisions, generationProfileStates } from "@/lib/db/schema";
import { id as genId } from "@/lib/id";
import { importWorkflowPackage, parseWorkflowManifest, parseWorkflowPackageLock, sha256Canonical } from "@/lib/generation/workflows";
import {
  authenticatedOperatorActorId,
  resolveAuthenticatedLocalOperator,
} from "@/lib/security/authenticated-local-operator";
import {
  discardStagedWorkflowPackage,
  publishStagedWorkflowPackage,
  stageWorkflowPackage,
} from "./workflow-package-storage";

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
}
function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function resolveLockedFile(packageDir: string, relativeName: string): string {
  const resolved = path.resolve(packageDir, relativeName);
  if (resolved !== packageDir && !resolved.startsWith(`${packageDir}${path.sep}`)) throw new Error(`Locked file escapes package directory: ${relativeName}`);
  return resolved;
}

async function main(): Promise<void> {
  const sourcePackageDir = path.resolve(process.env.WORKFLOW_PACKAGE_DIR ?? process.argv[2] ?? "");
  if (!process.env.WORKFLOW_PACKAGE_DIR && !process.argv[2]) throw new Error("WORKFLOW_PACKAGE_DIR or a package directory argument is required");
  const supplyChainRoot = path.resolve(
    process.env.AI_M_WORKFLOW_SUPPLY_CHAIN_ROOT ?? "./data/workflow-supply-chain",
  );
  const staged = await stageWorkflowPackage(sourcePackageDir, supplyChainRoot);
  let published = false;
  const packageDir = staged.stagingDirectory;
  try {
  const manifestRaw = await readJson(path.join(packageDir, "manifest.json"));
  const manifest = parseWorkflowManifest(manifestRaw);
  const packageNames = await fs.readdir(packageDir);
  const generationRoot = path.dirname(packageDir);
  const pixelleGenerationLayout = packageNames.includes("compiled-bindings.json")
    && path.basename(path.dirname(generationRoot)) === "generations"
    && await fs.lstat(path.join(generationRoot, "generation.json")).then((stat) => stat.isFile() && !stat.isSymbolicLink(), () => false);
  if (manifest.workflowId.toLowerCase().startsWith("pixelle.")
    || pixelleGenerationLayout) {
    throw new Error("Pixelle generation packages require the strict workflow:import:verified-generation entry point");
  }
  const packageLockRaw = await readJson(path.join(packageDir, "package.lock.json"));
  const packageLock = parseWorkflowPackageLock(packageLockRaw, manifest);
  const actualPackageFiles = staged.files.map((file) => file.relativePath).sort();
  const expectedPackageFiles = [...Object.keys(packageLock.files), "package.lock.json"].sort();
  if (JSON.stringify(actualPackageFiles) !== JSON.stringify(expectedPackageFiles)) {
    throw new Error("Quarantined workflow package contains unlocked or missing files");
  }
  const verifiedFileDigests: Record<string, string> = {};
  for (const relativeName of Object.keys(packageLock.files)) {
    verifiedFileDigests[relativeName] = sha256Bytes(await fs.readFile(resolveLockedFile(packageDir, relativeName)));
  }
  const workflowApi = await readJson(path.join(packageDir, manifest.workflowFile));
  const publishedDirectory = await publishStagedWorkflowPackage(packageDir, supplyChainRoot);
  published = true;
  const actorId = authenticatedOperatorActorId(await resolveAuthenticatedLocalOperator());
  const imported = await importWorkflowPackage({
    workflowApi,
    manifest,
    packageLock,
    verifiedFileDigests,
    packagePath: publishedDirectory,
  }, actorId);
  console.log(JSON.stringify({ workflowDigest: imported.digest, state: imported.state }, null, 2));
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
      capability: manifest.capability, adapterKind: "comfyui", executionBackendId: backendId, workflowPackageDigest: imported.digest,
      configJson: configJson as Record<string, unknown>, createdBy: actorId, createdAtMs: now,
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
  } catch (error) {
    if (!published) await discardStagedWorkflowPackage(packageDir, supplyChainRoot);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
