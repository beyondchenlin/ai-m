/**
 * 视觉主体 API 路由
 * 
 * GET  - 列出项目的视觉主体
 * POST - 创建视觉主体（支持 action=import_from_character 从漫剧角色导入）
 */

import { NextResponse } from "next/server";
import { assertProjectOwnership } from "@/lib/assert-project-ownership";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import {
  createVisualSubject,
  listVisualSubjects,
  importFromCharacter,
} from "@/lib/generation/visual-subjects";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  if (!(await assertProjectOwnership(request, projectId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const subjects = await listVisualSubjects(projectId);
  return NextResponse.json({ subjects });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const project = await assertProjectOwnership(request, projectId);
  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const userId = await getUserIdFromRequest(request);
  const body = await request.json();
  const { action, characterId, ...input } = body;

  // 从漫剧角色导入
  if (action === "import_from_character") {
    if (!characterId) {
      return NextResponse.json(
        { error: "characterId is required for import_from_character" },
        { status: 400 }
      );
    }
    const subject = await importFromCharacter(characterId, projectId, userId);
    return NextResponse.json({ subject }, { status: 201 });
  }

  // 创建新视觉主体
  const subject = await createVisualSubject({
    ...input,
    projectId,
    userId,
  });

  return NextResponse.json({ subject }, { status: 201 });
}
