/** Retry one failed/cancelled job as a new full execution attempt. */
import { NextRequest, NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { retryGenerationJob, GenerationJobServiceError } from "@/lib/generation/jobs/service";
import type { RetryMode } from "@/lib/generation/contracts";
import { isEnabled, FF } from "@/lib/feature-flags";
import {
  assertPlainObject, rejectUnknownKeys, readJsonBodyLimited, RequestValidationError,
  assertTrustedRequestOrigin,
} from "@/lib/security";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isEnabled(FF.V2_DURABLE_EXECUTION)) {
    return NextResponse.json({ error: "v2.0 durable execution is not enabled" }, { status: 403 });
  }
  const userId = getUserIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    assertTrustedRequestOrigin(req);
    if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new RequestValidationError("Content-Type must be application/json");
    }
    const body: unknown = await readJsonBodyLimited(req);
    assertPlainObject(body);
    rejectUnknownKeys(body, ["mode"]);
    const mode = body.mode === undefined ? "retry_full" : body.mode;
    if (mode !== "retry_full") {
      return NextResponse.json(
        { error: "Only retry_full is supported; recovery of uncertain external execution is automatic" },
        { status: 400 },
      );
    }
    const job = await retryGenerationJob(id, { userId, roles: ["user"] }, mode satisfies RetryMode);
    return NextResponse.json({ job });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof GenerationJobServiceError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    if (error instanceof SyntaxError || (error instanceof Error && /must be an object|unknown field/i.test(error.message))) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status: 400 });
    }
    console.error("[generation/jobs/:id/retry] request failed", error);
    return NextResponse.json({ error: "Generation job retry failed" }, { status: 500 });
  }
}
