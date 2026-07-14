import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

type PackageContract = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const projectRoot = path.resolve(import.meta.dirname, "../../..");
const packageJson = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8"),
) as PackageContract;
const workerSource = readFileSync(path.join(projectRoot, "src/worker/index.ts"), "utf8");

function commandTokens(command: string): string[] {
  return command.match(/&&|"[^"]*"|'[^']*'|[^\s]+/g)?.map((token) =>
    token.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2"),
  ) ?? [];
}

function validateWorkerStartupContract(
  manifest: PackageContract,
  source = workerSource,
): string[] {
  const scripts = manifest.scripts ?? {};
  const devTokens = commandTokens(scripts["worker:dev"] ?? "");
  const buildTokens = commandTokens(scripts["worker:build"] ?? "");
  const productionTokens = commandTokens(scripts.worker ?? "");
  const errors: string[] = [];

  if (!("tsx" in (manifest.devDependencies ?? {}))) {
    errors.push("tsx must be a direct devDependency");
  }
  if (devTokens.includes("npx") || !devTokens.includes("tsx")) {
    errors.push("worker:dev must execute the direct tsx dependency");
  }

  const devPreflight = devTokens.indexOf("scripts/runtime-preflight.mjs");
  const tsx = devTokens.indexOf("tsx");
  const envFile = devTokens.indexOf("--env-file=.env");
  const entry = devTokens.indexOf("src/worker/index.ts");
  if (!(devPreflight >= 0 && devPreflight < tsx)) {
    errors.push("worker:dev must run runtime preflight before tsx");
  }
  if (!(tsx >= 0 && tsx < envFile && envFile < entry)) {
    errors.push("worker:dev must place --env-file=.env between tsx and the entrypoint");
  }

  const buildPreflight = buildTokens.indexOf("scripts/runtime-preflight.mjs");
  const esbuild = buildTokens.indexOf("esbuild");
  if (!(buildPreflight >= 0 && buildPreflight < esbuild)) {
    errors.push("worker:build must run runtime preflight before esbuild");
  }
  if (!buildTokens.includes("--target=node22")) {
    errors.push("worker:build must target the pinned Node 22 runtime");
  }

  if (
    productionTokens.some((token) => token.startsWith("--env-file"))
    || productionTokens.includes("dotenv")
    || /(?:from\s+["']dotenv["']|require\(["']dotenv["']\)|dotenv\/config)/.test(source)
  ) {
    errors.push("production worker must not load the development .env file");
  }
  return errors;
}

function mutate(
  update: (manifest: PackageContract) => void,
): PackageContract {
  const copy = structuredClone(packageJson);
  update(copy);
  return copy;
}

describe("worker startup command contract", () => {
  it("keeps development env loading explicit and production env-neutral", () => {
    expect(validateWorkerStartupContract(packageJson)).toEqual([]);
  });

  it.each([
    ["missing direct tsx", (manifest: PackageContract) => { delete manifest.devDependencies?.tsx; }, "direct devDependency"],
    ["npx fallback", (manifest: PackageContract) => { manifest.scripts!["worker:dev"] = "node scripts/runtime-preflight.mjs && npx tsx --env-file=.env src/worker/index.ts"; }, "direct tsx dependency"],
    ["env option after entrypoint", (manifest: PackageContract) => { manifest.scripts!["worker:dev"] = "node scripts/runtime-preflight.mjs && tsx src/worker/index.ts --env-file=.env"; }, "between tsx and the entrypoint"],
    ["missing build preflight", (manifest: PackageContract) => { manifest.scripts!["worker:build"] = "esbuild src/worker/index.ts --target=node22"; }, "build must run runtime preflight"],
    ["wrong worker build runtime", (manifest: PackageContract) => { manifest.scripts!["worker:build"] = manifest.scripts!["worker:build"].replace("node22", "node20"); }, "target the pinned Node 22"],
    ["production env loading", (manifest: PackageContract) => { manifest.scripts!.worker = "node --env-file=.env dist/worker/index.cjs"; }, "production worker must not load"],
  ] as const)("rejects %s", (_name, update, expectedError) => {
    expect(validateWorkerStartupContract(mutate(update))).toContainEqual(
      expect.stringContaining(expectedError),
    );
  });

  it("rejects application-side dotenv loading", () => {
    expect(
      validateWorkerStartupContract(packageJson, 'import "dotenv/config";\n' + workerSource),
    ).toContainEqual(expect.stringContaining("production worker must not load"));
  });
});
