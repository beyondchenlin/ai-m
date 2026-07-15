import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
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
  verifiedEvidence?: unknown;
  requireVerifiedEvidence?: boolean;
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

function verifyEvidence(value: unknown, generationDigest: string, packageName: string, packageDigest: string): string {
  if (!isRecord(value)) throw new Error("Task 4 verified evidence is required");
  const expected = {
    schemaVersion: 1,
    producer: "ai-m/task4-comfyui-live-verify",
    generationDigest,
    packageName,
    packageDigest,
  };
  if (Object.keys(value).sort().join("\0") !== Object.keys(expected).sort().join("\0")
    || Object.entries(expected).some(([key, expectedValue]) => value[key] !== expectedValue)) {
    throw new Error("Task 4 verified evidence does not bind the selected generation package");
  }
  return digestBytes(Buffer.from(canonicalize(expected), "utf8"));
}

export async function verifyGenerationPackageForImport(options: VerifyGenerationPackageOptions): Promise<VerifiedGenerationPackage> {
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
  const verifiedEvidenceDigest = options.verifiedEvidence === undefined
    ? undefined
    : verifyEvidence(options.verifiedEvidence, options.expectedGenerationDigest, options.packageName, packageDigest);
  if (options.requireVerifiedEvidence && !verifiedEvidenceDigest) throw new Error("Task 4 verified evidence is required");
  return {
    generationRoot, packageDir, packageName: options.packageName,
    generationDigest: options.expectedGenerationDigest, packageDigest, files,
    ...(verifiedEvidenceDigest ? { verifiedEvidenceDigest } : {}),
  };
}
