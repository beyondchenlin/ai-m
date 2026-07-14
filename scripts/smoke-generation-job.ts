/**
 * Real end-to-end smoke runner for one promoted generation profile.
 *
 * Start the independent worker first, then execute this script with an existing
 * project/profile and a minimal request.  The script creates a durable job,
 * waits through the real ComfyUI backend, and requires a committed artifact.
 */
import { readFile } from "node:fs/promises";
import type { Capability } from "@/lib/generation/naming";
import type { CreateGenerationJobInput } from "@/lib/generation/contracts";
import { createGenerationJob, getGenerationJob } from "@/lib/generation/jobs/service";

const SUPPORTED_CAPABILITIES = new Set<Capability>(["image", "video", "speech", "utility"]);
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "NEEDS_ATTENTION"]);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be an integer in the range 1..${maximum}`);
  }
  return value;
}

async function readRequest(): Promise<Record<string, unknown>> {
  const inline = process.env.SMOKE_REQUEST_JSON?.trim();
  const file = process.env.SMOKE_REQUEST_FILE?.trim();
  if (Boolean(inline) === Boolean(file)) {
    throw new Error("Set exactly one of SMOKE_REQUEST_JSON or SMOKE_REQUEST_FILE");
  }
  const text = inline ?? await readFile(file!, "utf8");
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Smoke request must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function main(): Promise<void> {
  const projectId = required("SMOKE_PROJECT_ID");
  const profileRevisionId = required("SMOKE_PROFILE_REVISION_ID");
  const userId = required("SMOKE_USER_ID");
  const capability = required("SMOKE_CAPABILITY") as Capability;
  if (!SUPPORTED_CAPABILITIES.has(capability)) {
    throw new Error(`Unsupported SMOKE_CAPABILITY: ${capability}`);
  }
  const request = await readRequest();
  const timeoutMs = positiveInteger("SMOKE_TIMEOUT_MS", 20 * 60 * 1000, 2 * 60 * 60 * 1000);
  const pollMs = positiveInteger("SMOKE_POLL_MS", 1500, 60_000);
  const expectedMimePrefix = process.env.SMOKE_EXPECT_MIME_PREFIX?.trim() || (
    capability === "image" ? "image/" : capability === "video" ? "video/" : capability === "speech" ? "audio/" : ""
  );
  const idempotencyKey = process.env.SMOKE_IDEMPOTENCY_KEY?.trim()
    || `smoke:${profileRevisionId}:${Date.now()}`;
  const actor = { userId, roles: ["user"] };
  const input: CreateGenerationJobInput = {
    projectId,
    profileRevisionId,
    capability,
    idempotencyKey,
    request: request as unknown as CreateGenerationJobInput["request"],
  };

  const created = await createGenerationJob(input, actor);
  console.log(JSON.stringify({ event: "created", job: created }, null, 2));
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const job = await getGenerationJob(created.id, actor);
    if (!job) throw new Error("Smoke job disappeared");
    const marker = `${job.status}:${job.phase ?? ""}:${job.progress ?? ""}`;
    if (marker !== lastStatus) {
      console.log(JSON.stringify({ event: "progress", job }, null, 2));
      lastStatus = marker;
    }
    if (TERMINAL.has(job.status)) {
      if (job.status !== "SUCCEEDED") {
        throw new Error(`Smoke job ended in ${job.status}: ${job.errorMessageSafe ?? job.needsAttentionReason ?? "unknown"}`);
      }
      if (!job.artifacts?.length) throw new Error("Smoke job succeeded without a committed artifact");
      if (expectedMimePrefix && !job.artifacts.some((artifact) => artifact.mimeType.startsWith(expectedMimePrefix))) {
        throw new Error(`Smoke job did not produce an artifact matching ${expectedMimePrefix}`);
      }
      console.log(JSON.stringify({ event: "passed", job }, null, 2));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Smoke job did not finish within ${timeoutMs}ms`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
