import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPublishedWorkflowReadOnly,
  discardStagedWorkflowPackage,
  publishStagedWorkflowPackage,
  stageWorkflowPackage,
} from "../workflow-package-storage";

const roots: string[] = [];

async function makeWritable(root: string): Promise<void> {
  const stat = await fs.lstat(root).catch(() => null);
  if (!stat) return;
  if (stat.isDirectory()) {
    await fs.chmod(root, 0o755).catch(() => undefined);
    for (const entry of await fs.readdir(root)) {
      await makeWritable(path.join(root, entry));
    }
  } else {
    await fs.chmod(root, 0o644).catch(() => undefined);
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await makeWritable(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "workflow-storage-"));
  roots.push(root);
  const source = path.join(root, "incoming");
  const supply = path.join(root, "supply");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "manifest.json"), "{}");
  await fs.writeFile(path.join(source, "workflow.json"), "{\"1\":{}}");
  await fs.writeFile(path.join(source, "package.lock.json"), "{}");
  return { root, source, supply };
}

describe("workflow package isolated storage", () => {
  it("copies exact bytes into quarantine and atomically publishes a read-only tree", async () => {
    const tree = await fixture();
    const staged = await stageWorkflowPackage(tree.source, tree.supply);
    expect(path.dirname(staged.stagingDirectory)).toBe(path.join(tree.supply, "quarantine"));
    expect(staged.files.map((file) => file.relativePath)).toEqual([
      "manifest.json",
      "package.lock.json",
      "workflow.json",
    ]);
    await fs.writeFile(path.join(tree.source, "workflow.json"), "changed after quarantine");
    expect(await fs.readFile(path.join(staged.stagingDirectory, "workflow.json"), "utf8"))
      .toBe("{\"1\":{}}");

    const published = await publishStagedWorkflowPackage(staged.stagingDirectory, tree.supply);
    expect(path.dirname(published)).toBe(path.join(tree.supply, "published"));
    await expect(assertPublishedWorkflowReadOnly(published)).resolves.toBeUndefined();
    await expect(fs.writeFile(path.join(published, "workflow.json"), "tampered"))
      .rejects.toThrow();
  });

  it("discards failed validation only from the direct quarantine boundary", async () => {
    const tree = await fixture();
    const staged = await stageWorkflowPackage(tree.source, tree.supply);
    await discardStagedWorkflowPackage(staged.stagingDirectory, tree.supply);
    await expect(fs.stat(staged.stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(discardStagedWorkflowPackage(tree.source, tree.supply))
      .rejects.toThrow(/outside.*quarantine/i);
  });
});
