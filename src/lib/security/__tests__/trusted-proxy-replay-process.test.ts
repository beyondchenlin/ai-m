import { createHash, createHmac, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, type TestDbContext } from "@/lib/test-helpers/db";
import { terminateChildProcess, waitForChildExit, waitForIpcMessage } from "@/lib/test-helpers/child-process";
import { buildTrustedProxyProof } from "../trusted-proxy-auth";

describe("trusted proxy durable replay prevention", () => {
  let ctx: TestDbContext;
  beforeAll(() => { ctx = setupTestDb(); });
  afterAll(() => ctx.cleanup());

  it("allows exactly one of two real processes to reserve the same proof", async () => {
    const secret = randomBytes(32);
    const nowMs = 2_000_000_000_000;
    const url = "https://app.example.test/api/projects?a=1";
    const method = "POST";
    const body = "{\"value\":1}";
    const bodySha256 = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    const common = {
      issuer: "edge-gateway",
      keyId: "primary-2026",
      userId: "workspace-user",
      timestampMs: nowMs,
      nonce: "shared-process-nonce-0001",
      scheme: "https",
      authority: "app.example.test",
      method,
      pathAndQuery: "/api/projects?a=1",
      bodySha256,
    };
    const headers = {
      "content-type": "application/json",
      "x-ai-m-auth-version": "2",
      "x-ai-m-auth-issuer": common.issuer,
      "x-ai-m-auth-key-id": common.keyId,
      "x-ai-m-authenticated-user": common.userId,
      "x-ai-m-user-timestamp": String(nowMs),
      "x-ai-m-user-nonce": common.nonce,
      "x-ai-m-body-sha256": bodySha256,
      "x-ai-m-user-signature": createHmac("sha256", secret)
        .update(buildTrustedProxyProof(common)).digest("hex"),
    };
    const fixture = path.join(__dirname, "fixtures", "trusted-proxy-replay-writer.ts");
    const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const launch = () => spawn(process.execPath, [tsxCli, fixture], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: `file:${ctx.dbPath}`,
        AI_M_TRUSTED_USER_HEADER_SECRET: secret.toString("base64url"),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const children: ChildProcess[] = [launch(), launch()];
    try {
      await Promise.all(children.map((child) => waitForIpcMessage<{ ready: true }>(child)));
      const results = children.map((child) => waitForIpcMessage<{ status: string; code?: string }>(child, 10_000));
      for (const child of children) child.send({ url, method, body, headers, nowMs });
      const settled = await Promise.all(results);
      await Promise.all(children.map((child) => waitForChildExit(child)));
      expect(settled.map((result) => result.status).sort()).toEqual(["accepted", "rejected"]);
      expect(settled.find((result) => result.status === "rejected")?.code).toMatch(/replayed/i);
    } finally {
      await Promise.allSettled(children.map((child) => terminateChildProcess(child)));
    }
  }, 20_000);
});
