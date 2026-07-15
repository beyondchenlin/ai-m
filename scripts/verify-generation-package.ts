import { createHash, createPrivateKey, createPublicKey, sign as signBytes, verify as verifySignature } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalize } from "../src/lib/generation/workflows/canonical";

const DIGEST = /^[a-f0-9]{64}$/;
const PACKAGE_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const PACKAGE_FILES = ["compiled-bindings.json", "manifest.json", "package.lock.json", "workflow.api.json"] as const;
const MAX_PACKAGE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_GENERATION_METADATA_BYTES = 64 * 1024;

export interface VerifyGenerationPackageOptions {
  generationRoot: string;
  packageName: string;
  expectedGenerationDigest: string;
  expectedPackageDigest: string;
}

export interface VerifyGenerationPackageForImportOptions extends VerifyGenerationPackageOptions {
  verifiedEvidence: unknown;
  trustRootPublicKey?: string | Buffer;
  nowMs?: number;
}

export const TASK4_TRUST_ROOT_PATH = path.join(os.homedir(), ".ai-m", "trust", "pixelle-task4-ed25519-public.pem");
const TASK4_KEY_ID = "pixelle-task4-local-ed25519-v1";

/** Used by Task 4 after it has collected the complete live/restart payload. */
export function signTask4Evidence(payload: Record<string, unknown>, privateKey: string | Buffer): Record<string, unknown> {
  if ("signature" in payload) throw new Error("Unsigned Task 4 payload must not already contain signature");
  const value = signBytes(null, Buffer.from(canonicalize(payload), "utf8"), createPrivateKey(privateKey)).toString("base64");
  return { ...payload, signature: { algorithm: "Ed25519", keyId: TASK4_KEY_ID, value } };
}

