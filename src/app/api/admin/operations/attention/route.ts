import { NextRequest, NextResponse } from "next/server";
import {
  acknowledgeAttentionCase,
  ATTENTION_REASON_CODES,
  listAttentionCases,
  type AttentionReasonCode,
} from "@/lib/generation/operations-attention";
import {
  assertPlainObject,
  readJsonBodyLimited,
  readRequiredString,
  rejectUnknownKeys,
  requireAdmin,
  RequestValidationError,
} from "@/lib/security";
import { controlPlaneErrorResponse } from "@/lib/security/api-response";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    requireAdmin(req);
    return NextResponse.json({ cases: listAttentionCases() });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = requireAdmin(req);
    if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new RequestValidationError("Content-Type must be application/json");
    }
    const body: unknown = await readJsonBodyLimited(req);
    assertPlainObject(body);
    rejectUnknownKeys(body, ["jobId", "reasonCode", "evidenceRefs"]);
    const jobId = readRequiredString(body, "jobId", { maxLength: 160 });
    const reasonCode = readRequiredString(body, "reasonCode", { maxLength: 80 });
    if (!ATTENTION_REASON_CODES.includes(reasonCode as AttentionReasonCode)) {
      throw new RequestValidationError("reasonCode is invalid");
    }
    if (!Array.isArray(body.evidenceRefs)
      || body.evidenceRefs.some((item) => typeof item !== "string")) {
      throw new RequestValidationError("evidenceRefs must be an array of strings");
    }
    return NextResponse.json(acknowledgeAttentionCase({
      jobId,
      actorId: actor.id,
      reasonCode: reasonCode as AttentionReasonCode,
      evidenceRefs: body.evidenceRefs,
    }));
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Error && /invalid|required|not found|no longer/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return controlPlaneErrorResponse(error);
  }
}
