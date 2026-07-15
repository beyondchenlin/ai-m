import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { canonicalize } from "../src/lib/generation/workflows/canonical";
import { loadProductionPixelleAuditKey, PIXELLE_TRUST_PATHS } from "./pixelle-trust-store";

export const PIXELLE_GC_AUDIT_KEY_PATH = PIXELLE_TRUST_PATHS.auditKey;
type Phase = "intent" | "committed";

export interface GcAuditPayload {
  actor: string;
  generationDigest: string;
  packageDigests: Record<string, string>;
  currentGenerationDigest: string;
  quarantinedBytes: number;
  quarantineName: string;
  reviewedAtMs: number;
}

export interface GcAnchorEvent {
  phase: Phase;
  transactionId: string;
  sequence: number;
  payload: GcAuditPayload;
  previousFileDigest: string | null;
  fileEntryDigest: string | null;
  createdAtMs: number;
}

type SqliteLike = {
  prepare: (sql: string) => { get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[]; run: (...args: unknown[]) => unknown };
  transaction: (callback: () => void) => { immediate: () => void };
};

function parseAnchorDetails(value: unknown): GcAnchorEvent {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { throw new Error("Pixelle GC database anchor JSON is invalid"); }
  }
  if (!isRecord(parsed) || !["intent", "committed"].includes(String(parsed.phase))
    || typeof parsed.transactionId !== "string" || !/^[a-f0-9]{32}$/.test(parsed.transactionId)
    || !Number.isSafeInteger(parsed.sequence) || !isRecord(parsed.payload)
    || !(parsed.previousFileDigest === null || typeof parsed.previousFileDigest === "string")
    || !(parsed.fileEntryDigest === null || typeof parsed.fileEntryDigest === "string")
    || !Number.isSafeInteger(parsed.createdAtMs)) throw new Error("Pixelle GC database anchor contract is invalid");
  return parsed as unknown as GcAnchorEvent;
}

export class SqlitePixelleGcAuditAnchor {
  private readonly sqlite: SqliteLike;
  constructor(sqlite: unknown) { this.sqlite = sqlite as SqliteLike; }

  private assertAvailable(): void {
    const row = this.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_events'").get() as { name?: string } | undefined;
    if (row?.name !== "audit_events") throw new Error("audit_events database anchor is unavailable; refusing quarantine");
  }

  list(): GcAnchorEvent[] {
    this.assertAvailable();
    const rows = this.sqlite.prepare("SELECT details_safe_json AS details FROM audit_events WHERE action IN ('pixelle.gc.quarantine.intent','pixelle.gc.quarantine.committed') ORDER BY rowid").all() as Array<{ details: unknown }>;
    const events = rows.map((row) => parseAnchorDetails(row.details));
    const intents = events.filter((event) => event.phase === "intent");
    for (let index = 0; index < intents.length; index += 1) {
      if (intents[index].sequence !== index + 1) throw new Error("Pixelle GC database anchor monotonic sequence is broken");
    }
    for (const event of events.filter((candidate) => candidate.phase === "committed")) {
      const intent = intents.find((candidate) => candidate.transactionId === event.transactionId);
      if (!intent || intent.sequence !== event.sequence || canonicalize(intent.payload) !== canonicalize(event.payload)) {
        throw new Error("Pixelle GC database committed anchor has no matching intent");
      }
    }
    return events;
  }

  begin(payload: GcAuditPayload, previousFileDigest: string | null, transactionId: string, nowMs = Date.now()): GcAnchorEvent {
    let result!: GcAnchorEvent;
    this.sqlite.transaction(() => {
      const events = this.list();
      const pending = events.filter((event) => event.phase === "intent" && !events.some((candidate) => candidate.phase === "committed" && candidate.transactionId === event.transactionId));
      if (pending.length > 1) throw new Error("Multiple pending Pixelle GC database intents require manual recovery");
      if (pending.length === 1) {
        if (pending[0].payload.generationDigest !== payload.generationDigest || canonicalize(pending[0].payload.packageDigests) !== canonicalize(payload.packageDigests)) {
          throw new Error("A different Pixelle GC database intent is pending recovery");
        }
        result = pending[0];
        return;
      }
      result = { phase: "intent", transactionId, sequence: events.filter((event) => event.phase === "intent").length + 1, payload, previousFileDigest, fileEntryDigest: null, createdAtMs: nowMs };
      this.sqlite.prepare("INSERT INTO audit_events (id,actor_id,action,target_type,target_id,details_safe_json,created_at_ms) VALUES (?,?,?,?,?,?,?)")
        .run(`pixelle-gc:${transactionId}:intent`, payload.actor, "pixelle.gc.quarantine.intent", "pixelle_workflow_generation", payload.generationDigest, canonicalize(result), nowMs);
    }).immediate();
    return result;
  }

