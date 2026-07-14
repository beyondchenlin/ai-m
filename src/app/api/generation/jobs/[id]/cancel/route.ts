/** Request safe cancellation of one authorized durable generation job. */
import { NextRequest, NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { cancelGenerationJob, GenerationJobServiceError } from "@/lib/generation/jobs/service";
import { isEnabled, FF } from "@/lib/feature-flags";
import { assertTrustedRequestOrigin, RequestValidationError } from "@/lib/security";

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
    const job = await cancelGenerationJob(id, { userId, roles: ["user"] });
    return NextResponse.json({ job });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof GenerationJobServiceError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("[generation/jobs/:id/cancel] request failed", error);
    return NextResponse.json({ error: "Generation job cancellation failed" }, { status: 500 });
  }
}
