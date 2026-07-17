import { provisionPixelleTrustStore } from "./pixelle-trust-store";

async function main(): Promise<void> {
  await provisionPixelleTrustStore();
  console.log("Pixelle production trust store is present and verified at the fixed local path");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
