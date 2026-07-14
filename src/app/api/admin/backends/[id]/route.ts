import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { executionBackends, resourcePools, workflowBackendValidations } from "@/lib/db/schema";
import { FF, isEnabled } from "@/lib/feature-flags";
import {
  assertPlainObject,
  readBoolean,
  readEnum,
  readOptionalString,
  readRecord,
  rejectUnknownKeys,
  requireAdmin,
  validateBackendAuthConfig,
  resolveBackendAuthHeaders,
  validateBackendUrlResolved,

  readJsonBodyLimited,
} from "@/lib/security";
import type { BackendAuthType, BackendTopology } from "@/lib/security";
import { controlPlaneErrorResponse } from "@/lib/security/api-response";
import { AuditAction, AuditTargetType, sanitizeForLog, writeAuditEvent } from "@/lib/security/audit";

const TOPOLOGIES = ["same-host", "container-to-host", "same-host-container", "lan-remote"] as const;
const SHARING = ["dedicated", "shared"] as const;
const AUTH_TYPES = ["none", "bearer", "header-token", "basic", "mtls"] as const;
const CAPABILITIES = ["text", "image", "video", "speech", "utility"] as const;
const ALLOWED_FIELDS = [
  "displayName", "baseUrl", "topology", "sharingMode", "authType",
  "authConfigJson", "resourcePoolId", "capabilitiesJson", "enabled",
] as const;

function ensureFeature(): void {
  if (!isEnabled(FF.V2_BACKEND_CONFIG)) throw new Error("v2.0 backend config is not enabled");
}

function parseCapabilities(value: Record<string, unknown> | undefined, fallback: unknown): Record<string, unknown> {
  const source = value ?? (fallback && typeof fallback === "object" && !Array.isArray(fallback)
    ? fallback as Record<string, unknown>
    : {});
  rejectUnknownKeys(source, ["capabilities"]);
  const list = source.capabilities;
  if (!Array.isArray(list) || list.length < 1 || list.length > CAPABILITIES.length) {
    throw new Error("capabilitiesJson.capabilities must be a non-empty array");
  }
  const capabilities = [...new Set(list.map((item) => {
    if (typeof item !== "string" || !CAPABILITIES.includes(item as typeof CAPABILITIES[number])) {
      throw new Error(`Unsupported backend capability: ${String(item)}`);
    }
    return item;
  }))];
  return { capabilities };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    ensureFeature();
    requireAdmin(req);
    const { id } = await params;
    const [row] = await db.select().from(executionBackends).where(eq(executionBackends.id, id));
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({
      backend: { ...row, authConfigJson: sanitizeForLog(row.authConfigJson as Record<string, unknown>) },
    });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    ensureFeature();
    const actor = requireAdmin(req);
    const { id } = await params;
    const body: unknown = await readJsonBodyLimited(req);
    assertPlainObject(body);
    rejectUnknownKeys(body, ALLOWED_FIELDS);
    const [existing] = await db.select().from(executionBackends).where(eq(executionBackends.id, id));
    if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

    const requestedEnabled = readBoolean(body, "enabled");
    if (requestedEnabled === true && !existing.enabled) {
      return NextResponse.json(
        { error: "Backends can only be enabled by the workflow promotion command after live validation" },
        { status: 409 },
      );
    }

    const displayName = readOptionalString(body, "displayName", { maxLength: 120 }) ?? existing.displayName;
    if (!displayName) throw new Error("displayName cannot be empty");
    const baseUrl = readOptionalString(body, "baseUrl", { maxLength: 2048 }) ?? existing.baseUrl;
    const topology = body.topology === undefined
      ? existing.topology as BackendTopology
      : readEnum(body, "topology", TOPOLOGIES) as BackendTopology;
    const sharingMode = body.sharingMode === undefined
      ? existing.sharingMode
      : readEnum(body, "sharingMode", SHARING);
    const authType = body.authType === undefined
      ? existing.authType as BackendAuthType
      : readEnum(body, "authType", AUTH_TYPES) as BackendAuthType;
    const authConfigJson = validateBackendAuthConfig(authType, readRecord(body, "authConfigJson") ?? existing.authConfigJson);
    await resolveBackendAuthHeaders(authType, authConfigJson);
    const capabilitiesJson = parseCapabilities(readRecord(body, "capabilitiesJson"), existing.capabilitiesJson);
    const resourcePoolId = readOptionalString(body, "resourcePoolId", { maxLength: 160 }) ?? existing.resourcePoolId;
    const [pool] = await db.select({ id: resourcePools.id }).from(resourcePools).where(eq(resourcePools.id, resourcePoolId));
    if (!pool) return NextResponse.json({ error: "resourcePoolId does not exist" }, { status: 400 });

    const validation = await validateBackendUrlResolved(baseUrl, topology);
    if (!validation.valid) return NextResponse.json({ error: validation.errors.join("; ") }, { status: 400 });

    const executionRelevantChange =
      baseUrl !== existing.baseUrl || topology !== existing.topology || sharingMode !== existing.sharingMode ||
      authType !== existing.authType || JSON.stringify(authConfigJson) !== JSON.stringify(existing.authConfigJson) ||
      resourcePoolId !== existing.resourcePoolId || JSON.stringify(capabilitiesJson) !== JSON.stringify(existing.capabilitiesJson);
    const now = Date.now();
    db.transaction((tx) => {
      tx.update(executionBackends).set({
        displayName,
        baseUrl: new URL(baseUrl).toString().replace(/\/$/, ""),
        topology,
        sharingMode,
        authType,
        authConfigJson,
        resourcePoolId,
        capabilitiesJson,
        enabled: requestedEnabled === false || executionRelevantChange ? 0 : existing.enabled,
        environmentFingerprint: executionRelevantChange ? null : existing.environmentFingerprint,
        featureSnapshotJson: executionRelevantChange ? null : existing.featureSnapshotJson,
        validatedAtMs: executionRelevantChange ? null : existing.validatedAtMs,
        networkPolicyJson: {
          allowRedirect: false,
          resolvedAddresses: validation.resolvedAddresses,
          validatedAtMs: now,
        },
        updatedAtMs: now,
      }).where(eq(executionBackends.id, id)).run();
      if (executionRelevantChange) {
        tx.delete(workflowBackendValidations).where(eq(workflowBackendValidations.executionBackendId, id)).run();
      }
    });

    await writeAuditEvent({
      actorId: actor.id,
      action: AuditAction.BACKEND_UPDATED,
      targetType: AuditTargetType.BACKEND,
      targetId: id,
      detailsSafe: { changedFields: Object.keys(body), invalidatedValidation: executionRelevantChange },
    });
    return NextResponse.json({ updated: id, requiresRevalidation: executionRelevantChange });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    ensureFeature();
    const actor = requireAdmin(req);
    const { id } = await params;
    const [existing] = await db.select().from(executionBackends).where(eq(executionBackends.id, id));
    if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (existing.enabled) return NextResponse.json({ error: "Disable the backend before deleting it" }, { status: 409 });
    await db.delete(executionBackends).where(eq(executionBackends.id, id));
    await writeAuditEvent({ actorId: actor.id, action: AuditAction.BACKEND_DELETED, targetType: AuditTargetType.BACKEND, targetId: id });
    return NextResponse.json({ deleted: id });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
