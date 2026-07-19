import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scripts = [
  "scripts/import-verified-generation.ts",
  "scripts/import-workflow-package.ts",
  "scripts/promote-workflow-package.ts",
];

describe("synchronous SQLite transaction contract", () => {
  it.each(scripts)("%s never returns a promise from a transaction callback", async (relativePath) => {
    const source = await readFile(path.resolve(relativePath), "utf8");
    expect(source).not.toMatch(/transaction\s*\(\s*async\b/);
    expect(source).not.toMatch(/await\s+tx\./);
  });

  it.each(scripts.slice(0, 2))("%s repairs a missing disabled profile state during idempotent reuse", async (relativePath) => {
    const source = await readFile(path.resolve(relativePath), "utf8");
    expect(source).toContain("generationProfileStates");
    expect(source).toContain("onConflictDoNothing().run()");
    expect(source).toMatch(/enabled:\s*0/);
    expect(source).toMatch(/visibility:\s*"admin"/);
  });
});
