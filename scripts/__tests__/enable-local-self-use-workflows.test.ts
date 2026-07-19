import { describe, expect, it } from "vitest";
import {
  assertLoopbackBackendUrl,
  parseRequestedProfileKeys,
  selectLatestProfileRevisions,
} from "../enable-local-self-use-workflows";

describe("local self-use workflow activation guards", () => {
  it.each([
    "http://127.0.0.1:8000",
    "http://localhost:8001",
    "http://[::1]:8002",
  ])("accepts a plain loopback backend: %s", (value) => {
    expect(assertLoopbackBackendUrl(value).port).toBeTruthy();
  });

  it.each([
    "https://127.0.0.1:8000",
    "http://192.168.1.10:8000",
    "http://example.com:8000",
    "http://user:pass@127.0.0.1:8000",
    "http://127.0.0.1:8000/api",
  ])("rejects a non-local or decorated backend: %s", (value) => {
    expect(() => assertLoopbackBackendUrl(value)).toThrow(/loopback/i);
  });

  it("parses an optional exact profile allowlist", () => {
    expect(parseRequestedProfileKeys(undefined)).toBeNull();
    expect(parseRequestedProfileKeys('["tts-omnivoice-longform-bf16"]'))
      .toEqual(new Set(["tts-omnivoice-longform-bf16"]));
    expect(() => parseRequestedProfileKeys("[]")).toThrow(/non-empty/i);
    expect(() => parseRequestedProfileKeys('["same","same"]')).toThrow(/duplicates/i);
  });

  it("selects only the latest revision for each profile key", () => {
    const row = (id: string, revisionNo: number, state = "installed") => ({
      profile: {
        id,
        profileKey: "speech-profile",
        revisionNo,
        adapterKind: "comfyui",
        executionBackendId: "comfy-omni-8002",
      },
      profileState: {},
      workflow: {},
      workflowState: { state },
    });
    const selected = selectLatestProfileRevisions(
      [row("old", 1), row("latest", 2)] as never,
      null,
    );
    expect(selected.map((item) => item.profile.id)).toEqual(["latest"]);
  });

  it("fails closed when the latest revision is not activatable", () => {
    const rows = [{
      profile: {
        id: "latest",
        profileKey: "speech-profile",
        revisionNo: 2,
        adapterKind: "comfyui",
        executionBackendId: "comfy-omni-8002",
      },
      profileState: {},
      workflow: {},
      workflowState: { state: "revoked" },
    }];
    expect(() => selectLatestProfileRevisions(rows as never, null)).toThrow(/latest.*not activatable/i);
  });

  it("rejects oversized and malformed profile allowlists", () => {
    expect(() => parseRequestedProfileKeys(JSON.stringify(["bad profile key"]))).toThrow(/identifier/i);
    expect(() => parseRequestedProfileKeys(JSON.stringify(
      Array.from({ length: 257 }, (_, index) => `profile-${index}`),
    ))).toThrow(/bounded/i);
  });
});
