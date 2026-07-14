import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import {
  generationProfileRevisions, generationProfileStates, workflowBackendValidations,
  workflowPackageRevisions, workflowPackageStates, executionBackends,
} from "@/lib/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { id as genId } from "@/lib/id";
import {
  requireAdmin, assertPlainObject, rejectUnknownKeys, readRequiredString, readEnum,
  readRecord, readJsonBodyLimited,
} from "@/lib/security";
import { controlPlaneErrorResponse } from "@/lib/security/api-response";
import { writeAuditEvent, AuditAction, AuditTargetType } from "@/lib/security/audit";
import { isEnabled, FF } from "@/lib/feature-flags";

const CAPABILITIES = ["text", "image", "video", "speech", "utility"] as const;

export async function GET(req: NextRequest) {
  try {
    if (!isEnabled(FF.V2_GENERATION_PROFILES)) throw new Error("v2.0 generation profiles is not enabled");
    requireAdmin(req);
    const rows = await db.select().from(generationProfileRevisions).orderBy(desc(generationProfileRevisions.createdAtMs));
    return NextResponse.json({ profiles: rows });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!isEnabled(FF.V2_GENERATION_PROFILES)) throw new Error("v2.0 generation profiles is not enabled");
    const actor = requireAdmin(req);
    const body: unknown = await readJsonBodyLimited(req);
    assertPlainObject(body);
    rejectUnknownKeys(body, ["profileKey", "displayName", "capability", "adapterKind", "executionBackendId", "workflowPackageDigest", "configJson"]);
    const profileKey = readRequiredString(body, "profileKey", { maxLength: 120, pattern: /^[a-z0-9][a-z0-9._-]*$/i });
    const displayName = readRequiredString(body, "displayName", { maxLength: 160 });
    const capability = readEnum(body, "capability", CAPABILITIES);
    const adapterKind = readRequiredString(body, "adapterKind", { maxLength: 80, pattern: /^[a-z0-9][a-z0-9._-]*$/i });
    const configJson = readRecord(body, "configJson") ?? {};
    const executionBackendId = typeof body.executionBackendId === "string" ? body.executionBackendId.trim() : null;
    const workflowPackageDigest = typeof body.workflowPackageDigest === "string" ? body.workflowPackageDigest.trim() : null;

    let backend: typeof executionBackends.$inferSelect | undefined;
    if (executionBackendId) {
      [backend] = await db.select().from(executionBackends).where(eq(executionBackends.id, executionBackendId));
      if (!backend || !backend.enabled || !backend.environmentFingerprint) {
        return NextResponse.json({ error: "execution backend must exist, be enabled, and have a validated environment fingerprint" }, { status: 409 });
      }
    }

    if (adapterKind === "comfyui" && (!executionBackendId || !workflowPackageDigest)) {
      return NextResponse.json({ error: "ComfyUI profiles require an exact execution backend and workflow package" }, { status: 400 });
    }

    if (workflowPackageDigest) {
      const [workflow] = await db.select({
        state: workflowPackageStates.state,
        capability: workflowPackageRevisions.capability,
        environmentLockDigest: workflowPackageRevisions.environmentLockDigest,
      }).from(workflowPackageRevisions).innerJoin(
        workflowPackageStates,
        eq(workflowPackageStates.workflowPackageDigest, workflowPackageRevisions.digest),
      ).where(eq(workflowPackageRevisions.digest, workflowPackageDigest));
      if (!workflow || workflow.state !== "active") {
        return NextResponse.json({ error: "workflow package must be active" }, { status: 409 });
      }
      if (workflow.capability !== capability) {
        return NextResponse.json({ error: "workflow capability does not match profile capability" }, { status: 409 });
      }
      if (executionBackendId && backend) {
        const [validation] = await db.select().from(workflowBackendValidations).where(and(
          eq(workflowBackendValidations.workflowPackageDigest, workflowPackageDigest),
          eq(workflowBackendValidations.executionBackendId, executionBackendId),
        ));
        if (!validation
          || validation.environmentFingerprint !== backend.environmentFingerprint
          || validation.environmentLockDigest !== workflow.environmentLockDigest) {
          return NextResponse.json({ error: "workflow package is not validated for this exact backend environment" }, { status: 409 });
        }
      }
    }

    const [latest] = await db.select({ revisionNo: generationProfileRevisions.revisionNo })
      .from(generationProfileRevisions)
      .where(eq(generationProfileRevisions.profileKey, profileKey))
      .orderBy(desc(generationProfileRevisions.revisionNo)).limit(1);
    const revisionNo = (latest?.revisionNo ?? 0) + 1;
    const normalized = JSON.stringify({ profileKey, revisionNo, displayName, capability, adapterKind, executionBackendId, workflowPackageDigest, configJson });
    const revisionDigest = `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
    const id = genId();
    const now = Date.now();
    await db.insert(generationProfileRevisions).values({
      id, profileKey, revisionNo, revisionDigest, displayName, capability, adapterKind,
      executionBackendId, workflowPackageDigest, configJson, createdBy: actor.id, createdAtMs: now,
    });
    await db.insert(generationProfileStates).values({ generationProfileRevisionId: id, enabled: 0, visibility: "admin", updatedAtMs: now });
    await writeAuditEvent({ actorId: actor.id, action: AuditAction.PROFILE_CREATED, targetType: AuditTargetType.PROFILE, targetId: id, detailsSafe: { profileKey, revisionNo, capability, adapterKind } });
    return NextResponse.json({ profile: { id, profileKey, revisionNo, revisionDigest, displayName } }, { status: 201 });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
