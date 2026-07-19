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
  workflowBackendValidations,
  workflowPackageRevisions,
  workflowPackageStates,
} from "@/lib/db/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { isEnabled, FF } from "@/lib/feature-flags";
import {
  allowedWorkflowValidationKinds,
  selectApplicableWorkflowValidation,
} from "@/lib/generation/workflows";

type ProfileCapability = typeof generationProfileRevisions.$inferSelect.capability;
type DefaultProfileCapability = typeof defaultGenerationProfilePointers.$inferSelect.capability;
type ProfileScope = typeof defaultGenerationProfilePointers.$inferSelect.scopeType;

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
  capability?: ProfileCapability,
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
      executionBackendId: generationProfileRevisions.executionBackendId,
      workflowPackageDigest: generationProfileRevisions.workflowPackageDigest,
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

  const comfyRows = rows.filter((row) => row.adapterKind === "comfyui");
  if (!comfyRows.length) {
    return rows.map(({ executionBackendId: _backend, workflowPackageDigest: _workflow, ...row }) => ({
      ...row, enabled: row.enabled === 1,
    }));
  }

  const backendIds = [...new Set(comfyRows.map((row) => row.executionBackendId).filter((id): id is string => Boolean(id)))];
  const workflowDigests = [...new Set(comfyRows.map((row) => row.workflowPackageDigest).filter((id): id is string => Boolean(id)))];
  type BackendState = { id: string; enabled: number; fingerprint: string | null };
  type WorkflowState = { digest: string; lockDigest: string | null; state: string };
  type BackendValidation = typeof workflowBackendValidations.$inferSelect;
  const backends: BackendState[] = backendIds.length
    ? await db.select({
        id: executionBackends.id,
        enabled: executionBackends.enabled,
        fingerprint: executionBackends.environmentFingerprint,
      }).from(executionBackends).where(inArray(executionBackends.id, backendIds))
    : [];
  const workflows: WorkflowState[] = workflowDigests.length
    ? await db.select({
        digest: workflowPackageRevisions.digest,
        lockDigest: workflowPackageRevisions.environmentLockDigest,
        state: workflowPackageStates.state,
      }).from(workflowPackageRevisions)
        .innerJoin(
          workflowPackageStates,
          eq(workflowPackageStates.workflowPackageDigest, workflowPackageRevisions.digest),
        )
        .where(inArray(workflowPackageRevisions.digest, workflowDigests))
    : [];
  const validations: BackendValidation[] = workflowDigests.length
    ? await db.select().from(workflowBackendValidations)
        .where(and(
          inArray(workflowBackendValidations.workflowPackageDigest, workflowDigests),
          inArray(workflowBackendValidations.validationKind, allowedWorkflowValidationKinds()),
        ))
    : [];
  const backendById = new Map(backends.map((backend) => [backend.id, backend]));
  const workflowByDigest = new Map(workflows.map((workflow) => [workflow.digest, workflow]));
  const validationsByPair = new Map<string, BackendValidation[]>();
  for (const validation of validations) {
    const key = `${validation.executionBackendId}:${validation.workflowPackageDigest}`;
    validationsByPair.set(key, [...(validationsByPair.get(key) ?? []), validation]);
  }

  return rows.filter((row) => {
    if (row.adapterKind !== "comfyui") return true;
    if (!row.executionBackendId || !row.workflowPackageDigest) return false;
    const backend = backendById.get(row.executionBackendId);
    const workflow = workflowByDigest.get(row.workflowPackageDigest);
    const validation = selectApplicableWorkflowValidation(
      validationsByPair.get(`${row.executionBackendId}:${row.workflowPackageDigest}`) ?? [],
      {
        workflowState: workflow?.state ?? "",
        backendFingerprint: backend?.fingerprint ?? null,
        workflowLockDigest: workflow?.lockDigest ?? null,
      },
    );
    return Boolean(
      backend?.enabled
      && validation
    );
  }).map(({ executionBackendId: _backend, workflowPackageDigest: _workflow, ...row }) => ({
    ...row, enabled: row.enabled === 1,
  }));
}


/** Return only workspace-scoped profiles that may be exposed in ordinary model selectors. */
export async function getSelectableProfiles(
  capability?: ProfileCapability,
): Promise<GenerationProfileSummary[]> {
  const profiles = await getEnabledProfiles(capability);
  return profiles.filter((profile) => profile.visibility === "workspace");
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

export async function resolveRunnableProfile(profileRevisionId: string): Promise<GenerationProfileDetail | null> {
  const profile = await getProfileDetail(profileRevisionId);
  if (!profile?.enabled) return null;
  const runnable = await getEnabledProfiles(profile.capability as ProfileCapability);
  return runnable.some((candidate) => candidate.id === profileRevisionId) ? profile : null;
}

/** 获取默认生成配置 */
export async function getDefaultProfile(
  scopeType: ProfileScope,
  scopeId: string,
  capability: DefaultProfileCapability,
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
    return resolveRunnableProfile(globalPointer.generationProfileRevisionId);
  }

  return resolveRunnableProfile(pointer.generationProfileRevisionId);
}

/** 获取与生成配置关联的后端地址 */
export async function resolveBackendForProfile(
  profileRevisionId: string,
): Promise<{ baseUrl: string; adapterKind: string } | null> {
  const profile = await resolveRunnableProfile(profileRevisionId);
  if (!profile?.executionBackendId) return null;

  const [backend] = await db
    .select({ baseUrl: executionBackends.baseUrl, adapterKind: executionBackends.adapterKind, enabled: executionBackends.enabled })
    .from(executionBackends)
    .where(eq(executionBackends.id, profile.executionBackendId));

  if (!backend || !backend.enabled) return null;
  return { baseUrl: backend.baseUrl, adapterKind: backend.adapterKind };
}
