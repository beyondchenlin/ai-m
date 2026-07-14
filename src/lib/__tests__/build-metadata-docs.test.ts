import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readme = readFileSync(path.resolve(__dirname, "../../../README.md"), "utf8");

describe("build metadata deployment documentation", () => {
  it("documents package.json as the sole version source and both optional build inputs", () => {
    expect(readme).toContain("`package.json` 中的 `version` 是应用版本的唯一来源");
    expect(readme).toContain("`AI_M_BUILD_COMMIT`");
    expect(readme).toContain("7–64 位十六进制");
    expect(readme).toContain("`AI_M_BUILD_TIME`");
    expect(readme).toContain("YYYY-MM-DDTHH:mm:ss.sssZ");
  });

  it("uses placeholders rather than claiming a real deployment commit", () => {
    expect(readme).toContain("<7-to-64-hex-commit>");
    expect(readme).toContain("2026-01-01T00:00:00.000Z");
  });
});
