export type MigrationMetadata = {
  folderMillis: number;
  hash: string;
  sql?: string[];
};

export type MigrationJournalRow = {
  createdAt: number;
  hash: string;
};

export type LegacyVisualSubjectSnapshot = {
  journalRows: MigrationJournalRow[];
  tables: Record<string, string[]>;
};

/** Timestamp recorded by the historical 0055 key-references migration. */
export const LEGACY_VISUAL_SUBJECT_PREVIOUS_MIGRATION_TIMESTAMP = 1783854021421;

/** Timestamp recorded by 0056, whose schema was once shipped without its journal row. */
export const LEGACY_VISUAL_SUBJECT_MIGRATION_TIMESTAMP = 1783854500000;

/** Validate exact prefix membership by repository array order, never timestamp order. */
export function validateMigrationJournal(
  rows: MigrationJournalRow[],
  migrations: MigrationMetadata[],
): void {
  if (rows.length > migrations.length) {
    throw new Error("Migration journal is ahead of this application build");
  }
  const migrationsByTimestamp = new Map<number, MigrationMetadata>();
  for (const migration of migrations) {
    if (migrationsByTimestamp.has(migration.folderMillis)) {
      throw new Error(`Duplicate migration metadata timestamp ${migration.folderMillis}`);
    }
    migrationsByTimestamp.set(migration.folderMillis, migration);
  }
  const recordedTimestamps = new Set<number>();
  for (const row of rows) {
    const timestamp = Number(row.createdAt);
    if (recordedTimestamps.has(timestamp)) {
      throw new Error(`Duplicate recorded migration timestamp ${timestamp}`);
    }
    recordedTimestamps.add(timestamp);
    const migration = migrationsByTimestamp.get(timestamp);
    if (!migration) throw new Error(`Unknown migration timestamp ${timestamp}`);
    if (row.hash !== migration.hash) throw new Error(`Migration hash mismatch at timestamp ${timestamp}`);
  }
  for (const migration of migrations.slice(0, rows.length)) {
    if (!recordedTimestamps.has(migration.folderMillis)) {
      throw new Error("Migration journal is not an exact contiguous repository prefix");
    }
  }
}

/** Select only the one documented historical schema-complete 0056 journal repair. */
export function selectLegacyVisualSubjectJournalRepair(
  snapshot: LegacyVisualSubjectSnapshot,
  migrations: MigrationMetadata[],
): MigrationMetadata | null {
  if (snapshot.journalRows.some(
    (row) => Number(row.createdAt) === LEGACY_VISUAL_SUBJECT_MIGRATION_TIMESTAMP,
  )) return null;
  if (snapshot.journalRows.length !== 56) return null;
  const latestTimestamp = Math.max(...snapshot.journalRows.map((row) => Number(row.createdAt)));
  if (latestTimestamp !== LEGACY_VISUAL_SUBJECT_PREVIOUS_MIGRATION_TIMESTAMP) return null;
  const requiredSchema: Record<string, string[]> = {
    visual_subjects: ["identity_anchors_json", "multi_angle_references_json"],
    visual_subject_versions: ["snapshot_json"],
  };
  for (const [table, requiredColumns] of Object.entries(requiredSchema)) {
    const actualColumns = snapshot.tables[table];
    if (!actualColumns || requiredColumns.some((column) => !actualColumns.includes(column))) return null;
  }
  const matchingMetadata = migrations.filter(
    (migration) => migration.folderMillis === LEGACY_VISUAL_SUBJECT_MIGRATION_TIMESTAMP,
  );
  if (matchingMetadata.length > 1) {
    throw new Error(`Duplicate migration metadata timestamp ${LEGACY_VISUAL_SUBJECT_MIGRATION_TIMESTAMP}`);
  }
  return matchingMetadata[0] ?? null;
}
