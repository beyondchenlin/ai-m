import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertManagedInputIsolation,
  readVerifiedFileBytes,
} from "../input-materializer";

const directories: string[] = [];

afterEach(async () => {
  delete process.env.AI_M_MANAGED_COMFYUI_ENABLED;
  delete process.env.AI_M_COMFYUI_SHARED_INPUT_ROOT;
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("single-handle input materialization", () => {
  it("returns only bytes matching the captured descriptor", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-m-input-handle-"));
    directories.push(directory);
    const source = path.join(directory, "source.bin");
    const bytes = Buffer.from("verified-source-bytes");
    await fs.writeFile(source, bytes);

    await expect(readVerifiedFileBytes(
      source,
      { sizeBytes: bytes.byteLength, sha256: digest(bytes) },
      1024,
    )).resolves.toEqual(new Uint8Array(bytes));
  });

  it("rejects same-length replacement bytes before they can be returned", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-m-input-replace-"));
    directories.push(directory);
    const source = path.join(directory, "source.bin");
    const original = Buffer.alloc(512 * 1024, 0x41);
    const replacement = Buffer.alloc(original.byteLength, 0x42);
    await fs.writeFile(source, original);

    const pending = readVerifiedFileBytes(
      source,
      { sizeBytes: original.byteLength, sha256: digest(original) },
      original.byteLength,
    );
    const rejection = expect(pending).rejects.toThrow(/changed|integrity|ENOENT/i);
    await fs.rename(source, `${source}.old`);
    await fs.writeFile(source, replacement);

    await rejection;
  });

  it("rejects descriptor size and digest mismatches", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-m-input-descriptor-"));
    directories.push(directory);
    const source = path.join(directory, "source.bin");
    const bytes = Buffer.from("descriptor");
    await fs.writeFile(source, bytes);

    await expect(readVerifiedFileBytes(
      source,
      { sizeBytes: bytes.byteLength + 1, sha256: digest(bytes) },
      1024,
    )).rejects.toThrow(/integrity/i);
    await expect(readVerifiedFileBytes(
      source,
      { sizeBytes: bytes.byteLength, sha256: "0".repeat(64) },
      1024,
    )).rejects.toThrow(/integrity/i);
  });

  it("fails closed when a managed intake root contains another slot or unmanaged file", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-m-input-isolation-"));
    directories.push(directory);
    process.env.AI_M_MANAGED_COMFYUI_ENABLED = "true";
    process.env.AI_M_COMFYUI_SHARED_INPUT_ROOT = directory;
    await fs.mkdir(path.join(directory, "3d"));
    await fs.mkdir(path.join(directory, "ai-m", "job-a", "attempt-a"), { recursive: true });
    await expect(assertManagedInputIsolation("job-a", "attempt-a")).resolves.toBeUndefined();
    expect(await fs.lstat(path.join(directory, "3d")).catch(() => null)).toBeNull();

    await fs.mkdir(path.join(directory, "ai-m", "job-b", "attempt-b"), { recursive: true });
    await expect(assertManagedInputIsolation("job-a", "attempt-a")).rejects.toThrow(/current slot/i);
    await fs.rm(path.join(directory, "ai-m", "job-b"), { recursive: true });
    await fs.writeFile(path.join(directory, "unmanaged.wav"), "unsafe");
    await expect(assertManagedInputIsolation("job-a", "attempt-a")).rejects.toThrow(/current slot/i);
  });
});
