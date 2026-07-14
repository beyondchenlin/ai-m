import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");
const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8").replace(/\r\n/g, "\n");
const readme = readFileSync(path.join(root, "README.md"), "utf8").replace(/\r\n/g, "\n");
const builderStart = dockerfile.indexOf("FROM deps AS builder");
const runnerStart = dockerfile.indexOf("FROM base AS runner");
const builderStage = dockerfile.slice(builderStart, runnerStart);
const runnerStage = dockerfile.slice(runnerStart);

describe("Docker build metadata contract", () => {
  it("declares only the two optional metadata args in the builder before the Next build", () => {
    const commitArg = builderStage.indexOf("ARG AI_M_BUILD_COMMIT");
    const timeArg = builderStage.indexOf("ARG AI_M_BUILD_TIME");
    const build = builderStage.indexOf("RUN pnpm worker:build && pnpm build");

    expect(builderStart).toBeGreaterThanOrEqual(0);
    expect(runnerStart).toBeGreaterThan(builderStart);
    expect(commitArg).toBeGreaterThanOrEqual(0);
    expect(timeArg).toBeGreaterThanOrEqual(0);
    expect(commitArg).toBeLessThan(build);
    expect(timeArg).toBeLessThan(build);
    expect(dockerfile.match(/^ARG AI_M_BUILD_(?:COMMIT|TIME)$/gm)).toEqual([
      "ARG AI_M_BUILD_COMMIT",
      "ARG AI_M_BUILD_TIME",
    ]);
  });

  it("does not expose build metadata args or env fields in the final runtime stage", () => {
    expect(runnerStage).not.toMatch(/^\s*(?:ARG|ENV)\s+AI_M_BUILD_(?:COMMIT|TIME)\b/m);
    expect(runnerStage).not.toMatch(/AI_M_INTERNAL_EMBEDDED_(?:VERSION|COMMIT|BUILD_TIME)/);
  });

  it("keeps no-arg Docker builds valid and documents explicit reproducible inputs", () => {
    expect(builderStage).toMatch(/^ARG AI_M_BUILD_COMMIT$/m);
    expect(builderStage).toMatch(/^ARG AI_M_BUILD_TIME$/m);
    expect(readme).toContain("docker build -t ai-comic-builder .");
    expect(readme).toContain("--build-arg AI_M_BUILD_COMMIT=<7-to-64-hex-commit>");
    expect(readme).toContain("--build-arg AI_M_BUILD_TIME=2026-01-01T00:00:00.000Z");
    expect(readme).toContain("同一源码重建时复用相同的 UTC 构建时间");
    expect(readme).toContain("不要使用构建机器的当前时间");
  });
});
