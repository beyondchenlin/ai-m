import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generationProfileRevisions, generationProfileStates } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { id as genId } from "@/lib/id";
import { createHash } from "crypto";
import { writeAuditEvent, AuditAction, AuditTargetType } from "@/lib/security/audit";
import { isEnabled, FF } from "@/lib/feature-flags";

/** GET /api/admin/profiles — 列出所有生成配置 */
export async function GET() {
  if (!isEnabled(FF.V2_GENERATION_PROFILES)) {
    return NextResponse.json({ error: "v2.0 generation profiles is not enabled" }, { status: 403 });
  }

  const rows = await db
    .select()
    .from(generationProfileRevisions)
    .orderBy(desc(generationProfileRevisions.createdAtMs));

  return NextResponse.json({ profiles: rows });
}

/** POST /api/admin/profiles — 创建生成配置修订版 */
export async function POST(req: NextRequest) {
  if (!isEnabled(FF.V2_GENERATION_PROFILES)) {
    return NextResponse.json({ error: "v2.0 generation profiles is not enabled" }, { status: 403 });
  }

  const body = await req.json();
  const {
    profileKey, displayName, capability, adapterKind,
    executionBackendId, workflowPackageDigest, configJson,
  } = body;

  if (!profileKey || !displayName || !capability || !adapterKind || !configJson) {
    return NextResponse.json({
      error: "profileKey, displayName, capability, adapterKind, configJson are required",
    }, { status: 400 });
  }

  // 计算下一修订号
  const [latest] = await db
    .select({ revisionNo: generationProfileRevisions.revisionNo })
    .from(generationProfileRevisions)
    .where(eq(generationProfileRevisions.profileKey, profileKey))
    .orderBy(desc(generationProfileRevisions.revisionNo))
    .limit(1);

  const revisionNo = (latest?.revisionNo ?? 0) + 1;
  const now = Date.now();
  const id = genId();
  const revisionDigest = `sha256:${createHash("sha256").update(JSON.stringify(configJson)).digest("hex")}`;

  await db.insert(generationProfileRevisions).values({
    id,
    profileKey,
    revisionNo,
    revisionDigest,
    displayName,
    capability,
    adapterKind,
    executionBackendId: executionBackendId || null,
    workflowPackageDigest: workflowPackageDigest || null,
    configJson,
    createdBy: "admin",
    createdAtMs: now,
  });

  // 创建状态记录
  await db.insert(generationProfileStates).values({
    generationProfileRevisionId: id,
    enabled: 0,
    visibility: "admin",
    updatedAtMs: now,
  });

  // 审计日志
  await writeAuditEvent({
    action: AuditAction.PROFILE_CREATED,
    targetType: AuditTargetType.PROFILE,
    targetId: id,
    detailsSafe: { profileKey, revisionNo, capability, adapterKind },
  });

  return NextResponse.json({
    profile: { id, profileKey, revisionNo, revisionDigest, displayName },
  }, { status: 201 });
}