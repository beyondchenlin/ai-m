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
    blockOnRetainedResult?: boolean;
  };
}

export class JobExecutionAndRuntimeResetError extends AggregateError {
  readonly code = "execution_and_runtime_reset_failed";

  constructor(executionError: unknown, resetError: unknown) {
    super([executionError, resetError], "Job execution and runtime reset both failed", { cause: executionError });
    this.name = "JobExecutionAndRuntimeResetError";
  }
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

  block(): void {
    if (this.currentState !== "stopped") this.currentState = "blocked";
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
    const blockOnRetainedResult = this.dependencies.policy?.blockOnRetainedResult ?? true;
    let result: TResult;
    try {
      result = await this.dependencies.execute(job, controller.signal);
    } catch (error) {
      let resetError: unknown;
      if (restartAfterJob) {
        try { await this.resetRuntime(controller.signal); }
        catch (caught) { resetError = caught; }
      }
      if (this.currentState !== "stopped") this.currentState = blockOnExecutionError ? "blocked" : "ready";
      if (resetError !== undefined) throw new JobExecutionAndRuntimeResetError(error, resetError);
      throw error;
    }

    if (restartAfterJob) await this.resetRuntime(controller.signal);
    if (this.currentState !== "stopped") {
      this.currentState = result.claimDisposition === "retain-recovery" && blockOnRetainedResult ? "blocked" : "ready";
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

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        active.then(() => undefined, () => undefined),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
