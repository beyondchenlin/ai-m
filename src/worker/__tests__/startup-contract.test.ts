import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { build } from "esbuild";
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
const readme = readFileSync(path.join(projectRoot, "README.md"), "utf8");
const pinnedNodeVersion = readFileSync(path.join(projectRoot, ".node-version"), "utf8").trim();

function commandSegments(command: string): string[][] {
  type CommandToken =
    | { kind: "argument"; value: string }
    | { kind: "and-operator" };
  const tokens: CommandToken[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;
  const flush = () => {
    if (tokenStarted) tokens.push({ kind: "argument", value: token });
    token = "";
    tokenStarted = false;
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = undefined;
      else if (character === "\\" && quote === '"' && index + 1 < command.length) {
        token += command[index += 1];
      } else token += character;
      tokenStarted = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
    } else if (character === "&" && command[index + 1] === "&") {
      flush();
      tokens.push({ kind: "and-operator" });
      index += 1;
    } else if (character === "&" || "|;<>()`".includes(character)
      || (character === "$" && ["(", "{"].includes(command[index + 1] ?? ""))) {
      return [];
    } else if (/\s/.test(character)) {
      flush();
    } else if (character === "\\" && index + 1 < command.length) {
      token += command[index += 1];
      tokenStarted = true;
    } else if (character === "^" && command[index + 1] === "&") {
      token += "&";
      tokenStarted = true;
      index += 1;
    } else if (character === "^") {
      return [];
    } else {
      token += character;
      tokenStarted = true;
    }
  }
  if (quote) return [];
  flush();
  const segments: string[][] = [[]];
  for (const item of tokens) {
    if (item.kind === "and-operator") segments.push([]);
    else segments.at(-1)!.push(item.value);
  }
  return segments.some((segment) => segment.length === 0) ? [] : segments;
}

function validateWorkerStartupContract(
  manifest: PackageContract,
): string[] {
  const scripts = manifest.scripts ?? {};
  const devSegments = commandSegments(scripts["worker:dev"] ?? "");
  const buildSegments = commandSegments(scripts["worker:build"] ?? "");
  const productionSegments = commandSegments(scripts.worker ?? "");
  const errors: string[] = [];

  if (!("tsx" in (manifest.devDependencies ?? {}))) {
    errors.push("tsx must be a direct devDependency");
  }
  if (devSegments.length !== 2) {
    errors.push("worker:dev must contain exactly a preflight and worker segment");
  }
  const [devPreflight = [], devWorker = []] = devSegments;
  if (devPreflight.length !== 2 || devPreflight[0] !== "node" || devPreflight[1] !== "scripts/runtime-preflight.mjs") {
    errors.push("worker:dev must use the runtime preflight command segment");
  }
  if (devWorker[0] !== "tsx") {
    errors.push("worker:dev must execute the direct tsx dependency");
  }
  if (devWorker[1] !== "--env-file=.env" || devWorker[2] !== "src/worker/index.ts" || devWorker.length !== 3) {
    errors.push("worker:dev must place --env-file=.env between tsx and the entrypoint");
  }

  const [buildPreflight = [], buildWorker = []] = buildSegments;
  if (buildSegments.length !== 2
    || buildPreflight.join("\0") !== ["node", "scripts/runtime-preflight.mjs"].join("\0")
    || buildWorker[0] !== "esbuild") {
    errors.push("worker:build must run runtime preflight before esbuild");
  }
  if (!buildWorker.includes("--target=node22")) {
    errors.push("worker:build must target the pinned Node 22 runtime");
  }

  if (productionSegments.length !== 1
    || productionSegments[0].join("\0") !== ["node", "dist/worker/index.cjs"].join("\0")) {
    errors.push("production worker must not load the development .env file");
  }
  return errors;
}

const forbiddenEnvLoader = /(?:^|\/)(?:dotenv(?:\/config)?|dotenv-flow|dotenv-expand|env-cmd|envfile|node-env-file)(?:\/|$)|^@dotenvx\/|^@next\/env$/i;

