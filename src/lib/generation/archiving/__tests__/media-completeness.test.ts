import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateCompleteMediaFile } from "../media-completeness";

const temporaryPaths: string[] = [];

async function classify(bytes: Uint8Array, mimeType: string): Promise<boolean> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ai-m-media-completeness-"));
  temporaryPaths.push(directory);
  const filePath = path.join(directory, "fixture.bin");
  await fs.writeFile(filePath, bytes);
  return validateCompleteMediaFile(filePath, mimeType, bytes.byteLength);
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("bounded media completeness classifier", () => {
  it.each([
    ["image/jpeg", "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjEzLjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAE1/f//Z"],
    ["image/webp", "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAgA0JaACdLoB+AADsAD+8Oj3/yC5YXXI1/8gP+QH/ID/+PIAAAA="],
    ["image/gif", "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="],
  ])("accepts a complete ffmpeg-generated %s fixture", async (mimeType, base64) => {
    const bytes = Buffer.from(base64, "base64");
    await expect(classify(bytes, mimeType)).resolves.toBe(true);
  });

  it.each([
    ["image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])],
    ["image/webp", new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 12, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
      0x56, 0x50, 0x38, 0x20, 10, 0, 0, 0,
    ])],
    ["image/gif", new Uint8Array([...Buffer.from("GIF89a"), 1, 0, 1, 0, 0, 0, 0])],
    ["video/mp4", Buffer.concat([
      Buffer.from([0, 0, 0, 16]), Buffer.from("ftyp"), Buffer.from("isom\0\0\0\0"),
      Buffer.from([0, 0, 0, 8]), Buffer.from("mdat"),
    ])],
  ])("rejects a bounded but incomplete %s structure", async (mimeType, bytes) => {
    await expect(classify(bytes, mimeType)).resolves.toBe(false);
  });
});
