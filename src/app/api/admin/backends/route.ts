import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { executionBackends, resourcePools } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { id as genId } from "@/lib/id";
import { validateBackendUrl } from "@/lib/security/network-policy";
import { writeAuditEvent, AuditAction, AuditTargetType, sanitizeForLog } from "@/lib/security/audit";
import { isEnabled, FF } from "@/lib/feature-flags";

/** GET /api/admin/backends — 列出所有执行后端（不返回密钥） */
export async function GET() {
  if (!isEnabled(FF.V2_BACKEND_CONFIG)) {
    return NextResponse.json({ error: "v2.0 backend config is not enabled" }, { status: 403 });
  }

  const rows = await db.select().from(executionBackends);

  // 脱敏：移除 authConfigJson 中的密钥引用细节
  const safe = rows.map((r) => ({
    ...r,
    authConfigJson: sanitizeForLog(r.authConfigJson as Record<string, unknown>),
  }));

  return NextResponse.json({ backends: safe });
}

/** POST /api/admin/backends — 注册执行后端 */
export async function POST(req: NextRequest) {
  if (!isEnabled(FF.V2_BACKEND_CONFIG)) {
    return NextResponse.json({ error: "v2.0 backend config is not enabled" }, { status: 403 });
  }

  const body = await req.json();
  const {
    displayName, adapterKind, baseUrl, topology, sharingMode,
    authType, authConfigJson, keyRefIds, resourcePoolId,
  } = body;

  if (!displayName || !adapterKind || !baseUrl || !topology || !sharingMode || !authType) {
    return NextResponse.json({
      error: "displayName, adapterKind, baseUrl, topology, sharingMode, authType are required",
    }, { status: 400 });
  }

  // SSRF 防护：校验后端 URL
  const urlValidation = validateBackendUrl(baseUrl, topology);
  if (!urlValidation.valid) {
    return NextResponse.json({ error: urlValidation.error }, { status: 400 });
  }

  // 确保资源池存在
  let poolId = resourcePoolId;
  if (!poolId) {
    poolId = "default";
    const [existing] = await db.select().from(resourcePools).where(eq(resourcePools.id, poolId));
    if (!existing) {
      const now = Date.now();
      await db.insert(resourcePools).values({
        id: poolId,
        displayName: "Default Resource Pool",
        capacity: 1,
        policyJson: { maxConcurrency: 1 },
        createdAtMs: now,
        updatedAtMs: now,
      });
    }
  }

  const now = Date.now();
  const id = genId();

  await db.insert(executionBackends).values({
    id,
    displayName,
    adapterKind,
    baseUrl: baseUrl.trim(),
    topology,
    sharingMode,
    authType: authType || "none",
    authConfigJson: authConfigJson || { keyRefIds: keyRefIds || [] },
    tlsConfigJson: {},
    networkPolicyJson: { allowRedirect: false, allowedHosts: [] },
    resourcePoolId: poolId,
    capabilitiesJson: { capabilities: ["image"] },
    enabled: 0,
    createdAtMs: now,
    updatedAtMs: now,
  });

  // 审计日志
  await writeAuditEvent({
    action: AuditAction.BACKEND_CREATED,
    targetType: AuditTargetType.BACKEND,
    targetId: id,
    detailsSafe: { displayName, adapterKind, topology, sharingMode },
  });

  return NextResponse.json({ backend: { id, displayName, adapterKind } }, { status: 201 });
}