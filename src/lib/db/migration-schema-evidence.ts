import type { MigrationMetadata } from "./migration-journal";
import { createHash } from "node:crypto";
import {
  DATA_POSTCONDITION_REGISTRY,
  validateMigrationStatementEvidence,
  verifyDataPostconditions,
} from "./migration-data-evidence";

type SqliteDatabase = import("better-sqlite3").Database;
type ColumnSignature = { name: string; type: string; notnull: number; defaultValue: string | number | null; primaryKey: number; hidden: number };
type TableSignature = {
  definition: string;
  columns: ColumnSignature[];
  foreignKeys: Array<{ id: number; sequence: number; table: string; from: string; to: string | null; onUpdate: string; onDelete: string; match: string }>;
  checks: string[];
};
type IndexSignature = {
  table: string;
  unique: number;
  partial: number;
  columns: Array<{ sequence: number; columnId: number; name: string | null; descending: number; collation: string | null; key: number }>;
  expressionSql?: string;
};
export type SchemaInventory = {
  tables: Record<string, TableSignature>;
  indexes: Record<string, IndexSignature>;
  triggers: Record<string, string>;
  views: Record<string, string>;
};
type ManagedSchemaUniverse = { tables: Set<string>; indexes: Set<string>; triggers: Set<string>; views: Set<string> };
export type ExpectedSchemaInventories = { boundaries: SchemaInventory[]; managed: ManagedSchemaUniverse };
export type JournalLessBaselineFacts = { journalRowCount: number; appTableCount: number; readActualInventory: () => SqliteDatabase };

const SQL_KEYWORDS = new Set(["select", "from", "where", "table", "index", "trigger", "view", "group", "order", "by", "as", "on", "create", "unique", "primary", "key", "check", "references", "strict", "without", "rowid"]);

/** Collapse syntax whitespace and identifier quoting while preserving literal bytes. */
export function normalizeSqlForComparison(sql: string | null): string {
  const source = (sql ?? "").trim().replace(/;\s*$/, "");
  let output = "";
  let pendingSpace = false;
  const tight = (value: string) => /[(),=<>+*/]/.test(value);
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (/\s/.test(character)) { pendingSpace = true; index += 1; continue; }
    if (character === "'") {
      if (pendingSpace && output && !tight(output.at(-1) ?? "")) output += " ";
      pendingSpace = false;
      output += "'";
      index += 1;
      while (index < source.length) {
        output += source[index];
        if (source[index] === "'" && source[index + 1] === "'") {
          output += source[index + 1];
          index += 2;
        } else if (source[index++] === "'") break;
      }
      continue;
    }
    if (character === '"' || character === "`" || character === "[") {
      const quoteStart = index;
      const close = character === "[" ? "]" : character;
      let identifier = "";
      index += 1;
      while (index < source.length) {
        if (source[index] === close) {
          if (close !== "]" && source[index + 1] === close) {
            identifier += close;
            index += 2;
            continue;
          }
          break;
        }
        identifier += source[index++];
      }
      index += 1;
      if (pendingSpace && output && !tight(output.at(-1) ?? "")) output += " ";
      const simple = /^[a-z_][a-z0-9_]*$/i.test(identifier) && !SQL_KEYWORDS.has(identifier.toLowerCase());
      output += simple ? identifier.toLowerCase() : source.slice(quoteStart, index);
      pendingSpace = false;
      continue;
    }
    if (pendingSpace && output && !tight(output.at(-1) ?? "") && !tight(character)) output += " ";
    pendingSpace = false;
    output += character.toLowerCase();
    index += 1;
  }
  return output.trim();
}

