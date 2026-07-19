import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { canonicalize } from "../src/lib/generation/workflows/canonical";

const PROTECTED_TABLES = [
  "audit_events",
  "generation_artifacts",
  "generation_attempts",
  "generation_events",
  "generation_jobs",
  "job_input_artifacts",
  "operational_alerts",
  "resource_pool_slots",
  "resource_reconciliation_proofs",
  "source_asset_quota_reservations",
  "source_media_assets",
  "trusted_proxy_nonces",
  "voice_profiles",
  "workflow_package_approvals",
  "workflow_package_revisions",
] as const;

type ProtectedTable = typeof PROTECTED_TABLES[number];

type ProtectedFile = {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
};

export interface RollbackPreservationManifest {
  schemaVersion: 2;
  producer: "ai-m/rollback-preservation-v2";
  candidateSha: string;
  capturedAtMs: number;
  migrationJournal: Array<{ createdAt: number; hash: string }>;
  tables: Record<ProtectedTable, {
    columns: string[];
    primaryKeyColumns: string[];
    rows: Array<{ identity: string; digest: string }>;
  }>;
  artifactFiles: ProtectedFile[];
  contentDigest: string;
}

function contentDigest(value: Omit<RollbackPreservationManifest, "contentDigest">): string {
  return createHash("sha256").update(Buffer.from(canonicalize(value), "utf8")).digest("hex");
}

function validateSha(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{7,64}$/.test(normalized)) throw new Error("candidateSha must be a Git hexadecimal SHA");
  return normalized;
}

function safeIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(value)) throw new Error("Unsafe SQLite identifier");
  return `"${value}"`;
}

function encodeSqliteValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Protected rollback row contains a non-finite number");
    return value;
  }
  if (typeof value === "bigint") return { type: "integer", value: value.toString(10) };
  if (Buffer.isBuffer(value)) return { type: "blob", sha256: createHash("sha256").update(value).digest("hex"), sizeBytes: value.byteLength };
  throw new Error("Protected rollback row contains an unsupported SQLite value");
}

function readDatabaseSnapshot(databasePath: string) {
  const sqlite = new Database(path.resolve(databasePath), { readonly: true, fileMustExist: true });
  try {
    if (sqlite.pragma("integrity_check", { simple: true }) !== "ok") {
      throw new Error("Rollback database integrity_check failed");
    }
    const migrationJournal = sqlite.prepare<[], { createdAt: number; hash: string }>(
      'SELECT created_at AS createdAt, hash FROM "__drizzle_migrations" ORDER BY rowid',
    ).all();
    const tables = {} as RollbackPreservationManifest["tables"];
    for (const table of PROTECTED_TABLES) {
      const exists = sqlite.prepare<[string], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      ).get(table);
      if (!exists) throw new Error(`Protected rollback table is missing: ${table}`);
      const columnInfo = sqlite.prepare<[], { name: string; pk: number }>(`PRAGMA table_info(${safeIdentifier(table)})`).all();
      const columns = columnInfo.map((column) => column.name).sort();
      const primaryKeyColumns = columnInfo.filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk).map((column) => column.name);
      if (!primaryKeyColumns.length) throw new Error(`Protected rollback table lacks a stable primary key: ${table}`);
      const rows = (sqlite.prepare(`SELECT * FROM ${safeIdentifier(table)}`).all() as Array<Record<string, unknown>>)
        .map((row) => {
          const encoded = Object.fromEntries(columns.map((column) => [column, encodeSqliteValue(row[column])]));
          const identity = canonicalize(Object.fromEntries(primaryKeyColumns.map((column) => [column, encoded[column]])));
          return { identity, digest: createHash("sha256").update(canonicalize(encoded)).digest("hex") };
        })
        .sort((left, right) => left.identity.localeCompare(right.identity));
      if (new Set(rows.map((row) => row.identity)).size !== rows.length) {
        throw new Error(`Protected rollback table has duplicate primary-key identities: ${table}`);
      }
      tables[table] = { columns, primaryKeyColumns, rows };
    }
    return { migrationJournal, tables };
  } finally {
    sqlite.close();
  }
}

async function hashStableFile(root: string, absolute: string): Promise<ProtectedFile> {
  const relativePath = path.relative(root, absolute).split(path.sep).join("/");
  if (!relativePath || relativePath.startsWith("../")) throw new Error("Artifact escapes rollback root");
  const handle = await fs.open(absolute, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Rollback artifact is not a regular file");
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      const bytes = chunk as Buffer;
      hash.update(bytes);
      sizeBytes += bytes.byteLength;
    }
    const after = await handle.stat();
    const pathAfter = await fs.stat(absolute);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.dev !== pathAfter.dev
      || before.ino !== pathAfter.ino || sizeBytes !== before.size) {
      throw new Error("Rollback artifact changed during snapshot");
    }
    return { relativePath, sizeBytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function enumerateArtifacts(rootInput: string): Promise<ProtectedFile[]> {
  const root = path.resolve(rootInput);
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(root) !== root) {
    throw new Error("Rollback artifact root must be a canonical regular directory");
  }
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const entryStat = await fs.lstat(absolute);
      if (entryStat.isSymbolicLink()) throw new Error("Rollback artifact root contains a link or reparse point");
      if (entryStat.isDirectory()) await walk(absolute);
      else if (entryStat.isFile()) files.push(absolute);
      else throw new Error("Rollback artifact root contains an unsupported entry");
    }
  }
  await walk(root);
  return Promise.all(files.map((file) => hashStableFile(root, file)));
}

