import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyVerifiedModelDigests,
  verifyRequiredModelFiles,
  verifyRequiredModelFilesCached,
} from "@/lib/generation/model-file-inventory";

const temporaryRoots: string[] = [];

async function fixture(): Promise<{ root: string; file: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-m-model-inventory-"));
  temporaryRoots.push(directory);
  const root = path.join(directory, "models");
  const file = path.join(root, "diffusion_models", "nested", "model.safetensors");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "stable-model-bytes");
  return { root, file };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("managed model inventory", () => {
  it("records stable size/digest and applies it to immutable manifest requirements", async () => {
    const { root } = await fixture();
    const requirements = [{ folder: "diffusion_models", filename: "nested/model.safetensors" }];
    const inventory = await verifyRequiredModelFiles(root, requirements);

    expect(inventory.models).toEqual([{
      folder: "diffusion_models",
      filename: "nested/model.safetensors",
      sizeBytes: 18,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }]);
    expect(inventory.inventoryDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(applyVerifiedModelDigests(requirements, inventory)[0]?.sha256)
      .toBe(inventory.models[0]?.sha256);
  });

  it("fails closed when bytes drift from the manifest digest", async () => {
    const { root, file } = await fixture();
    const first = await verifyRequiredModelFiles(root, [{
      folder: "diffusion_models",
      filename: "nested/model.safetensors",
    }]);
    await fs.writeFile(file, "changed-model-bytes");
    await expect(verifyRequiredModelFiles(root, [{
      folder: "diffusion_models",
      filename: "nested/model.safetensors",
      sha256: first.models[0]!.sha256,
    }])).rejects.toThrow(/digest drifted/i);
  });

  it("rejects traversal and duplicate identities with conflicting expected digests", async () => {
    const { root } = await fixture();
    await expect(verifyRequiredModelFiles(root, [{
      folder: "diffusion_models",
      filename: "../model.safetensors",
    }])).rejects.toThrow(/unsafe/i);
    await expect(verifyRequiredModelFiles(root, [
      { folder: "diffusion_models", filename: "nested/model.safetensors", sha256: "a".repeat(64) },
      { folder: "diffusion_models", filename: "nested/model.safetensors", sha256: "b".repeat(64) },
    ])).rejects.toThrow(/conflicting/i);
  });

  it("preserves stronger duplicate constraints and rejects runtime metadata conflicts", async () => {
    const { root } = await fixture();
    const first = await verifyRequiredModelFiles(root, [{
      folder: "diffusion_models", filename: "nested/model.safetensors",
    }]);
    await expect(verifyRequiredModelFiles(root, [
      {
        folder: "diffusion_models", filename: "nested/model.safetensors",
        sizeBytes: first.models[0]!.sizeBytes, sha256: first.models[0]!.sha256,
      },
      { folder: "diffusion_models", filename: "nested/model.safetensors" },
    ])).resolves.toMatchObject({ models: [expect.objectContaining({ sha256: first.models[0]!.sha256 })] });
    await expect(verifyRequiredModelFiles(root, [
      { folder: "diffusion_models", runtimeFolder: "one", filename: "nested/model.safetensors" },
      { folder: "diffusion_models", runtimeFolder: "two", filename: "nested/model.safetensors" },
    ])).rejects.toThrow(/runtime folders/i);
  });

  it.runIf(process.platform === "win32")("accepts canonical Windows paths with different drive-letter casing", async () => {
    const { root } = await fixture();
    const lowerDriveRoot = `${root[0].toLowerCase()}${root.slice(1)}`;
    await expect(verifyRequiredModelFiles(lowerDriveRoot, [{
      folder: "diffusion_models", filename: "nested/model.safetensors",
    }])).resolves.toMatchObject({ models: [expect.objectContaining({ sizeBytes: 18 })] });
  });

  it("reuses stable hot-path verification but invalidates immediately when file identity changes", async () => {
    const { root, file } = await fixture();
    const requirements = [{ folder: "diffusion_models", filename: "nested/model.safetensors" }];
    const first = await verifyRequiredModelFilesCached(root, requirements, { nowMs: 1_000, ttlMs: 1_000 });
    await fs.writeFile(file, "changed-model-bytes");
    const changed = await verifyRequiredModelFilesCached(root, requirements, { nowMs: 1_500, ttlMs: 1_000 });
    expect(changed).not.toEqual(first);
    await expect(verifyRequiredModelFilesCached(root, requirements, {
      nowMs: 2_001, ttlMs: 1_000,
    })).resolves.toEqual(changed);
  });
});