async function inspectProductionWorkerImports(entryPoint: string): Promise<string[]> {
  const result = await build({
    absWorkingDir: projectRoot,
    entryPoints: [entryPoint],
    bundle: true,
    format: "cjs",
    logLevel: "silent",
    metafile: true,
    packages: "external",
    platform: "node",
    target: "node22",
    write: false,
  });
  const reachableImports = Object.values(result.metafile?.inputs ?? {})
    .flatMap((input) => input.imports.map((item) => item.path.replaceAll("\\", "/")));
  const bundle = result.outputFiles.map((file) => file.text).join("\n");
  if (reachableImports.some((specifier) => forbiddenEnvLoader.test(specifier))
    || /(?:dotenv(?:\/config)?|dotenv-flow|dotenv-expand|env-cmd|node-env-file|@dotenvx\/|@next\/env|\.loadEnvFile\s*\()/i.test(bundle)) {
    return ["production worker must not load an env loader from any reachable dependency"];
  }
  return [];
}

function mutate(
  update: (manifest: PackageContract) => void,
): PackageContract {
  const copy = structuredClone(packageJson);
  update(copy);
  return copy;
}

describe("worker startup command contract", () => {
  it("establishes worker identity before startup and periodic artifact recovery", () => {
    const identity = workerSource.indexOf("const WORKER_ID =");
    const schemaReady = workerSource.indexOf("await waitForPlatformSchema()");
    const recoveryCall = "recoverStagingArtifacts({ recoveryOwner: WORKER_ID })";
    const startupRecovery = workerSource.indexOf(recoveryCall, schemaReady);
    expect(identity).toBeGreaterThanOrEqual(0);
    expect(schemaReady).toBeGreaterThan(identity);
    expect(startupRecovery).toBeGreaterThan(schemaReady);
    expect(workerSource.split(recoveryCall)).toHaveLength(3);
  });

  it.each([
    ['double-quoted operator', 'node "&&" tsx', [["node", "&&", "tsx"]]],
    ["single-quoted operator", "node '&&' tsx", [["node", "&&", "tsx"]]],
    ["backslash-escaped operator", "node \\&\\& tsx", [["node", "&&", "tsx"]]],
    ["Windows caret-escaped operator", "node ^&^& tsx", [["node", "&&", "tsx"]]],
    ['quoted embedded operator text', 'node "foo&&bar"', [["node", "foo&&bar"]]],
    ["unspaced real operator", "node preflight&&tsx worker", [["node", "preflight"], ["tsx", "worker"]]],
  ] as const)("parses %s without confusing literal arguments with operators", (_name, command, expected) => {
    expect(commandSegments(command)).toEqual(expected);
  });

  it.each(["node preflight || tsx worker", "node preflight ; tsx worker", "node preflight | tsx worker", "node preflight & tsx worker"])(
    "fails closed for unsupported shell syntax in %s",
    (command) => {
      expect(commandSegments(command)).toEqual([]);
    },
  );

  it("keeps development env loading explicit and production env-neutral", () => {
    expect(validateWorkerStartupContract(packageJson)).toEqual([]);
  });

  it.each([
    ["missing direct tsx", (manifest: PackageContract) => { delete manifest.devDependencies?.tsx; }, "direct devDependency"],
    ["npx fallback", (manifest: PackageContract) => { manifest.scripts!["worker:dev"] = "node scripts/runtime-preflight.mjs && npx tsx --env-file=.env src/worker/index.ts"; }, "direct tsx dependency"],
    ["node wrapper", (manifest: PackageContract) => { manifest.scripts!["worker:dev"] = "node scripts/runtime-preflight.mjs && node tsx --env-file=.env src/worker/index.ts"; }, "direct tsx dependency"],
    ["indirect package runner", (manifest: PackageContract) => { manifest.scripts!["worker:dev"] = "node scripts/runtime-preflight.mjs && pnpm exec tsx --env-file=.env src/worker/index.ts"; }, "direct tsx dependency"],
    ["tsx not at command head", (manifest: PackageContract) => { manifest.scripts!["worker:dev"] = "node scripts/runtime-preflight.mjs && echo tsx --env-file=.env src/worker/index.ts"; }, "direct tsx dependency"],
    ["env option after entrypoint", (manifest: PackageContract) => { manifest.scripts!["worker:dev"] = "node scripts/runtime-preflight.mjs && tsx src/worker/index.ts --env-file=.env"; }, "between tsx and the entrypoint"],
    ["extra command segment", (manifest: PackageContract) => { manifest.scripts!["worker:dev"] += " && echo done"; }, "exactly a preflight and worker segment"],
    ["no-op command segment", (manifest: PackageContract) => { manifest.scripts!["worker:dev"] = "node scripts/runtime-preflight.mjs && true && tsx --env-file=.env src/worker/index.ts"; }, "exactly a preflight and worker segment"],
    ["quoted operator bypass", (manifest: PackageContract) => { manifest.scripts!["worker:dev"] = 'node scripts/runtime-preflight.mjs "&&" tsx --env-file=.env src/worker/index.ts'; }, "exactly a preflight and worker segment"],
    ["single-quoted operator bypass", (manifest: PackageContract) => { manifest.scripts!["worker:dev"] = "node scripts/runtime-preflight.mjs '&&' tsx --env-file=.env src/worker/index.ts"; }, "exactly a preflight and worker segment"],
    ["escaped operator bypass", (manifest: PackageContract) => { manifest.scripts!["worker:dev"] = "node scripts/runtime-preflight.mjs \\&\\& tsx --env-file=.env src/worker/index.ts"; }, "exactly a preflight and worker segment"],
    ["missing build preflight", (manifest: PackageContract) => { manifest.scripts!["worker:build"] = "esbuild src/worker/index.ts --target=node22"; }, "build must run runtime preflight"],
    ["wrong worker build runtime", (manifest: PackageContract) => { manifest.scripts!["worker:build"] = manifest.scripts!["worker:build"].replace("node22", "node20"); }, "target the pinned Node 22"],
    ["production env loading", (manifest: PackageContract) => { manifest.scripts!.worker = "node --env-file=.env dist/worker/index.cjs"; }, "production worker must not load"],
  ] as const)("rejects %s", (_name, update, expectedError) => {
    expect(validateWorkerStartupContract(mutate(update))).toContainEqual(
      expect.stringContaining(expectedError),
    );
  });

  it("keeps the final production worker bundle free of env loaders", async () => {
    expect(
      await inspectProductionWorkerImports(path.join(projectRoot, "src/worker/index.ts")),
    ).toEqual([]);
  });

  it("rejects application-side dotenv loading", async () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "worker-direct-env-loader-"));
    try {
      const entry = path.join(fixture, "entry.ts");
      writeFileSync(entry, 'import "dotenv/config";\n');
      expect(await inspectProductionWorkerImports(entry)).toContainEqual(
        expect.stringContaining("production worker must not load"),
      );
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });

  it("rejects a transitively reachable dotenv/config import", async () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "worker-env-loader-"));
    try {
      const entry = path.join(fixture, "entry.ts");
      writeFileSync(entry, 'import "./helper";\n');
      writeFileSync(path.join(fixture, "helper.ts"), 'import "dotenv/config";\n');

      expect(await inspectProductionWorkerImports(entry)).toContainEqual(
        expect.stringContaining("production worker must not load"),
      );
    } finally {
      rmSync(fixture, { force: true, recursive: true });
    }
  });

  it("documents the pinned runtime and package worker commands together", () => {
    expect(pinnedNodeVersion).toBe("22.16.0");
    expect(readme).toContain(`Node.js ${pinnedNodeVersion}`);
    const workerSection = readme.match(/### Worker[\s\S]*?```bash\s*([\s\S]*?)```/)?.[1]
      .trim()
      .split(/\r?\n/);
    expect(workerSection).toEqual([
      "corepack pnpm worker:dev",
      "corepack pnpm worker:build",
      "corepack pnpm worker",
    ]);
    expect(workerSource).toContain("corepack pnpm worker:dev");
    expect(workerSource).toContain("corepack pnpm worker");
    expect(workerSource).toContain("dist/worker/index.cjs");
  });
});
