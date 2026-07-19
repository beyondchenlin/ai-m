import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WINDOWS_TOKEN_ISSUER = "windows-local-token" as const;
const WINDOWS_SID_PATTERN = /^S-1-(?:\d+-)+\d+$/;
const issuedOperators = new WeakSet<object>();

export interface AuthenticatedLocalOperator {
  subjectId: string;
  issuer: typeof WINDOWS_TOKEN_ISSUER;
  authenticationContextDigest: string;
}

export function windowsTokenContextDigest(subjectId: string): string {
  if (!WINDOWS_SID_PATTERN.test(subjectId)) {
    throw new Error("Authenticated operator subject must be a Windows SID");
  }
  return createHash("sha256")
    .update(JSON.stringify({ issuer: WINDOWS_TOKEN_ISSUER, subjectId }))
    .digest("hex");
}

function issueWindowsTokenOperator(subjectId: string): AuthenticatedLocalOperator {
  const operator: AuthenticatedLocalOperator = {
    subjectId,
    issuer: WINDOWS_TOKEN_ISSUER,
    authenticationContextDigest: windowsTokenContextDigest(subjectId),
  };
  issuedOperators.add(operator);
  return Object.freeze(operator);
}

/** Test-only constructor. Production callers must resolve the current Windows token. */
export function windowsTokenOperator(subjectId: string): AuthenticatedLocalOperator {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Synthetic Windows token operators are available only in tests");
  }
  return issueWindowsTokenOperator(subjectId);
}

export async function resolveAuthenticatedLocalOperator(): Promise<AuthenticatedLocalOperator> {
  if (process.platform !== "win32") {
    throw new Error("Local workflow import and approval require an authenticated Windows operator");
  }
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    ],
    { windowsHide: true, maxBuffer: 16 * 1024 },
  );
  return issueWindowsTokenOperator(stdout.trim());
}

export function authenticatedOperatorActorId(
  operator: AuthenticatedLocalOperator,
): string {
  if (
    !issuedOperators.has(operator)
    ||
    operator.issuer !== WINDOWS_TOKEN_ISSUER
    || operator.authenticationContextDigest !== windowsTokenContextDigest(operator.subjectId)
  ) {
    throw new Error("Authenticated operator context is invalid");
  }
  return `windows-sid:${operator.subjectId}`;
}
