import { NextRequest, NextResponse } from "next/server";
import {
  acknowledgeOperationalAlert,
  OPERATIONAL_ALERT_REASON_CODES,
  refreshOperationalHealth,
  type OperationalAlertReasonCode,
} from "@/lib/generation/operations-health";
import { checkDiskUsage, getArtifactRoot } from "@/lib/generation/archiving";
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
    const diskUsageRatio = await checkDiskUsage(getArtifactRoot());
    return NextResponse.json(refreshOperationalHealth({ diskUsageRatio }));
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
    rejectUnknownKeys(body, ["alertKey", "reasonCode", "evidenceRefs"]);
    const alertKey = readRequiredString(body, "alertKey", { maxLength: 120 });
    const reasonCode = readRequiredString(body, "reasonCode", { maxLength: 80 });
    if (!OPERATIONAL_ALERT_REASON_CODES.includes(reasonCode as OperationalAlertReasonCode)) {
      throw new RequestValidationError("reasonCode is invalid");
    }
    if (!Array.isArray(body.evidenceRefs)
      || body.evidenceRefs.some((item) => typeof item !== "string")) {
      throw new RequestValidationError("evidenceRefs must be an array of strings");
    }
    return NextResponse.json(acknowledgeOperationalAlert({
      alertKey,
      actorId: actor.id,
      reasonCode: reasonCode as OperationalAlertReasonCode,
      evidenceRefs: body.evidenceRefs,
    }));
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Error && /invalid|required|not found|resolved/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return controlPlaneErrorResponse(error);
  }
}
