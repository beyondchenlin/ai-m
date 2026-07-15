import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalize } from "../src/lib/generation/workflows/canonical";

export const PIXELLE_GC_AUDIT_KEY_PATH = path.join(os.homedir(), ".ai-m", "trust", "pixelle-gc-audit-hmac.key");

export interface GcAuditPayload {
  actor: string;
  generationDigest: string;
  packageDigests: Record<string, string>;
  currentGenerationDigest: string;
  quarantinedBytes: number;
  quarantineName: string;
  reviewedAtMs: number;
}

interface AuditOptions { stagingDir: string; auditKey?: Buffer }

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalize(value)}\n`, "utf8");
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}
function signature(value: unknown, key: Buffer): string {
  return createHmac("sha256", key).update(canonicalize(value)).digest("hex");
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
async function keyFor(value?: Buffer): Promise<Buffer> {
  const key = value ?? await fs.readFile(PIXELLE_GC_AUDIT_KEY_PATH);
  if (key.length < 32 || key.length > 1024) throw new Error("GC audit trust key is invalid");
  return key;
}
function verifyHmac(actual: unknown, signed: unknown, key: Buffer): void {
  if (typeof actual !== "string" || !/^[a-f0-9]{64}$/.test(actual)) throw new Error("GC audit signature is invalid");
  const expected = Buffer.from(signature(signed, key), "hex");
  if (!timingSafeEqual(Buffer.from(actual, "hex"), expected)) throw new Error("GC audit signature verification failed");
}
async function readCanonical(file: string): Promise<Record<string, unknown>> {
  const bytes = await fs.readFile(file);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("GC audit JSON is invalid"); }
  if (!isRecord(value) || !bytes.equals(jsonBytes(value))) throw new Error("GC audit bytes are non-canonical or tampered");
  return value;
}
async function syncFile(file: string): Promise<void> {
  const handle = await fs.open(file, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function verifyPixelleGcAuditChain(options: AuditOptions): Promise<{ valid: true; entries: number; lastDigest: string | null }> {
  const key = await keyFor(options.auditKey);
  const auditDir = path.join(path.resolve(options.stagingDir), "audit");
  try {
    const stat = await fs.lstat(auditDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("GC audit directory is unsafe");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { valid: true, entries: 0, lastDigest: null };
    throw error;
  }
  const names = await fs.readdir(auditDir);
  const entries = names.filter((name) => /^gc-\d{8}-[a-f0-9]{32}\.json$/.test(name)).sort();
  const unknown = names.filter((name) => name !== "head.json" && !entries.includes(name));
  if (unknown.length) throw new Error(`GC audit directory has unfamiliar content: ${unknown.join(", ")}`);
  if (!names.includes("head.json")) {
    if (entries.length) throw new Error("GC audit chain is truncated: head is missing");
    return { valid: true, entries: 0, lastDigest: null };
  }
  let previousDigest: string | null = null;
  for (let index = 0; index < entries.length; index += 1) {
    const value = await readCanonical(path.join(auditDir, entries[index]));
    const { signature: actualSignature, entryDigest, ...payload } = value;
    if (payload.schemaVersion !== 1 || payload.sequence !== index + 1 || payload.previousDigest !== previousDigest) throw new Error("GC audit hash chain is broken");
    const expectedDigest = digest(payload);
    if (entryDigest !== expectedDigest) throw new Error("GC audit entry digest is invalid");
    verifyHmac(actualSignature, { ...payload, entryDigest }, key);
    previousDigest = expectedDigest;
  }
  const head = await readCanonical(path.join(auditDir, "head.json"));
  const { signature: headSignature, ...headPayload } = head;
  if (headPayload.schemaVersion !== 1 || headPayload.count !== entries.length || headPayload.lastDigest !== previousDigest) {
    throw new Error("GC audit head detects truncation or reordering");
  }
  verifyHmac(headSignature, headPayload, key);
  return { valid: true, entries: entries.length, lastDigest: previousDigest };
}

export async function appendPixelleGcAudit(options: AuditOptions & { payload: GcAuditPayload }): Promise<{ auditFile: string; entryDigest: string }> {
  const key = await keyFor(options.auditKey);
  const state = await verifyPixelleGcAuditChain({ stagingDir: options.stagingDir, auditKey: key });
  const auditDir = path.join(path.resolve(options.stagingDir), "audit");
  try { await fs.mkdir(auditDir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const sequence = state.entries + 1;
  const payload = {
    schemaVersion: 1, sequence, previousDigest: state.lastDigest,
    action: "quarantine-non-current-generation", producer: "ai-m/pixelle-single-backend", ...options.payload,
  };
  const entryDigest = digest(payload);
  const entry = { ...payload, entryDigest, signature: signature({ ...payload, entryDigest }, key) };
  const token = randomBytes(16).toString("hex");
  const auditFile = `gc-${String(sequence).padStart(8, "0")}-${token}.json`;
  const entryPath = path.join(auditDir, auditFile);
  await fs.writeFile(entryPath, jsonBytes(entry), { flag: "wx" });
  await syncFile(entryPath);
  const headPayload = { schemaVersion: 1, count: sequence, lastDigest: entryDigest };
  const head = { ...headPayload, signature: signature(headPayload, key) };
  const headTemp = path.join(auditDir, `head.${token}.tmp`);
  await fs.writeFile(headTemp, jsonBytes(head), { flag: "wx" });
  await syncFile(headTemp);
  await fs.rename(headTemp, path.join(auditDir, "head.json"));
  return { auditFile, entryDigest };
}
