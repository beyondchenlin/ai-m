import { verifyPixelleTrustStore } from "./pixelle-trust-store";

async function main(): Promise<void> {
  console.log(JSON.stringify(await verifyPixelleTrustStore(), null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
