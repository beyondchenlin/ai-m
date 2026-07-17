import type { ChildProcess } from "node:child_process";

const DEFAULT_CHILD_EXIT_TIMEOUT_MS = 5_000;

function childDescription(child: ChildProcess): string {
  return child.pid ? `child process ${child.pid}` : "child process";
}

export function waitForChildExit(
  child: ChildProcess,
  timeoutMs = DEFAULT_CHILD_EXIT_TIMEOUT_MS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${childDescription(child)} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

export function waitForIpcMessage<T>(
  child: ChildProcess,
  timeoutMs = DEFAULT_CHILD_EXIT_TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${childDescription(child)} did not send an IPC message within ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (message: unknown) => {
      cleanup();
      resolve(message as T);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`${childDescription(child)} exited before sending IPC (code=${code ?? "null"}, signal=${signal ?? "null"})`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };
    child.once("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

export async function terminateChildProcess(
  child: ChildProcess,
  timeoutMs = DEFAULT_CHILD_EXIT_TIMEOUT_MS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.connected) child.disconnect();
  child.kill("SIGTERM");
  try {
    await waitForChildExit(child, timeoutMs);
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitForChildExit(child, timeoutMs);
  }
}
