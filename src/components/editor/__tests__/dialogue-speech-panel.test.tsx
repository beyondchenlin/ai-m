// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
const modelState = vi.hoisted(() => ({
  defaultSpeechModel: null,
  providers: [],
}));
const translate = vi.hoisted(() => (key: string) => key);

vi.mock("@/lib/api-fetch", () => ({
  apiFetch,
  ApiError: class ApiError extends Error {
    constructor(readonly status: number) { super("api error"); }
  },
}));

vi.mock("@/stores/model-store", () => ({
  useModelStore: (selector: (state: typeof modelState) => unknown) => selector(modelState),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => translate,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));

import { DialogueSpeechPanel } from "../dialogue-speech-panel";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("DialogueSpeechPanel exact profile routing", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/voice-profiles")) {
        return json({ profiles: [{
          id: "voice-1", name: "Voice", provider: "omnivoice", language: "zh-CN",
        }] });
      }
      if (url.startsWith("/api/generation/profiles")) {
        return json({ profiles: [
          { id: "index-revision", displayName: "Index choice", adapterKind: "comfyui" },
          { id: "omni-revision", displayName: "Omni choice", adapterKind: "comfyui" },
        ] });
      }
      if (url.endsWith("/speech") && init?.method === "POST") {
        return json({ jobId: "job-1" });
      }
      if (url === "/api/generation/jobs/job-1") {
        return json({ job: {
          id: "job-1",
          status: "SUCCEEDED",
          artifacts: [{ id: "audio", kind: "audio", url: "/audio.wav", mimeType: "audio/wav" }],
        } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  it("submits exactly the profile revision selected by the user", async () => {
    render(<DialogueSpeechPanel
      projectId="project-1"
      dialogues={[{ id: "dialogue-1", text: "你好", characterName: "角色" }]}
    />);

    const picker = await screen.findByRole("button", { name: "Select speech model" });
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("option", { name: /Omni choice/ }));
    await waitFor(() => expect((screen.getByRole("combobox") as HTMLSelectElement).value)
      .toBe("voice-1"));
    fireEvent.click(screen.getByRole("button", { name: "generate" }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      "/api/projects/project-1/speech",
      expect.objectContaining({ method: "POST" }),
    ));
    const speechCall = apiFetch.mock.calls.find(([url, init]) => (
      url === "/api/projects/project-1/speech" && init?.method === "POST"
    ));
    expect(JSON.parse(String(speechCall?.[1]?.body))).toMatchObject({
      dialogueId: "dialogue-1",
      voiceProfileId: "voice-1",
      profileRevisionId: "omni-revision",
    });
    expect(apiFetch.mock.calls.filter(([url, init]) => (
      url === "/api/projects/project-1/speech" && init?.method === "POST"
    ))).toHaveLength(1);
  });
});
