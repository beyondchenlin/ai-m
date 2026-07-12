/**
 * v2.0 生成任务创作 API
 *
 * 手册 §16.2：创作接口
 * - POST /api/generation/jobs - 创建生成任务
 * - GET /api/generation/jobs - 列出项目任务（可选）
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, generationJobs, businessTaskGenerationJobs } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { createGenerationJob } from "@/lib/generation/jobs/service";
import type { CreateGenerationJobInput } from "@/lib/generation/contracts";
import { isEnabled, FF } from "@/lib/feature-flags";

/** POST /api/generation/jobs - 创建生成任务 */
export async function POST(req: NextRequest) {
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

  const body = await req.json();
  const {
    capability,
    profileRevisionId,
    projectId,
    request,
    businessContext,
  } = body;

  // 验证必填字段
  if (!capability || !profileRevisionId || !projectId || !request) {
    return NextResponse.json(
      { error: "capability, profileRevisionId, projectId, request are required" },
      { status: 400 }
    );
  }

  // 验证项目存在且用户有权限
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId));

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // 验证项目属于用户（简化版本，生产环境需要更严格的权限检查）
  if (project.userId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const input: CreateGenerationJobInput = {
      capability,
      profileRevisionId,
      projectId,
      request,
      businessContext: businessContext
        ? { kind: businessContext.kind, id: businessContext.id }
        : undefined,
    };

    const job = await createGenerationJob(input, {
      userId,
      roles: ["user"],
    });

    return NextResponse.json({ job }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Generation Jobs API] Create error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** GET /api/generation/jobs?projectId=xxx - 列出项目任务 */
export async function GET(req: NextRequest) {
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

  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId");
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "20"), 100);

  if (!projectId) {
    return NextResponse.json(
      { error: "projectId is required" },
      { status: 400 }
    );
  }

  // 验证项目权限
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId));

  if (!project || project.userId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const jobs = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.projectId, projectId))
    .orderBy(desc(generationJobs.createdAtMs))
    .limit(limit);

  return NextResponse.json({ jobs });
}
