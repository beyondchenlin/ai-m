import type { MigrationMetadata } from "./migration-journal";

type SqliteDatabase = import("better-sqlite3").Database;
export type DataPostcondition = (sqlite: SqliteDatabase) => string | null;
export type DataPostconditionRegistration = {
  folderMillis: number;
  hash: string;
  verify: DataPostcondition;
};

function hasRows(sqlite: SqliteDatabase, sql: string): boolean {
  return Boolean(sqlite.prepare<[], { present: number }>(sql).get());
}

export const DATA_POSTCONDITION_REGISTRY: readonly DataPostconditionRegistration[] = [
  {
    folderMillis: 1774200000000,
    hash: "de8d5d9b62a62131b4f0892fe5f91523e0c25e257909a918a1e965ab11be133f",
    verify: (sqlite) => hasRows(sqlite, `SELECT 1 present FROM projects
      UNION ALL SELECT 1 FROM shots UNION ALL SELECT 1 FROM storyboard_versions LIMIT 1`)
      ? "0007 copied randomized storyboard-version data and is operator-only for nonempty databases" : null,
  },
  {
    folderMillis: 1774500000000,
    hash: "72c80bf5c0721d2886dbc07f6dfa3ca07694b58021f32cdfa25a2eff4f17e042",
    verify: (sqlite) => hasRows(sqlite, `SELECT 1 present FROM projects
      UNION ALL SELECT 1 FROM episodes UNION ALL SELECT 1 FROM shots
      UNION ALL SELECT 1 FROM storyboard_versions UNION ALL SELECT 1 FROM tasks LIMIT 1`)
      ? "0010 copied randomized episode data and is operator-only for nonempty databases" : null,
  },
  {
    folderMillis: 1783950000000,
    hash: "698bc1e043bb15c4ff1026535f08e6bcbf5eec32280b22ffd22938e8e4147b83",
    // Selected current safety invariants, not proof of literal historical DML provenance.
    verify: (sqlite) => hasRows(sqlite, `SELECT 1 present FROM workflow_package_states s
      JOIN workflow_package_revisions r ON r.digest=s.workflow_package_digest
      WHERE r.workflow_api_json='{}' AND (s.state<>'invalid' OR
      s.validation_report_json<>json_array('PR-12 requires re-importing a real workflow.api.json package')) LIMIT 1`)
      || hasRows(sqlite, "SELECT 1 present FROM generation_artifacts WHERE updated_at_ms=0 LIMIT 1")
      || hasRows(sqlite, `SELECT 1 present FROM business_task_generation_jobs
        GROUP BY generation_job_id HAVING COUNT(*)>1 LIMIT 1`)
      || hasRows(sqlite, `SELECT 1 present FROM generation_profile_states s
        JOIN generation_profile_revisions r ON r.id=s.generation_profile_revision_id
        WHERE r.adapter_kind IN ('zimage','local-speech') AND
        (s.enabled<>0 OR s.visibility<>'admin') LIMIT 1`)
      || hasRows(sqlite, `SELECT 1 present FROM default_generation_profile_pointers p
        JOIN generation_profile_revisions r ON r.id=p.generation_profile_revision_id
        WHERE r.adapter_kind IN ('zimage','local-speech') LIMIT 1`)
      ? "0057 platform-hardening safety postconditions are incomplete" : null,
  },
  {
    folderMillis: 1784036400000,
    hash: "a89bf74586f7cc217f73a2440893e8532e04d3fd17c12dce1886b3a80b4c6019",
    verify: () => "0058 dropped its copy source; copy provenance is never independently provable",
  },
] as const;

/** Return the outer statement kind, ignoring comments, quoted bytes, and trigger bodies. */
export function topLevelStatementKind(sql: string): string {
  const tokens: Array<{ value: string; depth: number }> = [];
  let depth = 0;
  for (let index = 0; index < sql.length;) {
    if (sql.startsWith("--", index)) {
      index = sql.indexOf("\n", index + 2);
      if (index < 0) break;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      index = end < 0 ? sql.length : end + 2;
      continue;
    }
    const character = sql[index];
    if (character === "'" || character === '"' || character === "`" || character === "[") {
      const close = character === "[" ? "]" : character;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === close) {
          if (close !== "]" && sql[index + 1] === close) index += 2;
          else { index += 1; break; }
        } else index += 1;
      }
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (/[a-z_]/i.test(character)) {
      const match = /^[a-z_][a-z0-9_]*/i.exec(sql.slice(index));
      if (match) {
        tokens.push({ value: match[0].toUpperCase(), depth });
        index += match[0].length;
        continue;
      }
    }
    index += 1;
  }
  const first = tokens.find((token) => token.depth === 0)?.value ?? "";
  if (first !== "WITH") return first;
  return tokens.find((token) => token.depth === 0
    && ["INSERT", "UPDATE", "DELETE", "REPLACE"].includes(token.value))?.value ?? "WITH";
}

function migrationsWithDml(migrations: MigrationMetadata[]): MigrationMetadata[] {
  return migrations.filter((migration) => (migration.sql ?? []).flatMap(splitSqlStatements).some((statement) =>
    ["INSERT", "UPDATE", "DELETE", "REPLACE"].includes(topLevelStatementKind(statement))));
}

