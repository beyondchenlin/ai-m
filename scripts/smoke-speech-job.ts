/** Real IndexTTS2/OmniVoice durable speech smoke test.
 *
 * Prerequisites: promoted speech profile, user-owned voice profile, running worker,
 * and AI_M_COMFYUI_SHARED_INPUT_ROOT mounted into the ComfyUI audio input root.
 */
import { createSpeechJob } from "@/lib/generation/business-adapter";
import { getGenerationJob } from "@/lib/generation/jobs/service";

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

async function main(): Promise<void> {
  const projectId = required("SMOKE_PROJECT_ID");
  const userId = required("SMOKE_USER_ID");
  const voiceProfileId = required("SMOKE_VOICE_PROFILE_ID");
  const text = process.env.SMOKE_SPEECH_TEXT?.trim() || "这是一段本地声音模型的端到端验收音频。";
  const profileRevisionId = process.env.SMOKE_PROFILE_REVISION_ID?.trim();
  const timeoutMs = positiveInteger("SMOKE_TIMEOUT_MS", 20 * 60 * 1000, 2 * 60 * 60 * 1000);
  const pollMs = positiveInteger("SMOKE_POLL_MS", 1500, 60_000);
  const operationId = process.env.SMOKE_IDEMPOTENCY_KEY?.trim()
    || `speech-smoke:${voiceProfileId}:${Date.now()}`;

  const created = await createSpeechJob(projectId, userId, {
    text,
    voiceProfileId,
    profileRevisionId,
    operationId,
  });
  const actor = { userId, roles: ["user"] };
  console.log(JSON.stringify({ event: "created", ...created }, null, 2));

  const deadline = Date.now() + timeoutMs;
  let lastMarker = "";
  while (Date.now() < deadline) {
    const job = await getGenerationJob(created.jobId, actor);
    if (!job) throw new Error("Speech smoke job disappeared");
    const marker = `${job.status}:${job.phase ?? ""}:${job.progress ?? ""}`;
    if (marker !== lastMarker) {
      console.log(JSON.stringify({ event: "progress", job }, null, 2));
      lastMarker = marker;
    }
    if (TERMINAL.has(job.status)) {
      if (job.status !== "SUCCEEDED") {
        throw new Error(`Speech smoke ended in ${job.status}: ${job.errorMessageSafe ?? job.needsAttentionReason ?? "unknown"}`);
      }
      const audio = job.artifacts?.find((artifact) => artifact.kind === "audio" && artifact.mimeType.startsWith("audio/"));
      if (!audio) throw new Error("Speech smoke succeeded without a committed audio artifact");
      if (!audio.durationMs || audio.durationMs <= 0) throw new Error("Speech smoke audio is missing an exact ffprobe duration");
      console.log(JSON.stringify({ event: "passed", jobId: job.id, audio }, null, 2));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Speech smoke did not finish within ${timeoutMs}ms`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
