import { describe, expect, it } from "vitest";

import {
  formatVersionSummary,
  readEmbeddedBuildMetadata,
  resolveBuildMetadata,
  shortCommit,
} from "../build-metadata";

const canonicalTime = "2026-07-14T12:34:56.000Z";

describe("resolveBuildMetadata", () => {
  it.each([
    "0.1.0",
    "1.0.0-alpha.1",
    "2.3.4+build.7",
    "10.20.30-rc.1+sha.abc",
  ])("accepts strict SemVer %s", (packageVersion) => {
    expect(resolveBuildMetadata({ packageVersion })).toEqual({
      version: packageVersion,
      commit: null,
      buildTime: null,
    });
  });

  it.each([
    "1",
    "1.2",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "v1.2.3",
    "1.2.3-01",
    "1.2.3+",
    "1.2.3 ",
  ])("rejects non-canonical SemVer %s", (packageVersion) => {
    expect(() => resolveBuildMetadata({ packageVersion })).toThrow(/SemVer/);
  });

  it("accepts Git SHA-1/SHA-256 lengths and canonicalizes commit case", () => {
    const seven = resolveBuildMetadata({ packageVersion: "1.2.3", commit: "ABCDEF0" });
    const sixtyFour = resolveBuildMetadata({ packageVersion: "1.2.3", commit: "A".repeat(64) });

    expect(seven.commit).toBe("abcdef0");
    expect(sixtyFour.commit).toBe("a".repeat(64));
  });

  it.each(["abcdef", "a".repeat(65), "abc_def0", "xyz1234", " abcdef0"])(
    "rejects invalid commit %s",
    (commit) => {
      expect(() => resolveBuildMetadata({ packageVersion: "1.2.3", commit })).toThrow(/commit/i);
    },
  );

  it("accepts only canonical UTC ISO 8601 with exact millisecond precision", () => {
    expect(resolveBuildMetadata({ packageVersion: "1.2.3", buildTime: canonicalTime }).buildTime)
      .toBe(canonicalTime);
  });

  it.each([
    "2026-07-14T12:34:56Z",
    "2026-07-14T12:34:56.00Z",
    "2026-07-14T12:34:56.0000Z",
    "2026-07-14T20:34:56.000+08:00",
    "2026-02-30T12:34:56.000Z",
    "2026-07-14 12:34:56.000Z",
  ])("rejects ambiguous or normalized build time %s", (buildTime) => {
    expect(() => resolveBuildMetadata({ packageVersion: "1.2.3", buildTime })).toThrow(/build time/i);
  });

  it("returns a shallow immutable whitelist with deterministic null fallbacks", () => {
    const metadata = resolveBuildMetadata({
      packageVersion: "1.2.3",
      commit: undefined,
      buildTime: undefined,
    });

    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.keys(metadata).sort()).toEqual(["buildTime", "commit", "version"]);
    expect(metadata).toEqual({ version: "1.2.3", commit: null, buildTime: null });
    expect(metadata).not.toHaveProperty("hostname");
    expect(metadata).not.toHaveProperty("path");
    expect(metadata).not.toHaveProperty("environment");
  });
});

describe("embedded build metadata", () => {
  it("reads only the three internal embedded fields and validates them again", () => {
    const environment = {
      AI_M_INTERNAL_EMBEDDED_VERSION: "1.2.3",
      AI_M_INTERNAL_EMBEDDED_COMMIT: "ABCDEF0123456",
      AI_M_INTERNAL_EMBEDDED_BUILD_TIME: canonicalTime,
      DATABASE_URL: "must-not-leak",
      HOSTNAME: "must-not-leak",
    };
    const metadata = readEmbeddedBuildMetadata(environment);

    expect(metadata).toEqual({
      version: "1.2.3",
      commit: "abcdef0123456",
      buildTime: canonicalTime,
    });
    expect(JSON.stringify(metadata)).not.toContain("must-not-leak");
  });
});

describe("version presentation helpers", () => {
  it("shows at most 12 commit characters while preserving short commits", () => {
    expect(shortCommit("abcdef0")).toBe("abcdef0");
    expect(shortCommit("abcdef0123456789")).toBe("abcdef012345");
    expect(shortCommit(null)).toBeNull();
  });

  it("copies the full commit and localized deterministic fallbacks", () => {
    const labels = {
      appName: "AI Comic Builder",
      version: "Version",
      commit: "Commit",
      buildTime: "Build time",
      development: "Development",
      notProvided: "Not provided",
    } as const;

    expect(formatVersionSummary({
      version: "1.2.3",
      commit: "abcdef0123456789",
      buildTime: canonicalTime,
    }, labels)).toBe(
      "AI Comic Builder — Version 1.2.3; Commit abcdef0123456789; Build time 2026-07-14T12:34:56.000Z",
    );
    expect(formatVersionSummary({ version: "1.2.3", commit: null, buildTime: null }, labels)).toBe(
      "AI Comic Builder — Version 1.2.3; Commit Development; Build time Not provided",
    );
  });
});
