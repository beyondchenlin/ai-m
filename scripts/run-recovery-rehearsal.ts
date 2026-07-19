import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRecoveryBundle, restoreRecoveryBundle } from "./recovery-bundle";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function databasePath(): string {
  const value = required("DATABASE_URL");
  if (!value.startsWith("file:")) throw new Error("Recovery rehearsal supports only a local file: SQLite database");
  return path.resolve(value.slice("file:".length));
}

export async function main(): Promise<void> {
  if (process.env.AI_M_BACKUP_MAINTENANCE_CONFIRM !== "WRITERS-STOPPED") {
    throw new Error("Set AI_M_BACKUP_MAINTENANCE_CONFIRM=WRITERS-STOPPED only after all application and worker writers are stopped");
  }
  const bundle = path.resolve(required("AI_M_RECOVERY_BUNDLE_PATH"));
  const destination = path.resolve(required("AI_M_RECOVERY_REHEARSAL_ROOT"));
  const startedAtMs = Date.now();
  const manifest = await createRecoveryBundle({
    databasePath: databasePath(),
    components: [
      { name: "uploads", sourcePath: required("UPLOAD_DIR") },
      { name: "workflow-supply-chain", sourcePath: required("AI_M_WORKFLOW_SUPPLY_CHAIN_ROOT") },
      { name: "pixelle-generation", sourcePath: required("PIXELLE_WORKFLOW_STAGING_DIR") },
      {
        name: "trust-metadata",
        sourcePath: process.env.AI_M_PIXELLE_TRUST_ROOT?.trim() || path.join(os.homedir(), ".ai-m", "trust"),
        includeFiles: [
          "pixelle-task4-ed25519-public.pem",
          "pixelle-trust-metadata.json",
        ],
      },
    ],
    destination: bundle,
    nowMs: startedAtMs,
  });
  const restored = await restoreRecoveryBundle({ bundle, destination });
  console.log(JSON.stringify({
    status: "RESTORE_REHEARSAL_PASSED",
    bundle,
    destination,
    contentDigest: manifest.contentDigest,
    fileCount: manifest.files.length,
    byteCount: manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0),
    recoveryPointAtMs: manifest.createdAtMs,
    recoveryPointAgeMs: restored.restoredAtMs - manifest.createdAtMs,
    restoreDurationMs: restored.durationMs,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