function extractChecks(sql: string | null): string[] {
  const normalized = normalizeSqlForComparison(sql);
  const checks: string[] = [];
  const matcher = /\bcheck\(/g;
  for (let found = matcher.exec(normalized); found; found = matcher.exec(normalized)) {
    let depth = 1;
    let index = matcher.lastIndex;
    let literal = false;
    while (index < normalized.length && depth) {
      if (normalized[index] === "'") {
        if (literal && normalized[index + 1] === "'") index += 2;
        else { literal = !literal; index += 1; }
      } else {
        if (!literal && normalized[index] === "(") depth += 1;
        if (!literal && normalized[index] === ")") depth -= 1;
        index += 1;
      }
    }
    checks.push(normalized.slice(matcher.lastIndex, index - 1));
    matcher.lastIndex = index;
  }
  return checks.sort();
}

export function readSchemaInventory(sqlite: SqliteDatabase): SchemaInventory {
  const objects = sqlite.prepare<[], { type: "table" | "index" | "trigger" | "view"; name: string; sql: string | null }>(`
    SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','index','trigger','view')
    AND (type='index' OR name NOT LIKE 'sqlite_%') AND name!='__drizzle_migrations' ORDER BY type,name
  `).all();
  const result: SchemaInventory = { tables: {}, indexes: {}, triggers: {}, views: {} };
  for (const object of objects) {
    const escaped = object.name.replace(/"/g, '""');
    if (object.type === "table") {
      const columns = sqlite.prepare<[], { name: string; type: string; notnull: number; dflt_value: string | number | null; pk: number; hidden: number }>(
        `PRAGMA table_xinfo("${escaped}")`,
      ).all().map((column) => ({
        name: column.name.toLowerCase(), type: column.type.toUpperCase(), notnull: Number(column.notnull),
        defaultValue: typeof column.dflt_value === "string" ? normalizeSqlForComparison(column.dflt_value) : column.dflt_value,
        primaryKey: Number(column.pk), hidden: Number(column.hidden),
      }));
      const foreignKeys = sqlite.prepare<[], { id: number; seq: number; table: string; from: string; to: string | null; on_update: string; on_delete: string; match: string }>(
        `PRAGMA foreign_key_list("${escaped}")`,
      ).all().map((foreignKey) => ({
        id: Number(foreignKey.id), sequence: Number(foreignKey.seq), table: foreignKey.table.toLowerCase(),
        from: foreignKey.from.toLowerCase(), to: foreignKey.to?.toLowerCase() ?? null,
        onUpdate: foreignKey.on_update, onDelete: foreignKey.on_delete, match: foreignKey.match,
      }));
      result.tables[object.name.toLowerCase()] = {
        definition: normalizeSqlForComparison(object.sql), columns, foreignKeys, checks: extractChecks(object.sql),
      };
    } else if (object.type === "index") {
      const tableName = sqlite.prepare<[string], { tbl_name: string }>("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name=?").get(object.name)?.tbl_name;
      if (!tableName) continue;
      const table = tableName.replace(/"/g, '""');
      const entry = sqlite.prepare<[], { name: string; unique: number; partial: number; origin: string }>(`PRAGMA index_list("${table}")`)
        .all().find((candidate) => candidate.name === object.name);
      if (!entry) continue;
      const columns = sqlite.prepare<[], { seqno: number; cid: number; name: string | null; desc: number; coll: string | null; key: number }>(
        `PRAGMA index_xinfo("${escaped}")`,
      ).all().map((column) => ({
        sequence: Number(column.seqno), columnId: Number(column.cid), name: column.name?.toLowerCase() ?? null,
        descending: Number(column.desc), collation: column.coll?.toLowerCase() ?? null, key: Number(column.key),
      }));
      result.indexes[object.name.toLowerCase()] = {
        table: tableName.toLowerCase(), unique: Number(entry.unique), partial: Number(entry.partial), columns,
        ...(object.sql && (entry.partial || columns.some((column) => column.columnId === -2))
          ? { expressionSql: normalizeSqlForComparison(object.sql) } : {}),
      };
    } else if (object.type === "trigger" && object.sql) result.triggers[object.name.toLowerCase()] = normalizeSqlForComparison(object.sql);
    else if (object.type === "view" && object.sql) result.views[object.name.toLowerCase()] = normalizeSqlForComparison(object.sql);
  }
  return result;
}

let cache: { key: string; value: ExpectedSchemaInventories } | undefined;
function buildKey(migrations: MigrationMetadata[]): string {
  return JSON.stringify(migrations.map((migration) => [migration.folderMillis, migration.hash, migration.sql ?? []]));
}
function getExpected(migrations: MigrationMetadata[]): ExpectedSchemaInventories {
  const key = buildKey(migrations);
  if (cache?.key === key) return cache.value;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const sqlite = new Database(":memory:");
  const boundaries: SchemaInventory[] = [];
  const managed: ManagedSchemaUniverse = { tables: new Set(), indexes: new Set(), triggers: new Set(), views: new Set() };
  try {
    for (const migration of migrations) {
      if (!migration.sql) throw new Error(`Migration ${migration.folderMillis} has no SQL metadata`);
      for (const statement of migration.sql) sqlite.exec(statement);
      const inventory = readSchemaInventory(sqlite);
      boundaries.push(inventory);
      for (const kind of ["tables", "indexes", "triggers", "views"] as const) {
        Object.keys(inventory[kind]).forEach((name) => managed[kind].add(name));
      }
    }
  } finally { sqlite.close(); }
  const value = { boundaries, managed };
  cache = { key, value };
  return value;
}
export function buildExpectedSchemaInventories(migrations: MigrationMetadata[]): ExpectedSchemaInventories {
  return structuredClone(getExpected(migrations));
}
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function matches(actual: SchemaInventory, expected: SchemaInventory, managed: ManagedSchemaUniverse): boolean {
  for (const name of managed.tables) if (!equal(actual.tables[name], expected.tables[name])) return false;
  for (const name of managed.indexes) if (!equal(actual.indexes[name], expected.indexes[name])) return false;
  for (const name of managed.triggers) if (actual.triggers[name] !== expected.triggers[name]) return false;
  for (const name of managed.views) if (actual.views[name] !== expected.views[name]) return false;
  return true;
}

export function assertExactSchemaBoundary(
  sqlite: SqliteDatabase,
  migrations: MigrationMetadata[],
  boundaryCount: number,
): string {
  if (boundaryCount < 1 || boundaryCount > migrations.length) throw new Error("Invalid migration boundary");
  const expected = getExpected(migrations);
  const actual = readSchemaInventory(sqlite);
  if (!matches(actual, expected.boundaries[boundaryCount - 1], expected.managed)) {
    throw new Error(`Database does not exactly match migration boundary ${boundaryCount}`);
  }
  return createHash("sha256").update(JSON.stringify(actual)).digest("hex");
}

export function detectJournalLessBaselineMigrationCount(
  facts: JournalLessBaselineFacts,
  migrations: MigrationMetadata[],
): number {
  if (facts.journalRowCount !== 0 || facts.appTableCount === 0) return 0;
  const registrations = DATA_POSTCONDITION_REGISTRY.filter((registration) =>
    migrations.some((migration) => migration.folderMillis === registration.folderMillis));
  validateMigrationStatementEvidence(migrations, registrations);
  const expected = getExpected(migrations);
  const sqlite = facts.readActualInventory();
  const actual = readSchemaInventory(sqlite);
  for (let index = expected.boundaries.length - 1; index >= 0; index -= 1) {
    if (matches(actual, expected.boundaries[index], expected.managed)) {
      verifyDataPostconditions(sqlite, migrations, index + 1);
      return index + 1;
    }
  }
  throw new Error("Journal-less database schema does not match any complete migration boundary");
}
