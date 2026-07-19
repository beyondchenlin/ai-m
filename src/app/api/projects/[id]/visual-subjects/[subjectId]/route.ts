/**
 * 单个视觉主体 API 路由
 * 
 * GET    - 获取视觉主体详情
 * PATCH  - 更新视觉主体（创建新版本）
 * DELETE - 删除视觉主体
 */

import { NextResponse } from "next/server";
import { assertProjectOwnership } from "@/lib/assert-project-ownership";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import {
  getVisualSubject,
  updateVisualSubject,
} from "@/lib/generation/visual-subjects";
import { db } from "@/lib/db";
import { visualSubjects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; subjectId: string }> }
) {
  const { id: projectId, subjectId } = await params;
  if (!(await assertProjectOwnership(request, projectId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const subject = await getVisualSubject(subjectId);
  if (!subject || subject.projectId !== projectId) {
    return NextResponse.json({ error: "Visual subject not found" }, { status: 404 });
  }

  return NextResponse.json({ subject });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; subjectId: string }> }
) {
  const { id: projectId, subjectId } = await params;
  if (!(await assertProjectOwnership(request, projectId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const existing = await getVisualSubject(subjectId);
  if (!existing || existing.projectId !== projectId) {
    return NextResponse.json({ error: "Visual subject not found" }, { status: 404 });
  }

  const userId = await getUserIdFromRequest(request);
  const body = await request.json();

  const subject = await updateVisualSubject(subjectId, body, userId);
  return NextResponse.json({ subject });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; subjectId: string }> }
) {
  const { id: projectId, subjectId } = await params;
  if (!(await assertProjectOwnership(request, projectId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const existing = await getVisualSubject(subjectId);
  if (!existing || existing.projectId !== projectId) {
    return NextResponse.json({ error: "Visual subject not found" }, { status: 404 });
  }

  await db
    .delete(visualSubjects)
    .where(and(eq(visualSubjects.id, subjectId), eq(visualSubjects.projectId, projectId)));

  return NextResponse.json({ success: true });
}
