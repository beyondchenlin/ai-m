import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { executionBackends, resourcePools, resourcePoolSlots } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { id as genId } from "@/lib/id";
import {
  requireAdmin,
  validateBackendUrlResolved,
  assertPlainObject,
  rejectUnknownKeys,
  readRequiredString,
  readEnum,
  readRecord,
  validateBackendAuthConfig,
  resolveBackendAuthHeaders,

  readJsonBodyLimited,
} from "@/lib/security";
import type { BackendTopology } from "@/lib/security";
import { controlPlaneErrorResponse } from "@/lib/security/api-response";
import { writeAuditEvent, AuditAction, AuditTargetType, sanitizeForLog } from "@/lib/security/audit";
import { isEnabled, FF } from "@/lib/feature-flags";

const TOPOLOGIES = ["same-host", "container-to-host", "same-host-container", "lan-remote"] as const;
const SHARING = ["dedicated", "shared"] as const;
const AUTH_TYPES = ["none", "bearer", "header-token", "basic", "mtls"] as const;
const CAPABILITIES = ["text", "image", "video", "speech", "utility"] as const;
const ALLOWED_KEYS = [
  "displayName", "adapterKind", "baseUrl", "topology", "sharingMode",
  "authType", "authConfigJson", "resourcePoolId", "capabilitiesJson",
] as const;

function assertFeature(): void {
  if (!isEnabled(FF.V2_BACKEND_CONFIG)) throw new Error("v2.0 backend config is not enabled");
}

function parseCapabilities(value: Record<string, unknown> | undefined): { capabilities: string[] } {
  const source = value ?? { capabilities: ["image"] };
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

/** GET /api/admin/backends — list safe backend metadata. */
export async function GET(req: NextRequest) {
  try {
    assertFeature();
    requireAdmin(req);
    const rows = await db.select().from(executionBackends);
    return NextResponse.json({
      backends: rows.map((row) => ({
        ...row,
        authConfigJson: sanitizeForLog(row.authConfigJson as Record<string, unknown>),
      })),
    });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}

/** POST /api/admin/backends — register a disabled backend revision. */
export async function POST(req: NextRequest) {
  try {
    assertFeature();
    const actor = requireAdmin(req);
    const body: unknown = await readJsonBodyLimited(req);
    assertPlainObject(body);
    rejectUnknownKeys(body, ALLOWED_KEYS);

    const displayName = readRequiredString(body, "displayName", { maxLength: 120 });
    const adapterKind = readRequiredString(body, "adapterKind", { maxLength: 80, pattern: /^[a-z0-9][a-z0-9._-]*$/i });
    const baseUrl = readRequiredString(body, "baseUrl", { maxLength: 2048 });
    const topology = readEnum(body, "topology", TOPOLOGIES);
    const sharingMode = readEnum(body, "sharingMode", SHARING);
    const authType = readEnum(body, "authType", AUTH_TYPES);
    const authConfigJson = validateBackendAuthConfig(authType, readRecord(body, "authConfigJson") ?? {});
    await resolveBackendAuthHeaders(authType, authConfigJson);
    const capabilitiesJson = parseCapabilities(readRecord(body, "capabilitiesJson"));
    const validation = await validateBackendUrlResolved(baseUrl, topology as BackendTopology);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.errors.join("; ") }, { status: 400 });
    }

    const poolId = typeof body.resourcePoolId === "string" && body.resourcePoolId.trim()
      ? body.resourcePoolId.trim()
      : "default";
    const [pool] = await db.select().from(resourcePools).where(eq(resourcePools.id, poolId));
    if (!pool) {
      if (poolId !== "default") return NextResponse.json({ error: "resourcePoolId does not exist" }, { status: 400 });
      const now = Date.now();
      db.transaction((tx) => {
        tx.insert(resourcePools).values({
          id: poolId,
          displayName: "Default Resource Pool",
          capacity: 1,
          policyJson: { maxConcurrency: 1 },
          createdAtMs: now,
          updatedAtMs: now,
        }).onConflictDoNothing().run();
        tx.insert(resourcePoolSlots).values({
          resourcePoolId: poolId,
          slotNo: 1,
          ownerAttemptId: null,
          leaseToken: null,
          fencingToken: 0,
          expiresAtMs: null,
          updatedAtMs: now,
        }).onConflictDoNothing().run();
      });
    }

    const now = Date.now();
    const id = genId();
    await db.insert(executionBackends).values({
      id,
      displayName,
      adapterKind,
      baseUrl: new URL(baseUrl).toString().replace(/\/$/, ""),
      topology,
      sharingMode,
      authType,
      authConfigJson,
      tlsConfigJson: {},
      networkPolicyJson: {
        allowRedirect: false,
        resolvedAddresses: validation.resolvedAddresses,
        validatedAtMs: now,
      },
      resourcePoolId: poolId,
      capabilitiesJson,
      enabled: 0,
      createdAtMs: now,
      updatedAtMs: now,
    });
    await writeAuditEvent({
      actorId: actor.id,
      action: AuditAction.BACKEND_CREATED,
      targetType: AuditTargetType.BACKEND,
      targetId: id,
      detailsSafe: { displayName, adapterKind, topology, sharingMode },
    });
    return NextResponse.json({ backend: { id, displayName, adapterKind, enabled: false } }, { status: 201 });
  } catch (error) {
    return controlPlaneErrorResponse(error);
  }
}