  commit(intent: GcAnchorEvent, fileEntryDigest: string, nowMs = Date.now()): GcAnchorEvent {
    let result!: GcAnchorEvent;
    this.sqlite.transaction(() => {
      const events = this.list();
      const existing = events.find((event) => event.phase === "committed" && event.transactionId === intent.transactionId);
      if (existing) {
        if (existing.fileEntryDigest !== fileEntryDigest) throw new Error("Pixelle GC database committed anchor digest conflicts with signed audit");
        result = existing;
        return;
      }
      result = { ...intent, phase: "committed", fileEntryDigest, createdAtMs: nowMs };
      this.sqlite.prepare("INSERT INTO audit_events (id,actor_id,action,target_type,target_id,details_safe_json,created_at_ms) VALUES (?,?,?,?,?,?,?)")
        .run(`pixelle-gc:${intent.transactionId}:committed`, intent.payload.actor, "pixelle.gc.quarantine.committed", "pixelle_workflow_generation", intent.payload.generationDigest, canonicalize(result), nowMs);
    }).immediate();
    return result;
  }
}

export async function productionPixelleGcAuditAnchor(): Promise<SqlitePixelleGcAuditAnchor> {
  try {
    const { getSqlite } = await import("../src/lib/db");
    return new SqlitePixelleGcAuditAnchor(getSqlite() as unknown as SqliteLike);
  } catch (error) {
    throw new Error("audit_events database anchor is unavailable; refusing quarantine", { cause: error });
  }
}

export interface AuditOptions { stagingDir: string; auditKey?: Buffer; auditAnchor?: SqlitePixelleGcAuditAnchor }
type FileEntry = GcAuditPayload & { schemaVersion: 2; sequence: number; previousDigest: string | null; phase: Phase; transactionId: string; producer: string; entryDigest: string; signature: string };

function jsonBytes(value: unknown): Buffer { return Buffer.from(`${canonicalize(value)}\n`, "utf8"); }
function digest(value: unknown): string { return createHash("sha256").update(canonicalize(value)).digest("hex"); }
function signature(value: unknown, key: Buffer): string { return createHmac("sha256", key).update(canonicalize(value)).digest("hex"); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
async function keyFor(value?: Buffer): Promise<Buffer> {
  const key = value ?? await loadProductionPixelleAuditKey();
  if (key.length !== 32) throw new Error("GC audit trust key must be exactly 32 bytes");
  return key;
}
function verifyHmac(actual: unknown, signed: unknown, key: Buffer): void {
  if (typeof actual !== "string" || !/^[a-f0-9]{64}$/.test(actual)) throw new Error("GC audit signature is invalid");
  const expected = Buffer.from(signature(signed, key), "hex");
  if (!timingSafeEqual(Buffer.from(actual, "hex"), expected)) throw new Error("GC audit signature verification failed");
}
async function readCanonical(file: string): Promise<Record<string, unknown>> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("GC audit entry must be a bounded regular no-link file");
  const bytes = await fs.readFile(file);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("GC audit JSON is invalid"); }
  if (!isRecord(value) || !bytes.equals(jsonBytes(value))) throw new Error("GC audit bytes are non-canonical or tampered");
  return value;
}
async function syncFile(file: string): Promise<void> { const handle = await fs.open(file, "r+"); try { await handle.sync(); } finally { await handle.close(); } }

