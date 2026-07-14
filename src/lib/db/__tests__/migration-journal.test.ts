import { describe, expect, it } from "vitest";
import {
  LEGACY_VISUAL_SUBJECT_MIGRATION_TIMESTAMP,
  LEGACY_VISUAL_SUBJECT_PREVIOUS_MIGRATION_TIMESTAMP,
  selectLegacyVisualSubjectJournalRepair,
  validateMigrationJournal,
  type MigrationMetadata,
} from "../migration-journal";

const migrations: MigrationMetadata[] = [
  { folderMillis: 30, hash: "three" },
  { folderMillis: 10, hash: "one" },
  { folderMillis: 20, hash: "two" },
];

describe("validateMigrationJournal", () => {
  it("accepts valid rows independently of insertion order", () => {
    expect(() => validateMigrationJournal([
      { createdAt: 20, hash: "two" },
      { createdAt: 30, hash: "three" },
      { createdAt: 10, hash: "one" },
    ], migrations)).not.toThrow();
  });

  it("rejects an unknown recorded timestamp", () => {
    expect(() => validateMigrationJournal([{ createdAt: 40, hash: "four" }], migrations))
      .toThrow(/unknown migration timestamp 40/i);
  });

  it("rejects a hash that does not match its immutable timestamp", () => {
    expect(() => validateMigrationJournal([{ createdAt: 20, hash: "wrong" }], migrations))
      .toThrow(/hash mismatch.*20/i);
  });

  it("rejects duplicate recorded timestamps", () => {
    expect(() => validateMigrationJournal([
      { createdAt: 20, hash: "two" },
      { createdAt: 20, hash: "two" },
    ], migrations)).toThrow(/duplicate recorded migration timestamp 20/i);
  });

  it("rejects duplicate migration metadata timestamps", () => {
    expect(() => validateMigrationJournal([], [...migrations, { folderMillis: 20, hash: "other" }]))
      .toThrow(/duplicate migration metadata timestamp 20/i);
  });

  it("rejects known rows that are not an exact contiguous repository prefix", () => {
    expect(() => validateMigrationJournal([
      { createdAt: 30, hash: "three" },
      { createdAt: 20, hash: "two" },
    ], migrations)).toThrow(/contiguous repository prefix/i);
  });

  it("rejects a journal with more rows than the application build", () => {
    expect(() => validateMigrationJournal([
      { createdAt: 10, hash: "one" },
      { createdAt: 20, hash: "two" },
      { createdAt: 30, hash: "three" },
      { createdAt: 40, hash: "four" },
    ], migrations)).toThrow(/ahead of this application build/i);
  });
});
describe("selectLegacyVisualSubjectJournalRepair", () => {
  const visualMigration = {
    folderMillis: LEGACY_VISUAL_SUBJECT_MIGRATION_TIMESTAMP,
    hash: "visual-hash",
  };
  const completeSnapshot = {
    journalRows: Array.from({ length: 56 }, (_, index) => ({
      createdAt: index === 55 ? LEGACY_VISUAL_SUBJECT_PREVIOUS_MIGRATION_TIMESTAMP : index,
      hash: `hash-${index}`,
    })),
    tables: {
      visual_subjects: ["id", "identity_anchors_json", "multi_angle_references_json"],
      visual_subject_versions: ["id", "snapshot_json"],
    },
  };

  it("selects the exact 0056 metadata when every legacy condition is met", () => {
    expect(selectLegacyVisualSubjectJournalRepair(completeSnapshot, [visualMigration]))
      .toEqual(visualMigration);
  });

  it.each([
    ["0056 is already recorded", {
      ...completeSnapshot,
      journalRows: [...completeSnapshot.journalRows, {
        createdAt: LEGACY_VISUAL_SUBJECT_MIGRATION_TIMESTAMP,
        hash: "visual-hash",
      }],
    }],
    ["the row count is not exactly 56", {
      ...completeSnapshot,
      journalRows: completeSnapshot.journalRows.slice(1),
    }],
    ["the latest timestamp is not exact 0055", {
      ...completeSnapshot,
      journalRows: completeSnapshot.journalRows.map((row, index) => index === 55
        ? { ...row, createdAt: LEGACY_VISUAL_SUBJECT_PREVIOUS_MIGRATION_TIMESTAMP + 1 }
        : row),
    }],
    ["visual_subjects is absent", {
      ...completeSnapshot,
      tables: { visual_subject_versions: completeSnapshot.tables.visual_subject_versions },
    }],
    ["visual_subject_versions is absent", {
      ...completeSnapshot,
      tables: { visual_subjects: completeSnapshot.tables.visual_subjects },
    }],
    ["identity_anchors_json is absent", {
      ...completeSnapshot,
      tables: {
        ...completeSnapshot.tables,
        visual_subjects: ["id", "multi_angle_references_json"],
      },
    }],
    ["multi_angle_references_json is absent", {
      ...completeSnapshot,
      tables: {
        ...completeSnapshot.tables,
        visual_subjects: ["id", "identity_anchors_json"],
      },
    }],
    ["snapshot_json is absent", {
      ...completeSnapshot,
      tables: {
        ...completeSnapshot.tables,
        visual_subject_versions: ["id"],
      },
    }],
  ])("does not repair when %s", (_name, snapshot) => {
    expect(selectLegacyVisualSubjectJournalRepair(snapshot, [visualMigration])).toBeNull();
  });

  it("does not repair without exact 0056 migration metadata", () => {
    expect(selectLegacyVisualSubjectJournalRepair(completeSnapshot, [])).toBeNull();
  });

  it("rejects ambiguous duplicate 0056 migration metadata", () => {
    expect(() => selectLegacyVisualSubjectJournalRepair(completeSnapshot, [visualMigration, visualMigration]))
      .toThrow(/duplicate migration metadata timestamp/i);
  });
});
