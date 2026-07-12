/**
 * v2.0 生成配置服务
 *
 * 手册 §17.1：用户选择生成配置，不选择裸模型。
 * 生成配置将能力、适配器、后端、工作流、默认参数组装成用户可选方案。
 */

import { db } from "@/lib/db";
import {
  generationProfileRevisions,
  generationProfileStates,
  defaultGenerationProfilePointers,
  executionBackends,
} from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import type { Capability } from "../naming";
import { isEnabled, FF } from "@/lib/feature-flags";

/** 生成配置摘要（用户可见） */
export interface GenerationProfileSummary {
  id: string;
  profileKey: string;
  revisionNo: number;
  displayName: string;
  capability: string;
  adapterKind: string;
  enabled: boolean;
  visibility: string;
  createdAtMs: number;
}

/** 生成配置详情（含完整 configJson） */
export interface GenerationProfileDetail extends GenerationProfileSummary {
  revisionDigest: string;
  executionBackendId: string | null;
  workflowPackageDigest: string | null;
  configJson: Record<string, unknown>;
  createdBy: string | null;
}

/** 获取所有已启用的生成配置 */
export async function getEnabledProfiles(
  capability?: Capability,
): Promise<GenerationProfileSummary[]> {
  if (!isEnabled(FF.V2_GENERATION_PROFILES)) {
    return [];
  }

  const rows = await db
    .select({
      id: generationProfileRevisions.id,
      profileKey: generationProfileRevisions.profileKey,
      revisionNo: generationProfileRevisions.revisionNo,
      displayName: generationProfileRevisions.displayName,
      capability: generationProfileRevisions.capability,
      adapterKind: generationProfileRevisions.adapterKind,
      enabled: generationProfileStates.enabled,
      visibility: generationProfileStates.visibility,
      createdAtMs: generationProfileRevisions.createdAtMs,
    })
    .from(generationProfileRevisions)
    .innerJoin(
      generationProfileStates,
      eq(generationProfileRevisions.id, generationProfileStates.generationProfileRevisionId),
    )
    .where(
      capability
        ? and(
            eq(generationProfileStates.enabled, 1),
            eq(generationProfileRevisions.capability, capability),
          )
        : eq(generationProfileStates.enabled, 1),
    )
    .orderBy(desc(generationProfileRevisions.createdAtMs));

  return rows.map((r) => ({
    ...r,
    enabled: r.enabled === 1,
  }));
}

/** 获取单个生成配置详情 */
export async function getProfileDetail(
  profileRevisionId: string,
): Promise<GenerationProfileDetail | null> {
  const [row] = await db
    .select()
    .from(generationProfileRevisions)
    .where(eq(generationProfileRevisions.id, profileRevisionId));

  if (!row) return null;

  const [state] = await db
    .select()
    .from(generationProfileStates)
    .where(eq(generationProfileStates.generationProfileRevisionId, profileRevisionId));

  return {
    id: row.id,
    profileKey: row.profileKey,
    revisionNo: row.revisionNo,
    displayName: row.displayName,
    capability: row.capability,
    adapterKind: row.adapterKind,
    enabled: state?.enabled === 1,
    visibility: state?.visibility ?? "admin",
    createdAtMs: row.createdAtMs,
    revisionDigest: row.revisionDigest,
    executionBackendId: row.executionBackendId,
    workflowPackageDigest: row.workflowPackageDigest,
    configJson: row.configJson as Record<string, unknown>,
    createdBy: row.createdBy,
  };
}

/** 获取默认生成配置 */
export async function getDefaultProfile(
  scopeType: string,
  scopeId: string,
  capability: Capability,
): Promise<GenerationProfileDetail | null> {
  const [pointer] = await db
    .select()
    .from(defaultGenerationProfilePointers)
    .where(
      and(
        eq(defaultGenerationProfilePointers.scopeType, scopeType),
        eq(defaultGenerationProfilePointers.scopeId, scopeId),
        eq(defaultGenerationProfilePointers.capability, capability),
      ),
    );

  if (!pointer) {
    // 回退到全局默认
    const [globalPointer] = await db
      .select()
      .from(defaultGenerationProfilePointers)
      .where(
        and(
          eq(defaultGenerationProfilePointers.scopeType, "global"),
          eq(defaultGenerationProfilePointers.scopeId, "default"),
          eq(defaultGenerationProfilePointers.capability, capability),
        ),
      );

    if (!globalPointer) return null;
    return getProfileDetail(globalPointer.generationProfileRevisionId);
  }

  return getProfileDetail(pointer.generationProfileRevisionId);
}

/** 获取与生成配置关联的后端地址 */
export async function resolveBackendForProfile(
  profileRevisionId: string,
): Promise<{ baseUrl: string; adapterKind: string } | null> {
  const profile = await getProfileDetail(profileRevisionId);
  if (!profile?.executionBackendId) return null;

  const [backend] = await db
    .select({ baseUrl: executionBackends.baseUrl, adapterKind: executionBackends.adapterKind })
    .from(executionBackends)
    .where(eq(executionBackends.id, profile.executionBackendId));

  if (!backend) return null;
  return { baseUrl: backend.baseUrl, adapterKind: backend.adapterKind };
}