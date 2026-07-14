import { describe, expect, it } from "vitest";
import { assertSpeechProfileCompatibility } from "../speech-domain";

const baseProfile = {
  adapterKind: "comfyui",
  executionBackendId: "backend-1",
  workflowPackageDigest: "sha256:workflow",
  configJson: { speechEngine: "indextts2" },
};

describe("speech profile compatibility", () => {
  it("accepts an exact engine match", () => {
    expect(assertSpeechProfileCompatibility(baseProfile, "indextts2")).toBe("indextts2");
  });

  it("rejects a profile without an explicit supported engine", () => {
    expect(() => assertSpeechProfileCompatibility({ ...baseProfile, configJson: {} }, "indextts2"))
      .toThrow(/does not declare/i);
  });

  it("rejects engine mismatch instead of silently falling back", () => {
    expect(() => assertSpeechProfileCompatibility(baseProfile, "omnivoice"))
      .toThrow(/requires omnivoice/i);
  });

  it("rejects non-ComfyUI or incomplete profiles", () => {
    expect(() => assertSpeechProfileCompatibility({ ...baseProfile, adapterKind: "cloud" }, "indextts2"))
      .toThrow(/complete ComfyUI/i);
    expect(() => assertSpeechProfileCompatibility({ ...baseProfile, workflowPackageDigest: null }, "indextts2"))
      .toThrow(/complete ComfyUI/i);
  });
});
