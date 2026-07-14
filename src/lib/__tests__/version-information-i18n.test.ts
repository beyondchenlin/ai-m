import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const locales = ["zh", "en", "ja", "ko"] as const;
const expectedKeys = [
  "title",
  "description",
  "version",
  "commit",
  "buildTime",
  "development",
  "notProvided",
  "copy",
  "copied",
  "copyFailed",
] as const;

describe("version information translations", () => {
  it.each(locales)("defines the complete %s dictionary with nonempty strings", (locale) => {
    const filename = path.resolve("messages", `${locale}.json`);
    const messages = JSON.parse(fs.readFileSync(filename, "utf8")) as {
      settings?: { versionInfo?: Record<string, unknown> };
    };
    const versionInfo = messages.settings?.versionInfo;

    expect(versionInfo).toBeDefined();
    expect(Object.keys(versionInfo ?? {}).sort()).toEqual([...expectedKeys].sort());
    for (const key of expectedKeys) {
      expect(typeof versionInfo?.[key]).toBe("string");
      expect(String(versionInfo?.[key] ?? "").trim().length).toBeGreaterThan(0);
    }
  });
});
