/**
 * v2.0 生成任务重试 API
 *
 * 手册 §16.2：POST /api/generation/jobs/{id}/retry
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, generationJobs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { retryGenerationJob } from "@/lib/generation/jobs/service";
import type { RetryMode } from "@/lib/generation/contracts";
import { isEnabled, FF } from "@/lib/feature-flags";

/** POST /api/generation/jobs/{id}/retry - 重试任务 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isEnabled(FF.V2_DURABLE_EXECUTION)) {
    return NextResponse.json(
      { error: "v2.0 durable execution is not enabled" },
      { status: 403 }
    );
  }

  const userId = getUserIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json();
  const mode: RetryMode = body.mode ?? "retry_full";

  // 验证重试模式
  const validModes: RetryMode[] = ["retry_full", "retry_collection", "retry_submission"];
  if (!validModes.includes(mode)) {
    return NextResponse.json(
      { error: `Invalid mode. Must be one of: ${validModes.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    // 验证项目权限
    const [jobRow] = await db
      .select({ projectId: generationJobs.projectId })
      .from(generationJobs)
      .where(eq(generationJobs.id, id));

    if (!jobRow?.projectId) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, jobRow.projectId));

    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const job = await retryGenerationJob(id, { userId, roles: ["user"] }, mode);

    return NextResponse.json({ job });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Generation Job API] Retry error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