export interface VerifiedGenerationPackage {
  generationRoot: string;
  packageDir: string;
  packageName: string;
  generationDigest: string;
  packageDigest: string;
  files: Record<(typeof PACKAGE_FILES)[number], Buffer>;
  verifiedEvidenceDigest?: string;
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readRegularBounded(file: string, maximum: number, label: string): Promise<Buffer> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file without links`);
  if (stat.size > maximum) throw new Error(`${label} exceeds its size limit`);
  const bytes = await fs.readFile(file);
  const after = await fs.lstat(file);
  if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
    throw new Error(`${label} changed while being verified`);
  }
  return bytes;
}

function parseGeneration(bytes: Buffer): { generationDigest: string; packageDigests: Record<string, string> } {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("generation.json is invalid JSON"); }
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.generationDigest !== "string" || !DIGEST.test(value.generationDigest)
    || !isRecord(value.packageDigests) || value.state !== "prepared-environment-unverified") {
    throw new Error("generation.json has an invalid contract");
  }
  const allowed = ["schemaVersion", "generationDigest", "packageDigests", "state"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("generation.json has unknown fields");
  const packageDigests: Record<string, string> = {};
  for (const [name, digest] of Object.entries(value.packageDigests)) {
    if (!PACKAGE_NAME.test(name) || typeof digest !== "string" || !DIGEST.test(digest)) throw new Error("generation.json package digests are invalid");
    packageDigests[name] = digest;
  }
  return { generationDigest: value.generationDigest, packageDigests };
}

function safeIdentity(value: unknown, label: string): { pid: number; processIdentity: string; connectionId: string } {
  if (!isRecord(value) || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
    || typeof value.processIdentity !== "string" || !/^[A-Za-z0-9._:-]{3,300}$/.test(value.processIdentity)
    || typeof value.connectionId !== "string" || !/^[A-Za-z0-9._:-]{8,200}$/.test(value.connectionId)) {
    throw new Error(`Task 4 verified evidence ${label} identity is invalid`);
  }
  return { pid: value.pid as number, processIdentity: value.processIdentity, connectionId: value.connectionId };
}

async function verifyEvidence(
  value: unknown,
  generationDigest: string,
  packageName: string,
  packageDigest: string,
  trustRootPublicKey: string | Buffer | undefined,
  nowMs: number,
): Promise<string> {
  if (!isRecord(value)) throw new Error("Task 4 verified evidence is required");
  const allowed = [
    "schemaVersion", "producer", "issuedAtMs", "expiresAtMs", "generationDigest", "packageName", "packageDigest",
    "backendFingerprint", "listener", "liveRuns", "restart", "signature",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || value.schemaVersion !== 1 || value.producer !== "ai-m/task4-comfyui-live-verify-v1") {
    throw new Error("Task 4 verified evidence contract is invalid");
  }
  if (value.generationDigest !== generationDigest || value.packageName !== packageName || value.packageDigest !== packageDigest) {
    throw new Error("Task 4 verified evidence does not bind the selected generation package");
  }
  if (!Number.isSafeInteger(value.issuedAtMs) || !Number.isSafeInteger(value.expiresAtMs)
    || (value.issuedAtMs as number) > nowMs + 60_000 || (value.expiresAtMs as number) < nowMs
    || (value.expiresAtMs as number) - (value.issuedAtMs as number) > 24 * 60 * 60 * 1000) {
    throw new Error("Task 4 verified evidence is stale or has an invalid validity window");
  }
  if (typeof value.backendFingerprint !== "string" || !DIGEST.test(value.backendFingerprint)) throw new Error("Task 4 backend fingerprint is invalid");
  if (!isRecord(value.listener) || value.listener.baseUrl !== "http://127.0.0.1:8000") throw new Error("Task 4 listener contract is invalid");
  const listener = safeIdentity(value.listener, "listener");
  if (!Array.isArray(value.liveRuns) || value.liveRuns.length < 1 || value.liveRuns.length > 32) throw new Error("Task 4 evidence requires bounded live runs");
  for (const [index, runValue] of value.liveRuns.entries()) {
    if (!isRecord(runValue) || typeof runValue.runId !== "string" || !/^[A-Za-z0-9._:-]{8,200}$/.test(runValue.runId)
      || !Number.isSafeInteger(runValue.startedAtMs) || !Number.isSafeInteger(runValue.completedAtMs)
      || (runValue.completedAtMs as number) < (runValue.startedAtMs as number) || !isRecord(runValue.artifact)
      || typeof runValue.artifact.sha256 !== "string" || !DIGEST.test(runValue.artifact.sha256)
      || !["audio", "image", "video"].includes(String(runValue.artifact.mediaKind))
      || !Number.isSafeInteger(runValue.artifact.byteLength) || (runValue.artifact.byteLength as number) <= 0) {
      throw new Error(`Task 4 live run ${index} is invalid`);
    }
  }
  if (!isRecord(value.restart) || !Number.isSafeInteger(value.restart.restartedAtMs) || !Number.isSafeInteger(value.restart.reconnectedAtMs)
    || (value.restart.reconnectedAtMs as number) < (value.restart.restartedAtMs as number)) throw new Error("Task 4 restart evidence is invalid");
  const before = safeIdentity(value.restart.before, "restart.before");
  const after = safeIdentity(value.restart.after, "restart.after");
  if (before.processIdentity === after.processIdentity || before.connectionId === after.connectionId
    || listener.processIdentity !== after.processIdentity || listener.connectionId !== after.connectionId || listener.pid !== after.pid) {
    throw new Error("Task 4 restart/listener identities are not independently bound");
  }
  if (!isRecord(value.signature) || value.signature.algorithm !== "Ed25519" || value.signature.keyId !== TASK4_KEY_ID
    || typeof value.signature.value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.signature.value)) {
    throw new Error("Task 4 evidence signature metadata is invalid");
  }
  const { signature, ...payload } = value;
  const publicKeyBytes = trustRootPublicKey ?? await fs.readFile(TASK4_TRUST_ROOT_PATH);
  let valid = false;
  try {
    valid = verifySignature(null, Buffer.from(canonicalize(payload), "utf8"), createPublicKey(publicKeyBytes), Buffer.from(signature.value as string, "base64"));
  } catch {
    throw new Error("Task 4 evidence trust root or signature is invalid");
  }
  if (!valid) throw new Error("Task 4 evidence signature verification failed");
  return digestBytes(Buffer.from(canonicalize(value), "utf8"));
}

/** Offline integrity verification for prepare/current/GC only. This does not authorize import. */
export async function verifyPreparedGenerationPackage(options: VerifyGenerationPackageOptions): Promise<VerifiedGenerationPackage> {
  if (!DIGEST.test(options.expectedGenerationDigest)) throw new Error("Expected generation digest must be 64 lowercase hex");
  if (!DIGEST.test(options.expectedPackageDigest)) throw new Error("Expected package digest must be 64 lowercase hex");
  if (!PACKAGE_NAME.test(options.packageName)) throw new Error("Package name is invalid");
  const generationRoot = path.resolve(options.generationRoot);
  if (path.basename(generationRoot) !== options.expectedGenerationDigest) throw new Error("Generation root does not match the expected generation digest");
  const generationStat = await fs.lstat(generationRoot);
  if (!generationStat.isDirectory() || generationStat.isSymbolicLink()) throw new Error("Generation root must be a regular directory without links");
  if (await fs.realpath(generationRoot) !== generationRoot) throw new Error("Generation root must use its canonical path");

  const generationBytes = await readRegularBounded(path.join(generationRoot, "generation.json"), MAX_GENERATION_METADATA_BYTES, "generation.json");
  const generation = parseGeneration(generationBytes);
  const recomputedGenerationDigest = digestBytes(Buffer.from(canonicalize({ schemaVersion: 1, packageDigests: generation.packageDigests }), "utf8"));
  if (generation.generationDigest !== options.expectedGenerationDigest || recomputedGenerationDigest !== options.expectedGenerationDigest) {
    throw new Error("Generation digest does not match generation.json bytes");
  }

  const packageDir = path.join(generationRoot, options.packageName);
  if (path.dirname(packageDir) !== generationRoot) throw new Error("Package directory escapes generation root");
  const packageStat = await fs.lstat(packageDir);
  if (!packageStat.isDirectory() || packageStat.isSymbolicLink() || await fs.realpath(packageDir) !== packageDir) {
    throw new Error("Generation package must be a regular canonical directory without links");
  }
  if ((await fs.readdir(packageDir)).sort().join("\0") !== [...PACKAGE_FILES].sort().join("\0")) {
    throw new Error("Generation package has unexpected files");
  }
  const files = {} as VerifiedGenerationPackage["files"];
  const fileDigests: Record<string, string> = {};
  for (const filename of PACKAGE_FILES) {
    const bytes = await readRegularBounded(path.join(packageDir, filename), MAX_PACKAGE_FILE_BYTES, filename);
    files[filename] = bytes;
    fileDigests[filename] = digestBytes(bytes);
  }
  const packageDigest = digestBytes(Buffer.from(canonicalize(fileDigests), "utf8"));
  if (packageDigest !== options.expectedPackageDigest || generation.packageDigests[options.packageName] !== packageDigest) {
    throw new Error("Package digest does not match the selected package bytes");
  }
  return {
    generationRoot, packageDir, packageName: options.packageName,
    generationDigest: options.expectedGenerationDigest, packageDigest, files,
  };
}

/** Import authorization always requires Task 4 evidence bound to the verified bytes. */
export async function verifyGenerationPackageForImport(options: VerifyGenerationPackageForImportOptions): Promise<VerifiedGenerationPackage> {
  const prepared = await verifyPreparedGenerationPackage(options);
  const verifiedEvidenceDigest = await verifyEvidence(
    options.verifiedEvidence,
    prepared.generationDigest,
    prepared.packageName,
    prepared.packageDigest,
    options.trustRootPublicKey,
    options.nowMs ?? Date.now(),
  );
  return { ...prepared, verifiedEvidenceDigest };
}
