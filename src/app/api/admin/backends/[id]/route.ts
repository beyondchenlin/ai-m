import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { executionBackends } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { validateBackendUrl } from "@/lib/security/network-policy";
import { writeAuditEvent, AuditAction, AuditTargetType, sanitizeForLog } from "@/lib/security/audit";
import { isEnabled, FF } from "@/lib/feature-flags";

/** GET /api/admin/backends/[id] — 获取单个后端详情（不返回密钥） */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isEnabled(FF.V2_BACKEND_CONFIG)) {
    return NextResponse.json({ error: "v2.0 backend config is not enabled" }, { status: 403 });
  }

  const { id } = await params;
  const [row] = await db.select().from(executionBackends).where(eq(executionBackends.id, id));
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  // 脱敏
  return NextResponse.json({
    backend: {
      ...row,
      authConfigJson: sanitizeForLog(row.authConfigJson as Record<string, unknown>),
    },
  });
}

/** PUT /api/admin/backends/[id] — 更新后端配置 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isEnabled(FF.V2_BACKEND_CONFIG)) {
    return NextResponse.json({ error: "v2.0 backend config is not enabled" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();

  const [existing] = await db.select().from(executionBackends).where(eq(executionBackends.id, id));
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  // SSRF 防护：如果更新了 baseUrl 或 topology，校验
  const newBaseUrl = body.baseUrl ?? existing.baseUrl;
  const newTopology = body.topology ?? existing.topology;
  if (body.baseUrl || body.topology) {
    const urlValidation = validateBackendUrl(newBaseUrl, newTopology);
    if (!urlValidation.valid) {
      return NextResponse.json({ error: urlValidation.error }, { status: 400 });
    }
  }

  const now = Date.now();
  const updates: Record<string, unknown> = { updatedAtMs: now };

  const allowedFields = [
    "displayName", "baseUrl", "topology", "sharingMode",
    "authType", "authConfigJson", "tlsConfigJson", "networkPolicyJson",
    "resourcePoolId", "capabilitiesJson", "enabled",
  ];
  for (const field of allowedFields) {
    if (body[field] !== undefined) updates[field] = body[field];
  }

  await db.update(executionBackends).set(updates).where(eq(executionBackends.id, id));

  // 审计日志
  await writeAuditEvent({
    action: AuditAction.BACKEND_UPDATED,
    targetType: AuditTargetType.BACKEND,
    targetId: id,
    detailsSafe: { changedFields: Object.keys(updates).filter((k) => k !== "updatedAtMs") },
  });

  return NextResponse.json({ updated: id });
}

/** DELETE /api/admin/backends/[id] — 删除后端 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isEnabled(FF.V2_BACKEND_CONFIG)) {
    return NextResponse.json({ error: "v2.0 backend config is not enabled" }, { status: 403 });
  }

  const { id } = await params;
  await db.delete(executionBackends).where(eq(executionBackends.id, id));

  // 审计日志
  await writeAuditEvent({
    action: AuditAction.BACKEND_DELETED,
    targetType: AuditTargetType.BACKEND,
    targetId: id,
  });

  return NextResponse.json({ deleted: id });
}