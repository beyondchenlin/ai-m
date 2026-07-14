import { describe, expect, it } from "vitest";
import type { CreateGenerationJobInput } from "@/lib/generation/contracts";
import { buildIdempotencyRequestDigest, legacySnapshotIdempotencyDigest } from "../idempotency";

function request(overrides: Partial<CreateGenerationJobInput> = {}): CreateGenerationJobInput {
  return {
    capability: "speech",
    profileRevisionId: "speech-profile-a",
    projectId: "project-a",
    request: { text: "hello", voiceProfileId: "voice-a" },
    businessContext: { kind: "dialogue-audio", id: "dialogue-a" },
    ...overrides,
  };
}

describe("generation idempotency request digest", () => {
  it("is stable for the same semantic request", () => {
    const first = buildIdempotencyRequestDigest(request(), [{ id: "source-a", role: "voice-reference" }]);
    const second = buildIdempotencyRequestDigest(request(), [{ id: "source-a", role: "voice-reference" }]);
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes when profile, business target, request, or source changes", () => {
    const base = buildIdempotencyRequestDigest(request(), [{ id: "source-a", role: "voice-reference" }]);
    expect(buildIdempotencyRequestDigest(request({ profileRevisionId: "speech-profile-b" }), [{ id: "source-a", role: "voice-reference" }])).not.toBe(base);
    expect(buildIdempotencyRequestDigest(request({ businessContext: { kind: "dialogue-audio", id: "dialogue-b" } }), [{ id: "source-a", role: "voice-reference" }])).not.toBe(base);
    expect(buildIdempotencyRequestDigest(request({ request: { text: "different", voiceProfileId: "voice-a" } }), [{ id: "source-a", role: "voice-reference" }])).not.toBe(base);
    expect(buildIdempotencyRequestDigest(request(), [{ id: "source-b", role: "voice-reference" }])).not.toBe(base);
  });

  it("reconstructs the digest for a legacy execution snapshot", () => {
    const input = request();
    const expected = buildIdempotencyRequestDigest(input, [{ id: "source-a", role: "voice-reference" }]);
    expect(legacySnapshotIdempotencyDigest("speech", {
      profileRevisionId: input.profileRevisionId,
      request: input.request,
      sourceAssets: [{ id: "source-a", role: "voice-reference" }],
      businessContext: input.businessContext,
    })).toBe(expected);
    expect(legacySnapshotIdempotencyDigest("speech", {})).toBeNull();
  });
});