function parseManifest(value: unknown): RollbackPreservationManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Rollback manifest is invalid");
  const manifest = value as Partial<RollbackPreservationManifest>;
  if (manifest.schemaVersion !== 2 || manifest.producer !== "ai-m/rollback-preservation-v2"
    || !Number.isSafeInteger(manifest.capturedAtMs) || !Array.isArray(manifest.migrationJournal)
    || !manifest.tables || typeof manifest.tables !== "object" || !Array.isArray(manifest.artifactFiles)
    || typeof manifest.contentDigest !== "string") {
    throw new Error("Rollback manifest contract is invalid");
  }
  validateSha(String(manifest.candidateSha));
  const unsigned = { ...manifest } as Partial<RollbackPreservationManifest>;
  delete unsigned.contentDigest;
  if (manifest.contentDigest !== contentDigest(unsigned as Omit<RollbackPreservationManifest, "contentDigest">)) {
    throw new Error("Rollback manifest digest is invalid");
  }
  return manifest as RollbackPreservationManifest;
}

export async function captureRollbackPreservation(input: {
  databasePath: string;
  artifactRoot: string;
  manifestPath: string;
  candidateSha: string;
  nowMs?: number;
}): Promise<RollbackPreservationManifest> {
  const database = readDatabaseSnapshot(input.databasePath);
  const unsigned: Omit<RollbackPreservationManifest, "contentDigest"> = {
    schemaVersion: 2,
    producer: "ai-m/rollback-preservation-v2",
    candidateSha: validateSha(input.candidateSha),
    capturedAtMs: input.nowMs ?? Date.now(),
    migrationJournal: database.migrationJournal,
    tables: database.tables,
    artifactFiles: await enumerateArtifacts(input.artifactRoot),
  };
  const manifest = { ...unsigned, contentDigest: contentDigest(unsigned) };
  const manifestPath = path.resolve(input.manifestPath);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${canonicalize(manifest)}\n`, { flag: "wx", mode: 0o600 });
  return manifest;
}

export async function verifyRollbackPreservation(input: {
  databasePath: string;
  artifactRoot: string;
  manifestPath: string;
}): Promise<{
  status: "ROLLBACK_PRESERVATION_PASSED";
  candidateSha: string;
  protectedTableCount: number;
  protectedArtifactCount: number;
}> {
  const bytes = await fs.readFile(path.resolve(input.manifestPath));
  if (bytes.byteLength > 16 * 1024 * 1024) throw new Error("Rollback manifest is too large");
  const manifest = parseManifest(JSON.parse(bytes.toString("utf8")) as unknown);
  const current = readDatabaseSnapshot(input.databasePath);
  if (canonicalize(current.migrationJournal) !== canonicalize(manifest.migrationJournal)) {
    throw new Error("Rollback changed the migration journal; down-migration is forbidden");
  }
  for (const table of PROTECTED_TABLES) {
    const baseline = manifest.tables[table];
    const actual = current.tables[table];
    if (!baseline || !actual) throw new Error(`Protected rollback table is missing: ${table}`);
    if (baseline.columns.some((column) => !actual.columns.includes(column))) {
      throw new Error(`Rollback removed protected columns from ${table}`);
    }
    if (canonicalize(actual.primaryKeyColumns) !== canonicalize(baseline.primaryKeyColumns)) {
      throw new Error(`Rollback changed the protected primary key for ${table}`);
    }
    const actualRows = new Map(actual.rows.map((row) => [row.identity, row.digest]));
    for (const row of baseline.rows) {
      if (actualRows.get(row.identity) !== row.digest) {
        throw new Error(`Rollback changed or deleted a protected row from ${table}`);
      }
    }
  }
  const currentFiles = new Map((await enumerateArtifacts(input.artifactRoot))
    .map((file) => [file.relativePath, file]));
  for (const baseline of manifest.artifactFiles) {
    const actual = currentFiles.get(baseline.relativePath);
    if (!actual || actual.sizeBytes !== baseline.sizeBytes || actual.sha256 !== baseline.sha256) {
      throw new Error(`Rollback changed or deleted a protected artifact: ${baseline.relativePath}`);
    }
  }
  return {
    status: "ROLLBACK_PRESERVATION_PASSED",
    candidateSha: manifest.candidateSha,
    protectedTableCount: PROTECTED_TABLES.length,
    protectedArtifactCount: manifest.artifactFiles.length,
  };
}
