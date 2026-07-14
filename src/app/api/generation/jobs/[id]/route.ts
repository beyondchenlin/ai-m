/** Query one authorized durable generation job. */
import { NextRequest, NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { getGenerationJob, GenerationJobServiceError } from "@/lib/generation/jobs/service";
import { isEnabled, FF } from "@/lib/feature-flags";

export async function GET(
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
    const job = await getGenerationJob(id, { userId, roles: ["user"] });
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    return NextResponse.json({ job });
  } catch (error) {
    if (error instanceof GenerationJobServiceError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("[generation/jobs/:id] query failed", error);
    return NextResponse.json({ error: "Generation job query failed" }, { status: 500 });
  }
}
