import { describe, expect, it, vi } from "vitest";

import { JobRuntimeBoundary } from "../job-runtime-boundary";

type Result = { claimDisposition: "release-terminal" | "retain-recovery" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("JobRuntimeBoundary", () => {
  it("waits for execution and terminal claim release settlement before closing connections and restarting", async () => {
    const settlement = deferred<Result>();
    const events: string[] = [];
    const boundary = new JobRuntimeBoundary<string, Result>({
      execute: async () => { events.push("execute"); return settlement.promise; },
      closeConnections: async () => { events.push("close"); },
      restart: async () => { events.push("restart"); },
    });

    const run = boundary.run("job-1");
    await Promise.resolve();
    expect(events).toEqual(["execute"]);
    expect(boundary.state).toBe("running-job");

    settlement.resolve({ claimDisposition: "release-terminal" });
    await run;
    expect(events).toEqual(["execute", "close", "restart"]);
    expect(boundary.state).toBe("ready");
  });

  it("blocks claims when restart fails", async () => {
    const boundary = new JobRuntimeBoundary<string, Result>({
      execute: async () => ({ claimDisposition: "release-terminal" }),
      closeConnections: async () => undefined,
      restart: async () => { throw new Error("readiness failed"); },
    });

    await expect(boundary.run("job-1")).rejects.toThrow("readiness failed");
    expect(boundary.state).toBe("blocked");
    expect(() => boundary.assertReadyToClaim()).toThrow(/blocked/);
  });

  it("restarts for retained recovery results but remains blocked", async () => {
    const restart = vi.fn(async () => undefined);
    const boundary = new JobRuntimeBoundary<string, Result>({
      execute: async () => ({ claimDisposition: "retain-recovery" }),
      closeConnections: async () => undefined,
      restart,
    });

    await boundary.run("job-1");
    expect(restart).toHaveBeenCalledOnce();
    expect(boundary.state).toBe("blocked");
    expect(() => boundary.assertReadyToClaim()).toThrow(/blocked/);
  });

  it("rejects concurrent jobs and gates the next claim until restart completes", async () => {
    const restart = deferred<void>();
    const boundary = new JobRuntimeBoundary<string, Result>({
      execute: async () => ({ claimDisposition: "release-terminal" }),
      closeConnections: async () => undefined,
      restart: async () => restart.promise,
    });

    const first = boundary.run("job-1");
    await vi.waitFor(() => expect(boundary.state).toBe("restarting"));
    expect(() => boundary.assertReadyToClaim()).toThrow(/restarting/);
    await expect(boundary.run("job-2")).rejects.toThrow(/restarting/);

    restart.resolve();
    await first;
    expect(() => boundary.assertReadyToClaim()).not.toThrow();
  });

  it("shutdown aborts an in-progress restart and stops after a bounded wait", async () => {
    vi.useFakeTimers();
    const restartStarted = deferred<void>();
    const boundary = new JobRuntimeBoundary<string, Result>({
      execute: async () => ({ claimDisposition: "release-terminal" }),
      closeConnections: async () => undefined,
      restart: async (signal) => {
        restartStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });

    const run = boundary.run("job-1");
    await restartStarted.promise;
    const shutdown = boundary.stop(25);
    await vi.advanceTimersByTimeAsync(25);
    await shutdown;
    await expect(run).rejects.toThrow(/shutdown/);
    expect(boundary.state).toBe("stopped");
    vi.useRealTimers();
  });
});