/** Split SQL without treating semicolons in strings/comments/trigger bodies as boundaries. */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let firstWords: string[] = [];
  let lastWord = "";
  let trigger = false;
  let triggerBlockDepth = 0;
  for (let index = 0; index < sql.length;) {
    if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index + 2);
      index = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      index = end < 0 ? sql.length : end + 2;
      continue;
    }
    const character = sql[index];
    if (character === "'" || character === '"' || character === "`" || character === "[") {
      const close = character === "[" ? "]" : character;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === close) {
          if (close !== "]" && sql[index + 1] === close) index += 2;
          else { index += 1; break; }
        } else index += 1;
      }
      continue;
    }
    if (/[a-z_]/i.test(character)) {
      const word = /^[a-z_][a-z0-9_]*/i.exec(sql.slice(index))?.[0] ?? "";
      lastWord = word.toUpperCase();
      if (firstWords.length < 3) firstWords.push(lastWord);
      trigger = firstWords[0] === "CREATE" && firstWords.includes("TRIGGER");
      if (trigger && (lastWord === "BEGIN" || lastWord === "CASE")) triggerBlockDepth += 1;
      if (trigger && lastWord === "END") triggerBlockDepth -= 1;
      index += word.length;
      continue;
    }
    if (character === ";" && (!trigger || triggerBlockDepth === 0)) {
      const statement = sql.slice(start, index).trim();
      if (statement) statements.push(statement);
      start = index + 1;
      firstWords = [];
      lastWord = "";
      trigger = false;
      triggerBlockDepth = 0;
    }
    index += 1;
  }
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

export function validateMigrationStatementEvidence(
  migrations: MigrationMetadata[],
  registrations: readonly DataPostconditionRegistration[],
): void {
  validateDataPostconditionRegistry(migrations, registrations);
  for (const migration of migrations) {
    for (const statement of (migration.sql ?? []).flatMap(splitSqlStatements)) {
      const kind = topLevelStatementKind(statement);
      if (["INSERT", "UPDATE", "DELETE", "REPLACE"].includes(kind)) continue;
      if (kind === "CREATE") {
        const normalized = statement.replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, "").toUpperCase();
        if (/^CREATE\s+(?:TEMP\s+)?VIRTUAL\s+TABLE\b/.test(normalized)
          || /^CREATE\s+(?:TEMP\s+)?TABLE\b[\s\S]*\bAS\s+SELECT\b/.test(normalized)) {
          throw new Error(`Migration ${migration.folderMillis} uses data-bearing CREATE without independent evidence`);
        }
        continue;
      }
      if (["ALTER", "DROP"].includes(kind)) continue;
      throw new Error(`Migration ${migration.folderMillis} contains unsupported state-changing or ambiguous SQL: ${kind || "UNKNOWN"}`);
    }
  }
}

export function validateDataPostconditionRegistry(
  migrations: MigrationMetadata[],
  registrations: readonly DataPostconditionRegistration[],
): void {
  const registrationKeys = new Set<string>();
  for (const registration of registrations) {
    const key = `${registration.folderMillis}:${registration.hash}`;
    if (registrationKeys.has(key)) throw new Error(`Duplicate DML postcondition registration ${key}`);
    registrationKeys.add(key);
  }
  const detectedKeys = new Set(migrationsWithDml(migrations)
    .map((migration) => `${migration.folderMillis}:${migration.hash}`));
  if (detectedKeys.size !== registrationKeys.size
    || [...detectedKeys].some((key) => !registrationKeys.has(key))) {
    throw new Error("DML postcondition registry does not exactly match detected migration DML");
  }
}

export function runDataPostconditionReadOnly(
  sqlite: SqliteDatabase,
  registration: DataPostconditionRegistration,
): string | null {
  const previous = Number(sqlite.pragma("query_only", { simple: true }));
  sqlite.pragma("query_only = ON");
  try { return registration.verify(sqlite); }
  finally { sqlite.pragma(`query_only = ${previous ? "ON" : "OFF"}`); }
}

export function verifyDataPostconditions(
  sqlite: SqliteDatabase,
  migrations: MigrationMetadata[],
  boundaryCount: number,
): void {
  const relevant = DATA_POSTCONDITION_REGISTRY.filter((registration) =>
    migrations.some((migration) => migration.folderMillis === registration.folderMillis));
  validateMigrationStatementEvidence(migrations, relevant);
  for (const migration of migrationsWithDml(migrations.slice(0, boundaryCount))) {
    const registration = DATA_POSTCONDITION_REGISTRY.find((candidate) =>
      candidate.folderMillis === migration.folderMillis && candidate.hash === migration.hash);
    if (!registration) throw new Error(`Journal-less recovery requires operator action: unregistered DML ${migration.folderMillis}`);
    const failure = runDataPostconditionReadOnly(sqlite, registration);
    if (failure) throw new Error(`Journal-less recovery requires an operator action: ${failure}`);
  }
}
