import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MUTATION_EXPORT = /export\s+(?:async\s+)?function\s+(?:POST|PUT|PATCH|DELETE)\b/;

function routeFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(candidate);
    return entry.name === "route.ts" ? [candidate] : [];
  });
}

describe("mutating API route coverage", () => {
  it("routes every mutating API handler through the central proxy boundary", () => {
    const apiRoot = path.resolve("src/app/api");
    const mutating = routeFiles(apiRoot).filter((file) => MUTATION_EXPORT.test(fs.readFileSync(file, "utf8")));
    expect(mutating.length).toBeGreaterThanOrEqual(53);
    expect(mutating.every((file) => file.startsWith(`${apiRoot}${path.sep}`))).toBe(true);

    const proxy = fs.readFileSync(path.resolve("src/proxy.ts"), "utf8");
    expect(proxy).toMatch(/pathname\.startsWith\(["']\/api\/["']\)/);
    expect(proxy).toMatch(/assertMutationRequest\(request\)/);
    expect(proxy).not.toMatch(/\(\?!api\|/);
  });
});
