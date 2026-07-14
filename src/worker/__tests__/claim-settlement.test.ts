import { describe, expect, it, vi } from "vitest";
import { settleClaimedJob } from "../claim-settlement";

describe("claimed job settlement", () => {
  it("retains the claim when execution throws a transient failure", async () => {
    const release = vi.fn(async () => true);
    await expect(settleClaimedJob({
      execute: async () => { throw new Error("event insert failed"); },
      release,
    })).rejects.toThrow("event insert failed");
    expect(release).not.toHaveBeenCalled();
  });

  it("releases only a durably terminal result and checks the release fence", async () => {
    const terminal = {
      success: true,
      finalPhase: "SUCCEEDED",
      needsAttention: false,
      claimDisposition: "release-terminal" as const,
    };
    await expect(settleClaimedJob({ execute: async () => terminal, release: async () => false }))
      .rejects.toThrow("terminal_job_claim_release_rejected");
  });

  it("does not release an evidence-based ownership-loss result", async () => {
    const release = vi.fn(async () => true);
    const result = await settleClaimedJob({
      execute: async () => ({
        success: false,
        finalPhase: "OWNERSHIP_LOST",
        errorClass: "ownership_lost",
        needsAttention: true,
        claimDisposition: "retain-recovery",
      }),
      release,
    });
    expect(result.claimDisposition).toBe("retain-recovery");
    expect(release).not.toHaveBeenCalled();
  });
});
