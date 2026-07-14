import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { executionBackends, keyReferences } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/security";
import { controlPlaneErrorResponse } from "@/lib/security/api-response";
import { writeAuditEvent, AuditAction, AuditTargetType } from "@/lib/security/audit";
import { isEnabled, FF } from "@/lib/feature-flags";

function referencesKey(value: unknown, keyId: string): boolean {
  if (value === keyId) return true;
  if (Array.isArray(value)) return value.some((item) => referencesKey(item, keyId));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) => referencesKey(item, keyId));
  }
  return false;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isEnabled(FF.V2_BACKEND_CONFIG)) throw new Error("v2.0 backend config is not enabled");
    const actor = requireAdmin(req);
    const { id } = await params;
    const [row] = await db.select({
      id: keyReferences.id,
      label: keyReferences.label,
      keyType: keyReferences.keyType,
      createdBy: keyReferences.createdBy,
      createdAtMs: keyReferences.createdAtMs,
      updatedAtMs: keyReferences.updatedAtMs,
    }).from(keyReferences).where(eq(keyReferences.id, id));
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    await writeAuditEvent({ actorId: actor.id, action: AuditAction.KEY_ACCESSED, targetType: AuditTargetType.KEY, targetId: id });
    return NextResponse.json({ key: row });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isEnabled(FF.V2_BACKEND_CONFIG)) throw new Error("v2.0 backend config is not enabled");
    const actor = requireAdmin(req);
    const { id } = await params;
    const backends = await db.select({ id: executionBackends.id, authConfigJson: executionBackends.authConfigJson })
      .from(executionBackends);
    const inUse = backends.find((backend) => referencesKey(backend.authConfigJson, id));
    if (inUse) {
      return NextResponse.json({ error: "Disable or reconfigure the referencing backend before deleting this key" }, { status: 409 });
    }
    await db.delete(keyReferences).where(eq(keyReferences.id, id));
    await writeAuditEvent({ actorId: actor.id, action: AuditAction.KEY_DELETED, targetType: AuditTargetType.KEY, targetId: id });
    return NextResponse.json({ deleted: id });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
