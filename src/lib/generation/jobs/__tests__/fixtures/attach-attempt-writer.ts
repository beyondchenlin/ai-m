import { getSqlite } from "@/lib/db";
import { attachOwnedAttempt } from "../../state-transitions";

const [jobId, attemptId, poolId, backendId, nowText] = process.argv.slice(2);
const now = Number(nowText);

process.send?.({ ready: true });
process.once("message", async () => {
  try {
    const result = attachOwnedAttempt({
      jobId,
      workerId: "worker-a",
      jobFencingToken: 13,
    }, {
      clock: () => now,
      attempt: {
        id: attemptId,
        jobId,
        attemptNo: 1,
        jobClaimFencingToken: 13,
        phase: "PREPARING",
        backendId,
        backendFeatureSnapshotJson: {},
        environmentFingerprint: "env:attach",
        submissionCorrelationId: `corr-${attemptId}`,
        externalIdStrategy: "server-assigned",
        systemOutputPrefix: `prefix-${attemptId}`,
        resourcePoolId: poolId,
        resourceSlotNo: 0,
        resourceLeaseToken: `pending-${attemptId}`,
        resourceFencingToken: 0,
        createdAtMs: now,
        updatedAtMs: now,
      },
    });
    await new Promise<void>((resolve, reject) => {
      if (!process.send) { resolve(); return; }
      process.send({ result }, (error) => error ? reject(error) : resolve());
    });
  } catch (error) {
    await new Promise<void>((resolve) => {
      if (!process.send) { resolve(); return; }
      process.send({ error: error instanceof Error ? error.message : String(error) }, () => resolve());
    });
  } finally {
    getSqlite().close();
    process.disconnect?.();
  }
});
