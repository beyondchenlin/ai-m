import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyPixelleGcAuditChain } from "./pixelle-gc-audit";

export async function main(): Promise<void> {
  const stagingDir = process.env.PIXELLE_WORKFLOW_STAGING_DIR?.trim();
  if (!stagingDir) throw new Error("PIXELLE_WORKFLOW_STAGING_DIR is required");
  console.log(JSON.stringify(await verifyPixelleGcAuditChain({ stagingDir }), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
