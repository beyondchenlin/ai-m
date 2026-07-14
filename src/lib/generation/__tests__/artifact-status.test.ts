import { describe, expect, it } from "vitest";
import { ArtifactStatus } from "../naming";

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
