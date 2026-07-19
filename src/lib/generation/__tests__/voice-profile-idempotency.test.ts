import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { db } from "@/lib/db";
import { projects, sourceMediaAssets, voiceProfiles } from "@/lib/db/schema";
import { setupTestDb } from "@/lib/test-helpers/db";
import {
  processVoiceProfile,
  VOICE_CONSENT_VERSION,
  type VoiceProfileInput,
} from "../voice-profiles";

describe("voice profile idempotency", () => {
  let context: ReturnType<typeof setupTestDb>;

  beforeAll(async () => {
    context = setupTestDb();
    for (const suffix of ["a", "b"]) {
      await db.insert(projects).values({
        id: `voice-project-${suffix}`,
        userId: `voice-user-${suffix}`,
        title: `Voice ${suffix}`,
      });
      await db.insert(sourceMediaAssets).values({
        id: `voice-source-${suffix}`,
        projectId: `voice-project-${suffix}`,
        userId: `voice-user-${suffix}`,
        kind: "audio",
        status: "COMMITTED",
        storageKey: `voice/${suffix}.wav`,
        mimeType: "audio/wav",
        sizeBytes: 128,
        sha256: suffix.repeat(64),
        durationMs: 5_000,
        metadataJson: {},
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
    }
  });

  afterAll(() => context.cleanup());
  beforeEach(async () => { await db.delete(voiceProfiles); });

  function input(suffix = "a", overrides: Partial<VoiceProfileInput> = {}): VoiceProfileInput {
    return {
      projectId: `voice-project-${suffix}`,
      userId: `voice-user-${suffix}`,
      name: "Narrator",
      provider: "indextts2",
      referenceSourceAssetId: `voice-source-${suffix}`,
      language: "zh-CN",
      defaultSpeed: 1,
      defaultPitch: 1,
      consentConfirmed: true,
      consentStatementVersion: VOICE_CONSENT_VERSION,
      idempotencyKey: "voice-operation-1",
      ...overrides,
    };
  }

  function runProcess(value: VoiceProfileInput): Promise<{ accepted: boolean; id?: string; code?: string }> {
    const fixture = path.resolve("src/lib/generation/__tests__/fixtures/voice-profile-writer.ts");
    const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", fixture, encoded], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: `file:${context.dbPath}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== 0) return reject(new Error(stderr || `child exited ${code}`));
        resolve(JSON.parse(stdout) as { accepted: boolean; id?: string; code?: string });
      });
    });
  }

  it("returns one identity from two real service processes", async () => {
    const results = await Promise.all([runProcess(input()), runProcess(input())]);
    expect(results).toEqual([
      expect.objectContaining({ accepted: true }),
      expect.objectContaining({ accepted: true }),
    ]);
    expect(results[0]?.id).toBe(results[1]?.id);
    expect(await db.select().from(voiceProfiles)).toHaveLength(1);
  });

  it("rejects semantic mismatch without creating another profile", async () => {
    await processVoiceProfile(input());
    await expect(processVoiceProfile(input("a", { name: "Different" })))
      .rejects.toMatchObject({ status: 409, code: "idempotency_key_conflict" });
    expect(await db.select().from(voiceProfiles)).toHaveLength(1);
  });

  it("scopes the same key independently by project and user", async () => {
    const [first, second] = await Promise.all([
      processVoiceProfile(input("a")),
      processVoiceProfile(input("b")),
    ]);
    expect(first.id).not.toBe(second.id);
    expect(await db.select().from(voiceProfiles)).toHaveLength(2);
  });
});
