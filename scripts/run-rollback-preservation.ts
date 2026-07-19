import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  captureRollbackPreservation,
  verifyRollbackPreservation,
} from "./rollback-preservation";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function databasePath(): string {
  const value = required("DATABASE_URL");
  if (!value.startsWith("file:")) throw new Error("Rollback rehearsal supports only local file: SQLite");
  return path.resolve(value.slice("file:".length));
}

export async function main(): Promise<void> {
  if (process.env.AI_M_ROLLBACK_MAINTENANCE_CONFIRM !== "WRITERS-STOPPED") {
    throw new Error("AI_M_ROLLBACK_MAINTENANCE_CONFIRM=WRITERS-STOPPED is required");
  }
  const mode = required("AI_M_ROLLBACK_REHEARSAL_MODE");
  const common = {
    databasePath: databasePath(),
    artifactRoot: path.resolve(required("AI_M_ROLLBACK_ARTIFACT_ROOT")),
    manifestPath: path.resolve(required("AI_M_ROLLBACK_MANIFEST_PATH")),
  };
  if (mode === "capture") {
    const manifest = await captureRollbackPreservation({
      ...common,
      candidateSha: required("AI_M_BUILD_COMMIT"),
    });
    console.log(JSON.stringify({
      status: "ROLLBACK_BASELINE_CAPTURED",
      candidateSha: manifest.candidateSha,
      protectedTableCount: Object.keys(manifest.tables).length,
      protectedArtifactCount: manifest.artifactFiles.length,
      contentDigest: manifest.contentDigest,
    }, null, 2));
    return;
  }
  if (mode === "verify") {
    console.log(JSON.stringify(await verifyRollbackPreservation(common), null, 2));
    return;
  }
  throw new Error("AI_M_ROLLBACK_REHEARSAL_MODE must be capture or verify");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
