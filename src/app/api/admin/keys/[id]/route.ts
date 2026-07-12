import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { keyReferences } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { writeAuditEvent, AuditAction, AuditTargetType } from "@/lib/security/audit";
import { isEnabled, FF } from "@/lib/feature-flags";

/** DELETE /api/admin/keys/[id] — 删除密钥引用 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isEnabled(FF.V2_BACKEND_CONFIG)) {
    return NextResponse.json({ error: "v2.0 backend config is not enabled" }, { status: 403 });
  }

  const { id } = await params;
  await db.delete(keyReferences).where(eq(keyReferences.id, id));

  // 审计日志
  await writeAuditEvent({
    action: AuditAction.KEY_DELETED,
    targetType: AuditTargetType.KEY,
    targetId: id,
  });

  return NextResponse.json({ deleted: id });
}

/** GET /api/admin/keys/[id] — 获取单个密钥引用（含密钥值，仅管理接口） */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isEnabled(FF.V2_BACKEND_CONFIG)) {
    return NextResponse.json({ error: "v2.0 backend config is not enabled" }, { status: 403 });
  }

  const { id } = await params;
  const [row] = await db.select().from(keyReferences).where(eq(keyReferences.id, id));
  if (!row) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // 审计：记录密钥访问
  await writeAuditEvent({
    action: AuditAction.KEY_ACCESSED,
    targetType: AuditTargetType.KEY,
    targetId: id,
  });

  return NextResponse.json({ key: row });
}