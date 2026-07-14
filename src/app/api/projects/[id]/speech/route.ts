import { NextResponse } from "next/server";
import { FF, isEnabled } from "@/lib/feature-flags";
import { assertProjectOwnership } from "@/lib/assert-project-ownership";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { createDialogueAudioJob, createSpeechJob, SpeechJobError } from "@/lib/generation/business-adapter";
import { GenerationJobServiceError } from "@/lib/generation/jobs/service";
import {
  assertPlainObject,
  readJsonBodyLimited,
  readOptionalString,
  readRequiredString,
  rejectUnknownKeys,
  RequestValidationError,
  assertTrustedRequestOrigin,
} from "@/lib/security";

function optionalFiniteNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new RequestValidationError(`${key} must be a finite number`);
  return value;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isEnabled(FF.V2_LOCAL_SPEECH)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { id: projectId } = await params;
  if (!(await assertProjectOwnership(request, projectId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const userId = getUserIdFromRequest(request);
  try {
    assertTrustedRequestOrigin(request);
    const body: unknown = await readJsonBodyLimited(request, 128 * 1024);
    assertPlainObject(body);
    rejectUnknownKeys(body, [
      "text", "voiceProfileId", "profileRevisionId", "dialogueId", "speed", "pitch",
      "language", "emotion", "emotionStrength", "idempotencyKey",
    ]);
    const text = readRequiredString(body, "text", { maxLength: 100_000 });
    const voiceProfileId = readRequiredString(body, "voiceProfileId", { maxLength: 160 });
    const profileRevisionId = readRequiredString(body, "profileRevisionId", { maxLength: 160 });
    const dialogueId = readOptionalString(body, "dialogueId", { maxLength: 160 });
    const idempotencyKey = readOptionalString(body, "idempotencyKey", { maxLength: 160 });
    const language = readOptionalString(body, "language", { maxLength: 40 });
    const emotion = readOptionalString(body, "emotion", { maxLength: 80 });
    const options = {
      text,
      voiceProfileId,
      profileRevisionId,
      operationId: idempotencyKey,
      speed: optionalFiniteNumber(body, "speed"),
      pitch: optionalFiniteNumber(body, "pitch"),
      language,
      emotion,
      emotionStrength: optionalFiniteNumber(body, "emotionStrength"),
    };
    const result = dialogueId
      ? await createDialogueAudioJob(dialogueId, projectId, userId, options)
      : await createSpeechJob(projectId, userId, options);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof SpeechJobError || error instanceof GenerationJobServiceError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("[speech] job creation failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ error: "Speech job creation failed" }, { status: 500 });
  }
}
