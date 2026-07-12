/**
 * v2.0 生成任务详情 API
 *
 * 手册 §16.4：状态查询
 * GET /api/generation/jobs/{id} - 查询任务状态
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, generationJobs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { getGenerationJob } from "@/lib/generation/jobs/service";
import { isEnabled, FF } from "@/lib/feature-flags";

/** GET /api/generation/jobs/{id} - 查询任务状态 */
export async function GET(
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

  try {
    const job = await getGenerationJob(id, { userId, roles: ["user"] });

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    // 验证项目权限（通过 job.projectId）
    const [jobRow] = await db
      .select({ projectId: generationJobs.projectId })
      .from(generationJobs)
      .where(eq(generationJobs.id, id));

    if (!jobRow?.projectId) {
      return NextResponse.json({ error: "Job has no project" }, { status: 403 });
    }

    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, jobRow.projectId));

    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json({ job });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Generation Job API] Get error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
