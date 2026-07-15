import { provisionPixelleTrustStore } from "./pixelle-trust-store";

async function main(): Promise<void> {
  await provisionPixelleTrustStore();
  console.log("Pixelle production trust store provisioned and verified at the fixed local path");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
