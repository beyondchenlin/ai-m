import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

type EmbeddedConfig = Readonly<Record<string, string>>;

const root = path.resolve(__dirname, "../../..");
const inspectConfig = String.raw`
  const loaded = await import('./next.config.ts?test=' + Math.random());
  const config = loaded.default?.default ?? loaded.default;
  process.stdout.write(JSON.stringify(config.env));
`;

function loadConfig(overrides: NodeJS.ProcessEnv = {}): EmbeddedConfig {
  const output = execFileSync(process.execPath, [
    "--import", "tsx",
    "--input-type=module",
    "--eval", inspectConfig,
  ], {
    cwd: root,
    env: {
      ...process.env,
      AI_M_BUILD_COMMIT: "",
      AI_M_BUILD_TIME: "",
      AI_M_INTERNAL_EMBEDDED_VERSION: "",
      AI_M_INTERNAL_EMBEDDED_COMMIT: "",
      AI_M_INTERNAL_EMBEDDED_BUILD_TIME: "",
      ...overrides,
    },
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  return JSON.parse(output) as EmbeddedConfig;
}

describe("Next build metadata boundary", () => {
  it("embeds exactly three validated fields from package version and build inputs", () => {
    const embedded = loadConfig({
      AI_M_BUILD_COMMIT: "ABCDEF0123456789",
      AI_M_BUILD_TIME: "2026-07-14T12:34:56.000Z",
    });

    expect(embedded).toEqual({
      AI_M_INTERNAL_EMBEDDED_VERSION: "0.1.0",
      AI_M_INTERNAL_EMBEDDED_COMMIT: "abcdef0123456789",
      AI_M_INTERNAL_EMBEDDED_BUILD_TIME: "2026-07-14T12:34:56.000Z",
    });
    expect(Object.keys(embedded)).toHaveLength(3);
  });

  it("uses deterministic empty optional fields and ignores hostile internal runtime values", () => {
    const embedded = loadConfig({
      AI_M_INTERNAL_EMBEDDED_VERSION: "9.9.9",
      AI_M_INTERNAL_EMBEDDED_COMMIT: "deadbeef",
      AI_M_INTERNAL_EMBEDDED_BUILD_TIME: "2099-01-01T00:00:00.000Z",
      UNRELATED_SECRET: "must-not-leak",
    });

    expect(embedded).toEqual({
      AI_M_INTERNAL_EMBEDDED_VERSION: "0.1.0",
      AI_M_INTERNAL_EMBEDDED_COMMIT: "",
      AI_M_INTERNAL_EMBEDDED_BUILD_TIME: "",
    });
    expect(JSON.stringify(embedded)).not.toContain("must-not-leak");
    expect(embedded).not.toHaveProperty("AI_M_BUILD_COMMIT");
    expect(embedded).not.toHaveProperty("AI_M_BUILD_TIME");
  });

  it.each([
    [{ AI_M_BUILD_COMMIT: "not-a-commit" }, /commit/i],
    [{ AI_M_BUILD_TIME: "2026-07-14T20:34:56.000+08:00" }, /build time/i],
  ] as const)("fails config loading for invalid build input %#", (overrides, message) => {
    expect(() => loadConfig(overrides)).toThrow(message);
  });
});
