import { describe, expect, it } from "vitest";
import { selectPrimaryArtifact } from "@/lib/generation/artifact-selection";
import type { CompiledOutput } from "@/lib/generation/workflows/types";

const outputs: CompiledOutput[] = [
  {
    key: "primary",
    nodeId: "10",
    classType: "SaveImage",
    field: "images",
    mediaKind: "image",
    maxItems: 1,
  },
  {
    key: "preview",
    nodeId: "11",
    classType: "SaveImage",
    field: "images",
    mediaKind: "image",
    maxItems: 1,
  },
];

describe("selectPrimaryArtifact", () => {
  it("uses reviewed manifest order rather than commit completion order", () => {
    const selected = selectPrimaryArtifact([
      { artifactId: "preview-artifact", nodeId: "11", outputKey: "preview", field: "images", sequence: 0 },
      { artifactId: "primary-artifact", nodeId: "10", outputKey: "primary", field: "images", sequence: 1 },
    ], outputs);

    expect(selected.artifactId).toBe("primary-artifact");
  });

  it("uses collection sequence for repeated items from the same approved output", () => {
    const selected = selectPrimaryArtifact([
      { artifactId: "second", nodeId: "10", outputKey: "primary", field: "images", sequence: 2 },
      { artifactId: "first", nodeId: "10", outputKey: "primary", field: "images", sequence: 1 },
    ], outputs);

    expect(selected.artifactId).toBe("first");
  });

  it("rejects artifacts that are outside the compiled output contract", () => {
    expect(() => selectPrimaryArtifact([
      { artifactId: "unexpected", nodeId: "99", outputKey: "unknown", field: "images", sequence: 0 },
    ], outputs)).toThrow(/approved workflow output/);
  });
});
