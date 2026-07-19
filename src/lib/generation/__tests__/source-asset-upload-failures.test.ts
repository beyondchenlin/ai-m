import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { projects, sourceAssetQuotaReservations, sourceMediaAssets } from "@/lib/db/schema";
import { setupTestDb } from "@/lib/test-helpers/db";

const mocks = vi.hoisted(() => ({
  probeAudioMetadata: vi.fn(),
}));

vi.mock("../media-probe", () => ({
  probeAudioMetadata: mocks.probeAudioMetadata,
}));

import { importVoiceReferenceStream } from "../source-assets";

function wavBytes(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set(Buffer.from("RIFF"), 0);
  bytes.set(Buffer.from("WAVE"), 8);
  return bytes;
}

describe("source upload loser cleanup", () => {
  let context: ReturnType<typeof setupTestDb>;
  let uploadRoot: string;

  beforeAll(async () => {
    context = setupTestDb();
    uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-m-source-failure-"));
    process.env.UPLOAD_DIR = uploadRoot;
    process.env.AI_M_SOURCE_ASSET_PROJECT_QUOTA_BYTES = "1024";
    process.env.AI_M_SOURCE_ASSET_MIN_FREE_BYTES = "1";
    await db.insert(projects).values({ id: "upload-failure-project", userId: "upload-user", title: "Upload" });
  });

  afterAll(async () => {
    delete process.env.UPLOAD_DIR;
    delete process.env.AI_M_SOURCE_ASSET_PROJECT_QUOTA_BYTES;
    delete process.env.AI_M_SOURCE_ASSET_MIN_FREE_BYTES;
    context.cleanup();
    await fs.rm(uploadRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    mocks.probeAudioMetadata.mockReset();
    await db.delete(sourceAssetQuotaReservations);
    await db.delete(sourceMediaAssets);
  });

  async function assertNoLeak(): Promise<void> {
    expect(await db.select().from(sourceMediaAssets)).toHaveLength(0);
    expect(await db.select().from(sourceAssetQuotaReservations)).toEqual([
      expect.objectContaining({ status: "RELEASED" }),
    ]);
    const staging = path.join(uploadRoot, "source-assets", ".staging");
    expect(await fs.readdir(staging).catch(() => [])).toHaveLength(0);
  }

  it("releases reservation and partial file on client abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const bytes = wavBytes();
    await expect(importVoiceReferenceStream({
      projectId: "upload-failure-project",
      userId: "upload-user",
      stream: new Blob([bytes.buffer as ArrayBuffer]).stream(),
      originalName: "abort.wav",
      declaredSize: bytes.byteLength,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "UPLOAD_ABORTED" });
    await assertNoLeak();
  });

  it("releases reservation and staged file on ffprobe failure", async () => {
    mocks.probeAudioMetadata.mockRejectedValueOnce(new Error("probe failed"));
    const bytes = wavBytes();
    await expect(importVoiceReferenceStream({
      projectId: "upload-failure-project",
      userId: "upload-user",
      stream: new Blob([bytes.buffer as ArrayBuffer]).stream(),
      originalName: "probe.wav",
      declaredSize: bytes.byteLength,
    })).rejects.toMatchObject({ code: "AUDIO_PROBE_FAILED" });
    await assertNoLeak();
  });

  it("never writes beyond the declared size and releases the exact reservation", async () => {
    const bytes = wavBytes();
    await expect(importVoiceReferenceStream({
      projectId: "upload-failure-project",
      userId: "upload-user",
      stream: new Blob([bytes.buffer as ArrayBuffer]).stream(),
      originalName: "underdeclared.wav",
      declaredSize: bytes.byteLength - 1,
    })).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
    expect(mocks.probeAudioMetadata).not.toHaveBeenCalled();
    await assertNoLeak();
  });
});
