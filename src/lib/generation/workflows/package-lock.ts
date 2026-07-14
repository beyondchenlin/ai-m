import type { WorkflowManifest } from "./types";

export interface WorkflowPackageLock {
  schemaVersion: 1;
  workflowId: string;
  version: string;
  files: Record<string, string>;
  environmentLockDigest: string;
}

export class WorkflowPackageLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowPackageLockError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseWorkflowPackageLock(value: unknown, manifest: WorkflowManifest): WorkflowPackageLock {
  if (!isRecord(value)) throw new WorkflowPackageLockError("package.lock.json must be an object");
  const allowed = new Set(["schemaVersion", "workflowId", "version", "files", "environmentLockDigest"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new WorkflowPackageLockError(`package.lock.json has unknown field(s): ${unknown.join(", ")}`);
  if (value.schemaVersion !== 1) throw new WorkflowPackageLockError("package lock schemaVersion must equal 1");
  if (value.workflowId !== manifest.workflowId || value.version !== manifest.version) {
    throw new WorkflowPackageLockError("package lock identity does not match manifest");
  }
  if (!isRecord(value.files)) throw new WorkflowPackageLockError("package lock files must be an object");
  const entries = Object.entries(value.files);
  if (entries.length < 2 || entries.length > 64) throw new WorkflowPackageLockError("package lock files must contain 2-64 entries");
  const files: Record<string, string> = {};
  for (const [name, digest] of entries) {
    if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith("/") || name.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new WorkflowPackageLockError(`package lock filename is unsafe: ${name}`);
    }
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/i.test(digest)) {
      throw new WorkflowPackageLockError(`package lock digest is invalid: ${name}`);
    }
    files[name] = digest.toLowerCase();
  }
  for (const required of [manifest.workflowFile, "manifest.json"]) {
    if (!files[required]) throw new WorkflowPackageLockError(`package lock is missing ${required}`);
  }
  if (typeof value.environmentLockDigest !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(value.environmentLockDigest)) {
    throw new WorkflowPackageLockError("environmentLockDigest must be sha256:<64 hex>");
  }
  return {
    schemaVersion: 1,
    workflowId: manifest.workflowId,
    version: manifest.version,
    files,
    environmentLockDigest: value.environmentLockDigest.toLowerCase(),
  };
}

export function verifyLockedFiles(lock: WorkflowPackageLock, actualDigests: Record<string, string>): void {
  for (const [name, expected] of Object.entries(lock.files)) {
    const actual = actualDigests[name]?.toLowerCase();
    if (!actual) throw new WorkflowPackageLockError(`locked file was not supplied: ${name}`);
    if (actual !== expected) throw new WorkflowPackageLockError(`locked file digest mismatch: ${name}`);
  }
  const unexpected = Object.keys(actualDigests).filter((name) => !(name in lock.files));
  if (unexpected.length) throw new WorkflowPackageLockError(`unlocked file(s) supplied: ${unexpected.join(", ")}`);
}
