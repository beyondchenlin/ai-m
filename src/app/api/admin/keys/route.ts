import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { keyReferences } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { id as genId } from "@/lib/id";
import { writeAuditEvent, AuditAction, AuditTargetType, maskKey } from "@/lib/security/audit";
import { isEnabled, FF } from "@/lib/feature-flags";

/** GET /api/admin/keys — 列出所有密钥引用（不返回密钥值，只返回脱敏信息） */
export async function GET() {
  if (!isEnabled(FF.V2_BACKEND_CONFIG)) {
    return NextResponse.json({ error: "v2.0 backend config is not enabled" }, { status: 403 });
  }

  const rows = await db.select({
    id: keyReferences.id,
    label: keyReferences.label,
    keyType: keyReferences.keyType,
    createdBy: keyReferences.createdBy,
    createdAtMs: keyReferences.createdAtMs,
    /** 密钥值脱敏：只显示前4后4位 */
    secretPreview: keyReferences.secretValue,
  }).from(keyReferences);

  const keys = rows.map((r) => ({
    ...r,
    secretPreview: maskKey(r.secretPreview),
  }));

  return NextResponse.json({ keys });
}

/** POST /api/admin/keys — 创建密钥引用 */
export async function POST(req: NextRequest) {
  if (!isEnabled(FF.V2_BACKEND_CONFIG)) {
    return NextResponse.json({ error: "v2.0 backend config is not enabled" }, { status: 403 });
  }

  const body = await req.json();
  const { label, keyType, secretValue } = body;

  if (!label || !keyType || !secretValue) {
    return NextResponse.json({ error: "label, keyType, secretValue are required" }, { status: 400 });
  }

  const validTypes = ["bearer", "header-token", "basic", "mtls-key"];
  if (!validTypes.includes(keyType)) {
    return NextResponse.json({ error: `keyType must be one of: ${validTypes.join(", ")}` }, { status: 400 });
  }

  const now = Date.now();
  const id = genId();
  await db.insert(keyReferences).values({
    id,
    label,
    keyType,
    secretValue,
    createdBy: "admin",
    createdAtMs: now,
    updatedAtMs: now,
  });

  // 审计日志：不记录密钥值
  await writeAuditEvent({
    action: AuditAction.KEY_CREATED,
    targetType: AuditTargetType.KEY,
    targetId: id,
    detailsSafe: { label, keyType },
  });

  return NextResponse.json({
    key: { id, label, keyType, createdAtMs: now },
  }, { status: 201 });
}