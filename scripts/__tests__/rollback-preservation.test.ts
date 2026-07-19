import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSqlite } from "@/lib/db";
import { setupTestDb, type TestDbContext } from "@/lib/test-helpers/db";
import {
  captureRollbackPreservation,
  verifyRollbackPreservation,
} from "../rollback-preservation";

const roots: string[] = [];
const contexts: TestDbContext[] = [];

async function fixture() {
  const context = setupTestDb();
  contexts.push(context);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-m-rollback-"));
  roots.push(root);
  const artifactRoot = path.join(root, "artifacts");
  const manifestPath = path.join(root, "evidence", "rollback.json");
  await fs.mkdir(path.join(artifactRoot, "committed"), { recursive: true });
  await fs.writeFile(path.join(artifactRoot, "committed", "image.bin"), "immutable-artifact");
  getSqlite().prepare(`
    INSERT INTO audit_events
      (id, actor_id, action, target_type, target_id, details_safe_json, created_at_ms)
    VALUES ('rollback-audit', 'operator', 'release.test', 'release', 'candidate', '{}', 1)
  `).run();
  await captureRollbackPreservation({
    databasePath: context.dbPath,
    artifactRoot,
    manifestPath,
    candidateSha: "abcdef1234567",
    nowMs: 100,
  });
  return { databasePath: context.dbPath, artifactRoot, manifestPath };
}

afterEach(async () => {
  contexts.splice(0).forEach((context) => context.cleanup());
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("rollback preservation guard", () => {
  it("accepts an unchanged additive schema, protected rows, and artifact tree", async () => {
    const data = await fixture();
    await expect(verifyRollbackPreservation(data)).resolves.toMatchObject({
      status: "ROLLBACK_PRESERVATION_PASSED",
      candidateSha: "abcdef1234567",
      protectedTableCount: 15,
      protectedArtifactCount: 1,
    });
  });

  it("rejects protected row deletion and down-migration journal changes", async () => {
    const data = await fixture();
    getSqlite().prepare("DELETE FROM audit_events WHERE id='rollback-audit'").run();
    await expect(verifyRollbackPreservation(data)).rejects.toThrow(/changed or deleted a protected row/i);

    getSqlite().prepare(`
      INSERT INTO audit_events
        (id, actor_id, action, target_type, target_id, details_safe_json, created_at_ms)
      VALUES ('rollback-audit', 'operator', 'release.test', 'release', 'candidate', '{}', 2)
    `).run();
    getSqlite().prepare('DELETE FROM "__drizzle_migrations" WHERE rowid=(SELECT MAX(rowid) FROM "__drizzle_migrations")')
      .run();
    await expect(verifyRollbackPreservation(data)).rejects.toThrow(/down-migration/i);
  });

  it("rejects protected row replacement or mutation even when row counts do not decrease", async () => {
    const data = await fixture();
    getSqlite().prepare("UPDATE audit_events SET actor_id='attacker' WHERE id='rollback-audit'").run();
    await expect(verifyRollbackPreservation(data)).rejects.toThrow(/changed or deleted a protected row/i);
  });

  it("rejects modified or deleted committed artifact bytes", async () => {
    const data = await fixture();
    await fs.writeFile(path.join(data.artifactRoot, "committed", "image.bin"), "changed-artifact!!");
    await expect(verifyRollbackPreservation(data)).rejects.toThrow(/changed or deleted/i);
  });
});
