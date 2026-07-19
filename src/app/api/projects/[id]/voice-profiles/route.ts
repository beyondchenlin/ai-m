import { NextResponse } from "next/server";
import { FF, isEnabled } from "@/lib/feature-flags";
import { assertProjectOwnership } from "@/lib/assert-project-ownership";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { listVoiceProfiles, processVoiceProfile, VoiceProfileError, VOICE_CONSENT_VERSION } from "@/lib/generation/voice-profiles";
import {
  assertPlainObject,
  readBoolean,
  readEnum,
  readJsonBodyLimited,
  readOptionalString,
  readRequiredString,
  rejectUnknownKeys,
  RequestValidationError,
  assertTrustedRequestOrigin,
} from "@/lib/security";

export const runtime = "nodejs";

function optionalFiniteNumber(body: Record<string, unknown>, key: string, fallback: number): number {
  const value = body[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RequestValidationError(`${key} must be a finite number`);
  }
  return value;
}

export async function GET(
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
  const userId = await getUserIdFromRequest(request);
  try {
    assertTrustedRequestOrigin(request);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
  const profiles = await listVoiceProfiles(userId, projectId);
  return NextResponse.json({ profiles });
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
  const userId = await getUserIdFromRequest(request);

  try {
    assertTrustedRequestOrigin(request);
    const body: unknown = await readJsonBodyLimited(request, 128 * 1024);
    assertPlainObject(body);
    rejectUnknownKeys(body, [
      "name",
      "provider",
      "referenceSourceAssetId",
      "referenceText",
      "language",
      "defaultSpeed",
      "defaultPitch",
      "consentConfirmed",
      "idempotencyKey",
    ]);
    const consentConfirmed = readBoolean(body, "consentConfirmed");
    if (consentConfirmed !== true) throw new RequestValidationError("Voice usage consent must be confirmed");
    const bodyKey = readOptionalString(body, "idempotencyKey", { maxLength: 160 });
    const headerKey = request.headers.get("idempotency-key")?.trim() || undefined;
    if (headerKey && headerKey.length > 160) throw new RequestValidationError("idempotency-key is too long");
    if (bodyKey && headerKey && bodyKey !== headerKey) throw new RequestValidationError("Conflicting idempotency keys");
    const idempotencyKey = bodyKey || headerKey;
    if (!idempotencyKey) throw new RequestValidationError("idempotencyKey is required");

    const profile = await processVoiceProfile({
      projectId,
      userId,
      name: readRequiredString(body, "name", { maxLength: 120 }),
      provider: readEnum(body, "provider", ["indextts2", "omnivoice"] as const),
      referenceSourceAssetId: readRequiredString(body, "referenceSourceAssetId", { maxLength: 160 }),
      referenceText: readOptionalString(body, "referenceText", { maxLength: 20_000 }),
      language: readOptionalString(body, "language", { maxLength: 40 }),
      defaultSpeed: optionalFiniteNumber(body, "defaultSpeed", 1),
      defaultPitch: optionalFiniteNumber(body, "defaultPitch", 1),
      consentConfirmed: true,
      consentStatementVersion: VOICE_CONSENT_VERSION,
      idempotencyKey,
    });
    return NextResponse.json({ profile }, { status: 201 });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof VoiceProfileError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("[voice-profiles] creation failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ error: "Voice profile creation failed" }, { status: 500 });
  }
}
