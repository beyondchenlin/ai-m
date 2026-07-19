import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createRecoveryBundle, restoreRecoveryBundle } from "../recovery-bundle";

const roots: string[] = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-m-recovery-"));
  roots.push(root);
  const databasePath = path.join(root, "live.sqlite");
  const database = new Database(databasePath);
  database.exec("CREATE TABLE evidence (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO evidence VALUES ('audit', 'retained')");
  database.close();
  const uploads = path.join(root, "uploads");
  const workflows = path.join(root, "workflows");
  await fs.mkdir(path.join(uploads, "artifacts"), { recursive: true });
  await fs.mkdir(path.join(workflows, "generations"), { recursive: true });
  await fs.writeFile(path.join(uploads, "artifacts", "image.bin"), "committed-artifact");
  await fs.writeFile(path.join(workflows, "generations", "current.json"), "{\"generation\":\"exact\"}");
  return { root, databasePath, uploads, workflows };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("recovery bundle and isolated restore rehearsal", () => {
  it("backs up database and file trees, restores them, and verifies exact bytes", async () => {
    const data = await fixture();
    const bundle = path.join(data.root, "bundle");
    const restored = path.join(data.root, "restored");
    const manifest = await createRecoveryBundle({
      databasePath: data.databasePath,
      components: [
        { name: "uploads", sourcePath: data.uploads },
        { name: "workflows", sourcePath: data.workflows },
      ],
      destination: bundle,
      nowMs: 123,
    });
    const result = await restoreRecoveryBundle({ bundle, destination: restored });
    expect(result.manifest.contentDigest).toBe(manifest.contentDigest);
    expect(await fs.readFile(path.join(restored, "uploads", "artifacts", "image.bin"), "utf8"))
      .toBe("committed-artifact");
    const database = new Database(path.join(restored, "database", "application.sqlite"), { readonly: true });
    expect(database.prepare("SELECT value FROM evidence WHERE id='audit'").pluck().get()).toBe("retained");
    database.close();
  });

  it("rejects a tampered bundle before creating the restore destination", async () => {
    const data = await fixture();
    const bundle = path.join(data.root, "bundle");
    const restored = path.join(data.root, "restored");
    await createRecoveryBundle({
      databasePath: data.databasePath,
      components: [{ name: "uploads", sourcePath: data.uploads }],
      destination: bundle,
    });
    await fs.writeFile(path.join(bundle, "uploads", "artifacts", "image.bin"), "tampered-artifact!");
    await expect(restoreRecoveryBundle({ bundle, destination: restored })).rejects.toThrow(/identity|digest/i);
    expect(await fs.lstat(restored).catch(() => null)).toBeNull();
  });

  it("never overwrites an existing backup or restore destination", async () => {
    const data = await fixture();
    const bundle = path.join(data.root, "bundle");
    await fs.mkdir(bundle);
    await expect(createRecoveryBundle({
      databasePath: data.databasePath,
      components: [],
      destination: bundle,
    })).rejects.toThrow(/already exists/i);
  });
});
