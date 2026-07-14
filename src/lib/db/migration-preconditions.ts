import type { MigrationMetadata } from "./migration-journal";

type SqliteDatabase = import("better-sqlite3").Database;

export type MigrationPreconditionRegistration = Readonly<{
  folderMillis: number;
  hash: string;
  verify: (sqlite: SqliteDatabase) => string | null;
}>;

type DuplicateOwnerRow = {
  ownerAttemptId: string;
  resourcePoolId: string;
  slotNo: number;
};

function duplicateResourceSlotOwnerEvidence(sqlite: SqliteDatabase): string | null {
  const rows = sqlite.prepare<[], DuplicateOwnerRow>(`
    SELECT
      slots.owner_attempt_id AS ownerAttemptId,
      slots.resource_pool_id AS resourcePoolId,
      slots.slot_no AS slotNo
    FROM resource_pool_slots slots
    INNER JOIN (
      SELECT owner_attempt_id
      FROM resource_pool_slots
      WHERE owner_attempt_id IS NOT NULL
      GROUP BY owner_attempt_id
      HAVING COUNT(*) > 1
    ) duplicates ON duplicates.owner_attempt_id = slots.owner_attempt_id
    ORDER BY slots.owner_attempt_id, slots.resource_pool_id, slots.slot_no
  `).all();
  if (rows.length === 0) return null;
  const byAttempt = new Map<string, DuplicateOwnerRow[]>();
  for (const row of rows) {
    const owned = byAttempt.get(row.ownerAttemptId) ?? [];
    owned.push(row);
    byAttempt.set(row.ownerAttemptId, owned);
  }
  return `0060 cannot enforce one physical resource lease per attempt; ${[...byAttempt]
    .map(([attemptId, owned]) => `attempt_id=${JSON.stringify(attemptId)} slots=[${owned
      .map((row) => `pool_id=${JSON.stringify(row.resourcePoolId)} slot_no=${row.slotNo}`)
      .join(", ")}]`)
    .join("; ")}. All leases were retained; reconcile the duplicate ownership before retrying.`;
}

export const MIGRATION_PRECONDITION_REGISTRY: readonly MigrationPreconditionRegistration[] = [
  {
    folderMillis: 1784209200000,
    hash: "f485a627f79fa40de7060254b757e8786428f9ac084c26a99f86914dbdf8c97e",
    verify: duplicateResourceSlotOwnerEvidence,
  },
] as const;

export function validateMigrationPreconditionRegistry(
  migrations: readonly Readonly<MigrationMetadata>[],
  registrations: readonly MigrationPreconditionRegistration[],
): void {
  const seen = new Set<string>();
  for (const registration of registrations) {
    const key = `${registration.folderMillis}:${registration.hash}`;
    if (seen.has(key)) throw new Error(`Duplicate migration precondition registration ${key}`);
    seen.add(key);
    const matches = migrations.filter((migration) =>
      migration.folderMillis === registration.folderMillis && migration.hash === registration.hash);
    if (matches.length !== 1) {
      throw new Error(`Migration precondition registry does not match exact migration identity ${key}`);
    }
  }
}

export function runMigrationPrecondition(
  sqlite: SqliteDatabase,
  migration: Readonly<MigrationMetadata>,
): void {
  const registration = MIGRATION_PRECONDITION_REGISTRY.find((candidate) =>
    candidate.folderMillis === migration.folderMillis && candidate.hash === migration.hash);
  if (!registration) return;
  const failure = registration.verify(sqlite);
  if (failure) throw new Error(`Migration precondition failed: ${failure}`);
}
