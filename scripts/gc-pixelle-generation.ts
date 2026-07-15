import path from "node:path";
import { pathToFileURL } from "node:url";
import { garbageCollectPixelleGeneration } from "./prepare-pixelle-single-backend";

export async function main(): Promise<void> {
  const result = await garbageCollectPixelleGeneration({
    stagingDir: process.env.PIXELLE_WORKFLOW_STAGING_DIR ?? "",
    generationDigest: process.env.GC_GENERATION_DIGEST ?? "",
    confirmGenerationDigest: process.env.CONFIRM_GC_GENERATION_DIGEST ?? "",
    actor: process.env.GC_ACTOR_ID ?? "",
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
