import type { JobExecutionResult } from "@/lib/generation/jobs/worker-finalization";

export async function settleClaimedJob(input: {
  execute: () => Promise<JobExecutionResult>;
  release: () => Promise<boolean>;
}): Promise<JobExecutionResult> {
  const result = await input.execute();
  if (result.claimDisposition === "release-terminal") {
    const released = await input.release();
    if (!released) throw new Error("terminal_job_claim_release_rejected");
  }
  return result;
}
