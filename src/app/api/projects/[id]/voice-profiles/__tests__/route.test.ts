import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processVoiceProfile: vi.fn(),
}));

vi.mock("@/lib/feature-flags", () => ({
  isEnabled: () => true,
  isEnabledForProject: () => true,
  FF: { V2_LOCAL_SPEECH: "V2_LOCAL_SPEECH" },
}));
vi.mock("@/lib/assert-project-ownership", () => ({
  assertProjectOwnership: vi.fn(async () => true),
}));
vi.mock("@/lib/get-user-id", () => ({
  getUserIdFromRequest: vi.fn(async () => "route-user"),
}));
vi.mock("@/lib/generation/voice-profiles", () => {
  class VoiceProfileError extends Error {
    constructor(
      message: string,
      readonly status: 400 | 404 | 409,
      readonly code: string,
    ) {
      super(message);
    }
  }
  return {
    processVoiceProfile: mocks.processVoiceProfile,
    listVoiceProfiles: vi.fn(),
    VoiceProfileError,
    VOICE_CONSENT_VERSION: "voice-clone-consent-v1",
  };
});

import { VoiceProfileError } from "@/lib/generation/voice-profiles";
import { POST } from "../route";

const body = {
  name: "Narrator",
  provider: "indextts2",
  referenceSourceAssetId: "source-a",
  consentConfirmed: true,
};

function request(extra: Record<string, unknown> = {}, headers: HeadersInit = {}): Request {
  return new Request("http://localhost/api/projects/project-a/voice-profiles", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify({ ...body, ...extra }),
  });
}

describe("voice profile idempotency route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires an idempotency key before processing", async () => {
    const response = await POST(request(), { params: Promise.resolve({ id: "project-a" }) });
    expect(response.status).toBe(400);
    expect(mocks.processVoiceProfile).not.toHaveBeenCalled();
  });

  it("accepts the header key and passes it to the service", async () => {
    mocks.processVoiceProfile.mockResolvedValueOnce({ id: "profile-a" });
    const response = await POST(
      request({}, { "idempotency-key": "operation-a" }),
      { params: Promise.resolve({ id: "project-a" }) },
    );
    expect(response.status).toBe(201);
    expect(mocks.processVoiceProfile).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "operation-a" }),
    );
  });

  it("maps semantic key conflicts to stable 409", async () => {
    mocks.processVoiceProfile.mockRejectedValueOnce(new VoiceProfileError(
      "Idempotency conflict",
      409,
      "idempotency_key_conflict",
    ));
    const response = await POST(
      request({ idempotencyKey: "operation-a" }),
      { params: Promise.resolve({ id: "project-a" }) },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Idempotency conflict",
      code: "idempotency_key_conflict",
    });
  });
});
