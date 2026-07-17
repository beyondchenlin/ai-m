/** Import a real, immutable ComfyUI workflow package. No fake nodes are generated. */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { generationProfileRevisions, generationProfileStates } from "@/lib/db/schema";
import { id as genId } from "@/lib/id";
import { canonicalize, importWorkflowPackage, parseWorkflowManifest, parseWorkflowPackageLock, sha256 } from "@/lib/generation/workflows";

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
  const packageDir = path.resolve(process.env.WORKFLOW_PACKAGE_DIR ?? process.argv[2] ?? "");
  if (!process.env.WORKFLOW_PACKAGE_DIR && !process.argv[2]) throw new Error("WORKFLOW_PACKAGE_DIR or a package directory argument is required");
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
  const verifiedFileDigests: Record<string, string> = {};
  for (const relativeName of Object.keys(packageLock.files)) {
    verifiedFileDigests[relativeName] = sha256Bytes(await fs.readFile(resolveLockedFile(packageDir, relativeName)));
  }
  const workflowApi = await readJson(path.join(packageDir, manifest.workflowFile));
  const actorId = process.env.WORKFLOW_IMPORTER_ID?.trim() || "local-admin";
  const imported = await importWorkflowPackage({ workflowApi, manifest, packageLock, verifiedFileDigests, packagePath: packageDir }, actorId);
  console.log(JSON.stringify({ workflowDigest: imported.digest, state: imported.state }, null, 2));
  const profileKey = process.env.PROFILE_KEY?.trim();
  if (!profileKey) return;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(profileKey)) throw new Error("PROFILE_KEY is invalid");
  const backendId = process.env.EXECUTION_BACKEND_ID?.trim();
  if (!backendId) throw new Error("EXECUTION_BACKEND_ID is required when PROFILE_KEY is set");
  const [latest] = await db.select({ revisionNo: generationProfileRevisions.revisionNo }).from(generationProfileRevisions)
    .where(eq(generationProfileRevisions.profileKey, profileKey)).orderBy(desc(generationProfileRevisions.revisionNo)).limit(1);
  const revisionNo = (latest?.revisionNo ?? 0) + 1;
  const configFile = process.env.PROFILE_CONFIG_FILE?.trim();
  const configJson = configFile ? await readJson(path.resolve(configFile)) : { defaultParameters: {} };
  if (!configJson || typeof configJson !== "object" || Array.isArray(configJson)) throw new Error("Profile config must be an object");
  const id = genId();
  const now = Date.now();
  const revisionDigest = sha256(canonicalize({ profileKey, revisionNo, backendId, workflowDigest: imported.digest, configJson }));
  await db.transaction(async (tx) => {
    await tx.insert(generationProfileRevisions).values({
      id, profileKey, revisionNo, revisionDigest, displayName: process.env.PROFILE_DISPLAY_NAME?.trim() || manifest.displayName,
      capability: manifest.capability, adapterKind: "comfyui", executionBackendId: backendId, workflowPackageDigest: imported.digest,
      configJson: configJson as Record<string, unknown>, createdBy: actorId, createdAtMs: now,
    });
    await tx.insert(generationProfileStates).values({ generationProfileRevisionId: id, enabled: 0, visibility: "admin", updatedAtMs: now });
  });
  console.log(JSON.stringify({ profileRevisionId: id, profileKey, revisionNo, state: "disabled" }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
