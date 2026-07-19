import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  it("keeps published migrations and appends job input retention as 0070", () => {
    const journal = JSON.parse(readFileSync(
      resolve(process.cwd(), "drizzle/meta/_journal.json"),
      "utf8",
    )) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const latest = journal.entries.at(-1);
    const validationKinds = journal.entries.at(-2);
    const operationalAlerts = journal.entries.at(-3);
    const workflowApprovals = journal.entries.at(-4);
    const voiceIdempotency = journal.entries.at(-5);
    const quotaReservations = journal.entries.at(-6);
    const jobInputArtifacts = journal.entries.at(-7);
    const trustedProxyNonces = journal.entries.at(-8);
    const artifactLeases = journal.entries.at(-9);
    const slotOwnerUnique = journal.entries.at(-10);
    const published0060 = journal.entries.at(-11);

    expect(latest).toMatchObject({
      idx: 70,
      tag: "0070_job_input_retention",
    });
    expect(validationKinds).toMatchObject({ idx: 69, tag: "0069_workflow_validation_kinds" });
    expect(operationalAlerts).toMatchObject({ idx: 68, tag: "0068_operational_alerts" });
    expect(workflowApprovals).toMatchObject({ idx: 67, tag: "0067_workflow_two_person_approvals" });
    expect(voiceIdempotency).toMatchObject({ idx: 66, tag: "0066_voice_profile_idempotency" });
    expect(quotaReservations).toMatchObject({ idx: 65, tag: "0065_source_asset_quota_reservations" });
    expect(jobInputArtifacts).toMatchObject({ idx: 64, tag: "0064_job_input_artifacts" });
    expect(trustedProxyNonces).toMatchObject({ idx: 63, tag: "0063_trusted_proxy_nonces" });
    expect(artifactLeases).toMatchObject({ idx: 62, tag: "0062_artifact_recovery_leases" });
    expect(slotOwnerUnique).toMatchObject({ idx: 61, tag: "0061_resource_slot_owner_unique" });
    expect(published0060).toMatchObject({ idx: 60, tag: "0060_resource_reconciliation_proof" });
    expect(latest!.when).toBeGreaterThan(validationKinds!.when);
  });

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
