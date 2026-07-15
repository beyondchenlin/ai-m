export type JobRuntimeBoundaryState = "ready" | "running-job" | "restarting" | "blocked" | "stopped";

export interface JobRuntimeResult {
  claimDisposition: "release-terminal" | "retain-recovery";
}

export interface JobRuntimeBoundaryDependencies<TJob, TResult extends JobRuntimeResult> {
  execute(job: TJob, signal: AbortSignal): Promise<TResult>;
  closeConnections(): Promise<void> | void;
  restart(signal: AbortSignal): Promise<void>;
  policy?: {
    restartAfterJob: boolean;
    blockOnExecutionError: boolean;
  };
}

export class JobRuntimeBoundary<TJob, TResult extends JobRuntimeResult> {
  private currentState: JobRuntimeBoundaryState = "ready";
  private activeController: AbortController | null = null;
  private activeRun: Promise<TResult> | null = null;

  constructor(private readonly dependencies: JobRuntimeBoundaryDependencies<TJob, TResult>) {}

  get state(): JobRuntimeBoundaryState {
    return this.currentState;
  }

  assertReadyToClaim(): void {
    if (this.currentState !== "ready") {
      throw new Error(`job_runtime_boundary_not_ready:${this.currentState}`);
    }
  }

  run(job: TJob): Promise<TResult> {
    if (this.currentState !== "ready") {
      return Promise.reject(new Error(`job_runtime_boundary_not_ready:${this.currentState}`));
    }
    const controller = new AbortController();
    this.activeController = controller;
    this.currentState = "running-job";

    const operation = this.runWithinBoundary(job, controller);
    this.activeRun = operation;
    void operation.finally(() => {
      if (this.activeRun === operation) {
        this.activeRun = null;
        this.activeController = null;
      }
    }).catch(() => undefined);
    return operation;
  }

  private async runWithinBoundary(job: TJob, controller: AbortController): Promise<TResult> {
    const restartAfterJob = this.dependencies.policy?.restartAfterJob ?? true;
    const blockOnExecutionError = this.dependencies.policy?.blockOnExecutionError ?? true;
    let result: TResult;
    try {
      result = await this.dependencies.execute(job, controller.signal);
    } catch (error) {
      if (restartAfterJob) await this.resetRuntime(controller.signal).catch(() => undefined);
      if (this.currentState !== "stopped") this.currentState = blockOnExecutionError ? "blocked" : "ready";
      throw error;
    }

    if (restartAfterJob) await this.resetRuntime(controller.signal);
    if (this.currentState !== "stopped") {
      this.currentState = !restartAfterJob || result.claimDisposition === "release-terminal" ? "ready" : "blocked";
    }
    return result;
  }

  private async resetRuntime(signal: AbortSignal): Promise<void> {
    if (this.currentState !== "stopped") this.currentState = "restarting";
    try {
      await this.dependencies.closeConnections();
      await this.dependencies.restart(signal);
    } catch (error) {
      if (this.currentState !== "stopped") this.currentState = "blocked";
      throw error;
    }
  }

  async stop(timeoutMs: number): Promise<void> {
    if (this.currentState === "stopped") return;
    this.currentState = "stopped";
    this.activeController?.abort(new Error("job_runtime_boundary_shutdown"));
    const active = this.activeRun;
    if (!active) {
      await Promise.resolve(this.dependencies.closeConnections());
      return;
    }

    await Promise.race([
      active.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
}
