/**
 * v2.0 工件下载 API
 *
 * 手册 §16.5：工件访问
 * GET /api/generation/artifacts/{id} - 下载工件（流式返回）
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  generationArtifacts,
  generationAttempts,
  generationJobs,
  projects,
} from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { promises as fs } from "fs";
import { isEnabled, FF } from "@/lib/feature-flags";

/** GET /api/generation/artifacts/{id} - 下载工件 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isEnabled(FF.V2_MEDIA_ARCHIVING)) {
    return NextResponse.json(
      { error: "v2.0 media archiving is not enabled" },
      { status: 403 }
    );
  }

  const userId = getUserIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    // 查询工件
    const [artifact] = await db
      .select()
      .from(generationArtifacts)
      .where(eq(generationArtifacts.id, id));

    if (!artifact) {
      return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
    }

    // 验证工件状态
    if (artifact.status !== "COMMITTED") {
      return NextResponse.json(
        { error: `Artifact not available (status: ${artifact.status})` },
        { status: 410 }
      );
    }

    // 通过 attempt -> job -> project 验证权限
    const [attempt] = await db
      .select({ jobId: generationAttempts.jobId })
      .from(generationAttempts)
      .where(eq(generationAttempts.id, artifact.attemptId));

    if (!attempt) {
      return NextResponse.json({ error: "Attempt not found" }, { status: 404 });
    }

    const [job] = await db
      .select({ projectId: generationJobs.projectId })
      .from(generationJobs)
      .where(eq(generationJobs.id, attempt.jobId));

    if (!job?.projectId) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, job.projectId));

    if (!project || project.userId !== userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // 验证私有工件可见性
    if (artifact.visibility === "private-original") {
      // 简化版本：只允许项目所有者访问
      // 生产环境需要更细粒度的权限控制
    }

    // 读取文件并流式返回
    try {
      const fileHandle = await fs.open(artifact.storageKey, "r");
      const stat = await fileHandle.stat();

      const stream = new ReadableStream({
        async start(controller) {
          const buffer = new Uint8Array(64 * 1024); // 64KB chunks
          let bytesRead = 0;

          while (bytesRead < stat.size) {
            const { bytesRead: chunkSize } = await fileHandle.read(buffer, 0, buffer.length, bytesRead);
            if (chunkSize === 0) break;
            controller.enqueue(buffer.slice(0, chunkSize));
            bytesRead += chunkSize;
          }

          await fileHandle.close();
          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": artifact.mimeType,
          "Content-Length": stat.size.toString(),
          "Cache-Control": "private, max-age=3600",
        },
      });
    } catch (err) {
      console.error("[Artifact API] File read error:", err);
      return NextResponse.json(
        { error: "Failed to read artifact file" },
        { status: 500 }
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Artifact API] Get error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
