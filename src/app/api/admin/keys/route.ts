import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { keyReferences } from "@/lib/db/schema";
import { id as genId } from "@/lib/id";
import {
  requireAdmin,
  assertPlainObject,
  rejectUnknownKeys,
  readRequiredString,
  readEnum,
  encryptSecret,
  assertSafeBackendHeaderValue,

  readJsonBodyLimited,
} from "@/lib/security";
import { controlPlaneErrorResponse } from "@/lib/security/api-response";
import { writeAuditEvent, AuditAction, AuditTargetType } from "@/lib/security/audit";
import { isEnabled, FF } from "@/lib/feature-flags";

const KEY_TYPES = ["bearer", "header-token", "basic", "mtls-key"] as const;

export async function GET(req: NextRequest) {
  try {
    if (!isEnabled(FF.V2_BACKEND_CONFIG)) throw new Error("v2.0 backend config is not enabled");
    requireAdmin(req);
    const rows = await db.select({
      id: keyReferences.id,
      label: keyReferences.label,
      keyType: keyReferences.keyType,
      createdBy: keyReferences.createdBy,
      createdAtMs: keyReferences.createdAtMs,
      updatedAtMs: keyReferences.updatedAtMs,
    }).from(keyReferences);
    return NextResponse.json({ keys: rows });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!isEnabled(FF.V2_BACKEND_CONFIG)) throw new Error("v2.0 backend config is not enabled");
    const actor = requireAdmin(req);
    const body: unknown = await readJsonBodyLimited(req);
    assertPlainObject(body);
    rejectUnknownKeys(body, ["label", "keyType", "secretValue"]);
    const label = readRequiredString(body, "label", { maxLength: 120 });
    const keyType = readEnum(body, "keyType", KEY_TYPES);
    const secretValue = readRequiredString(body, "secretValue", { maxLength: 64 * 1024 });
    assertSafeBackendHeaderValue(keyType, secretValue);
    const now = Date.now();
    const id = genId();
    await db.insert(keyReferences).values({
      id,
      label,
      keyType,
      secretValue: encryptSecret(secretValue),
      createdBy: actor.id,
      createdAtMs: now,
      updatedAtMs: now,
    });
    await writeAuditEvent({
      actorId: actor.id,
      action: AuditAction.KEY_CREATED,
      targetType: AuditTargetType.KEY,
      targetId: id,
      detailsSafe: { label, keyType },
    });
    return NextResponse.json({ key: { id, label, keyType, createdAtMs: now } }, { status: 201 });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
