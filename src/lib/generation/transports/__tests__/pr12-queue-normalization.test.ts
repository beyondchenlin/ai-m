import { describe, expect, it } from "vitest";
import { probeQueueStatus } from "../comfyui";
import { FakeComfyUITransport } from "@/lib/test-helpers/fake-comfyui";

describe("PR-12 official ComfyUI queue normalization", () => {
  it("normalizes object queue fixtures", async () => {
    const transport = new FakeComfyUITransport({
      queueRunning: [{ prompt_id: "prompt-1", correlation_id: "corr-1" }],
    });
    const queue = await probeQueueStatus(transport);
    expect(queue.queueRunning[0]).toMatchObject({ promptId: "prompt-1", correlationId: "corr-1" });
  });
});