async function inspectChain(options: Omit<AuditOptions, "auditAnchor">): Promise<{ entries: FileEntry[]; lastDigest: string | null }> {
  const key = await keyFor(options.auditKey);
  const auditDir = path.join(path.resolve(options.stagingDir), "audit");
  try {
    const stat = await fs.lstat(auditDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("GC audit directory is unsafe");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], lastDigest: null };
    throw error;
  }
  const names = await fs.readdir(auditDir);
  const files = names.filter((name) => /^gc-\d{8}-[a-f0-9]{32}\.json$/.test(name)).sort();
  const unknown = names.filter((name) => name !== "head.json" && !files.includes(name));
  if (unknown.length) throw new Error(`GC audit directory has unfamiliar content: ${unknown.join(", ")}`);
  if (!names.includes("head.json")) {
    if (files.length) throw new Error("GC audit chain is truncated: head is missing");
    return { entries: [], lastDigest: null };
  }
  const entries: FileEntry[] = [];
  let previousDigest: string | null = null;
  for (let index = 0; index < files.length; index += 1) {
    const value = await readCanonical(path.join(auditDir, files[index]));
    const { signature: actualSignature, entryDigest, ...payload } = value;
    if (payload.schemaVersion !== 2 || payload.sequence !== index + 1 || payload.previousDigest !== previousDigest
      || !["intent", "committed"].includes(String(payload.phase)) || typeof payload.transactionId !== "string") throw new Error("GC audit hash chain is broken");
    const expectedDigest = digest(payload);
    if (entryDigest !== expectedDigest) throw new Error("GC audit entry digest is invalid");
    verifyHmac(actualSignature, { ...payload, entryDigest }, key);
    previousDigest = expectedDigest;
    entries.push(value as unknown as FileEntry);
  }
  const head = await readCanonical(path.join(auditDir, "head.json"));
  const { signature: headSignature, ...headPayload } = head;
  if (headPayload.schemaVersion !== 2 || headPayload.count !== entries.length || headPayload.lastDigest !== previousDigest) throw new Error("GC audit head detects truncation or reordering");
  verifyHmac(headSignature, headPayload, key);
  return { entries, lastDigest: previousDigest };
}

export async function verifyPixelleGcAuditChain(options: AuditOptions): Promise<{ valid: true; entries: number; lastDigest: string | null }> {
  const chain = await inspectChain(options);
  if (options.auditAnchor) {
    const anchors = options.auditAnchor.list();
    for (const anchor of anchors) {
      const entry = chain.entries.find((candidate) => candidate.transactionId === anchor.transactionId && candidate.phase === anchor.phase);
      if (!entry) throw new Error("GC signed chain rollback conflicts with the database anchor");
      if (anchor.phase === "intent" && entry.previousDigest !== anchor.previousFileDigest) throw new Error("GC intent previous digest conflicts with database anchor");
      if (anchor.phase === "committed" && entry.entryDigest !== anchor.fileEntryDigest) throw new Error("GC committed digest conflicts with database anchor");
    }
  }
  return { valid: true, entries: chain.entries.length, lastDigest: chain.lastDigest };
}

export async function getPixelleGcAuditEntries(options: Omit<AuditOptions, "auditAnchor">): Promise<ReadonlyArray<FileEntry>> {
  return (await inspectChain(options)).entries;
}

export async function appendPixelleGcAudit(options: Omit<AuditOptions, "auditAnchor"> & { payload: GcAuditPayload; phase: Phase; transactionId: string }): Promise<{ auditFile: string; entryDigest: string }> {
  const key = await keyFor(options.auditKey);
  const state = await inspectChain(options);
  const existing = state.entries.find((entry) => entry.transactionId === options.transactionId && entry.phase === options.phase);
  if (existing) return { auditFile: "existing", entryDigest: existing.entryDigest };
  const auditDir = path.join(path.resolve(options.stagingDir), "audit");
  try { await fs.mkdir(auditDir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const sequence = state.entries.length + 1;
  const payload = { schemaVersion: 2, sequence, previousDigest: state.lastDigest, phase: options.phase, transactionId: options.transactionId, producer: "ai-m/pixelle-single-backend", ...options.payload };
  const entryDigest = digest(payload);
  const entry = { ...payload, entryDigest, signature: signature({ ...payload, entryDigest }, key) };
  const token = randomBytes(16).toString("hex");
  const auditFile = `gc-${String(sequence).padStart(8, "0")}-${token}.json`;
  const entryPath = path.join(auditDir, auditFile);
  await fs.writeFile(entryPath, jsonBytes(entry), { flag: "wx" });
  await syncFile(entryPath);
  const headPayload = { schemaVersion: 2, count: sequence, lastDigest: entryDigest };
  const headTemp = path.join(auditDir, `head.${token}.tmp`);
  await fs.writeFile(headTemp, jsonBytes({ ...headPayload, signature: signature(headPayload, key) }), { flag: "wx" });
  await syncFile(headTemp);
  await fs.rename(headTemp, path.join(auditDir, "head.json"));
  return { auditFile, entryDigest };
}
