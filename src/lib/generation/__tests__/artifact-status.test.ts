import { describe, expect, it, vi } from "vitest";
import { ArtifactStatus } from "../naming";
import { parseLegacyArtifactRecoveryBeforeMs } from "../archiving/commit";

describe("artifact lifecycle vocabulary", () => {
  it("includes the leased recovery state used by the database state machine", () => {
    expect(Object.values(ArtifactStatus)).toEqual([
      "STAGING",
      "RECOVERING",
      "COMMITTED",
      "QUARANTINED",
      "DELETED",
    ]);
  });
});

describe("legacy artifact recovery drain cutoff", () => {
  it("fails closed for missing, malformed, and future cutoffs", () => {
    const warn = vi.fn();
    expect(parseLegacyArtifactRecoveryBeforeMs(undefined, 2_000, warn)).toBeUndefined();
    expect(parseLegacyArtifactRecoveryBeforeMs("bad", 2_000, warn)).toBeUndefined();
    expect(parseLegacyArtifactRecoveryBeforeMs("3000", 2_000, warn)).toBeUndefined();
    expect(parseLegacyArtifactRecoveryBeforeMs("1500", 2_000, warn)).toBe(1_500);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
