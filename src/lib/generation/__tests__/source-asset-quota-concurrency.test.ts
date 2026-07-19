import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { db, getSqlite } from "@/lib/db";
import { projects, sourceAssetQuotaReservations } from "@/lib/db/schema";
import { setupTestDb } from "@/lib/test-helpers/db";
import {
  releaseSourceAssetQuotaReservation,
  renewSourceAssetQuotaReservation,
  reserveSourceAssetQuota,
} from "../source-assets";

describe("source asset quota reservations", () => {
  let context: ReturnType<typeof setupTestDb>;

  beforeAll(async () => {
    context = setupTestDb();
    process.env.AI_M_SOURCE_ASSET_PROJECT_QUOTA_BYTES = "100";
    await db.insert(projects).values({ id: "quota-project", userId: "quota-user", title: "Quota" });
  });

  afterAll(() => {
    delete process.env.AI_M_SOURCE_ASSET_PROJECT_QUOTA_BYTES;
    context.cleanup();
  });

  beforeEach(async () => {
    await db.delete(sourceAssetQuotaReservations);
  });

  it("allows the exact boundary and rejects one byte beyond it", () => {
    reserveSourceAssetQuota("quota-project", "quota-user", 60);
    reserveSourceAssetQuota("quota-project", "quota-user", 40);
    expect(() => reserveSourceAssetQuota("quota-project", "quota-user", 1))
      .toThrow(/quota exceeded/i);
  });

  it("rejects invalid reservation sizes instead of allowing quota underflow", () => {
    expect(() => reserveSourceAssetQuota("quota-project", "quota-user", 0))
      .toThrow(/invalid source-audio quota reservation/i);
    expect(() => reserveSourceAssetQuota("quota-project", "quota-user", -1))
      .toThrow(/invalid source-audio quota reservation/i);
    expect(() => reserveSourceAssetQuota("quota-project", "quota-user", Number.NaN))
      .toThrow(/invalid source-audio quota reservation/i);
  });

  it("releases losers and renews a live owner token", () => {
    const reservation = reserveSourceAssetQuota("quota-project", "quota-user", 100);
    const before = getSqlite().prepare("SELECT expires_at_ms FROM source_asset_quota_reservations WHERE id=?")
      .get(reservation.id) as { expires_at_ms: number };
    renewSourceAssetQuotaReservation(reservation.id, reservation.token);
    const after = getSqlite().prepare("SELECT expires_at_ms FROM source_asset_quota_reservations WHERE id=?")
      .get(reservation.id) as { expires_at_ms: number };
    expect(after.expires_at_ms).toBeGreaterThanOrEqual(before.expires_at_ms);
    releaseSourceAssetQuotaReservation(reservation.id, reservation.token);
    expect(() => reserveSourceAssetQuota("quota-project", "quota-user", 100)).not.toThrow();
  });

  it("reclaims an expired crashed reservation during the next atomic reserve", () => {
    const crashed = reserveSourceAssetQuota("quota-project", "quota-user", 100);
    getSqlite().prepare("UPDATE source_asset_quota_reservations SET expires_at_ms=0 WHERE id=?")
      .run(crashed.id);
    expect(() => reserveSourceAssetQuota("quota-project", "quota-user", 100)).not.toThrow();
  });

  it("admits exactly one of two competing processes", async () => {
    const fixture = path.resolve(
      "src/lib/generation/__tests__/fixtures/source-quota-writer.ts",
    );
    const run = () => new Promise<{ accepted: boolean; code?: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--import", "tsx", fixture, "quota-project", "quota-user", "60",
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: `file:${context.dbPath}`,
          AI_M_SOURCE_ASSET_PROJECT_QUOTA_BYTES: "100",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== 0) return reject(new Error(stderr || `child exited ${code}`));
        resolve(JSON.parse(stdout) as { accepted: boolean; code?: string });
      });
    });
    const results = await Promise.all([run(), run()]);
    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(results.filter((result) => !result.accepted)).toEqual([
      expect.objectContaining({ code: "SOURCE_PROJECT_QUOTA_EXCEEDED" }),
    ]);
  });
});
