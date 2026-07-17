/** Review and activate one exact workflow digest after a live backend validation. */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  defaultGenerationProfilePointers,
  executionBackends,
  generationProfileRevisions,
  generationProfileStates,
  workflowBackendValidations,
  workflowPackageRevisions,
  workflowPackageStates,
} from "@/lib/db/schema";
import {
  createComfyUITransport,
  probeBackendFeatures,
  probeModelFolder,
  probeObjectInfo,
} from "@/lib/generation/transports";
import {
  assertWorkflowPromotionPolicy,
  normalizeComfyWorkflow,
  parseWorkflowManifest,
  sha256,
} from "@/lib/generation/workflows";
import { resolveBackendAuthHeaders } from "@/lib/security";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function allowSelfReview(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.ALLOW_WORKFLOW_SELF_REVIEW === "true";
}

async function main(): Promise<void> {
  const digest = process.env.WORKFLOW_DIGEST?.trim();
  const confirmation = process.env.CONFIRM_WORKFLOW_DIGEST?.trim();
  const environmentConfirmation = process.env.CONFIRM_ENVIRONMENT_LOCK_DIGEST?.trim();
  const backendId = process.env.EXECUTION_BACKEND_ID?.trim();
  const reviewer = process.env.WORKFLOW_REVIEWER_ID?.trim();
  if (!digest || confirmation !== digest) {
    throw new Error("WORKFLOW_DIGEST and identical CONFIRM_WORKFLOW_DIGEST are required");
  }
  if (!backendId) throw new Error("EXECUTION_BACKEND_ID is required");
  if (!reviewer || reviewer === "system") throw new Error("A named WORKFLOW_REVIEWER_ID is required");

  const [row] = await db.select({ revision: workflowPackageRevisions, state: workflowPackageStates })
    .from(workflowPackageRevisions)
    .innerJoin(
      workflowPackageStates,
      eq(workflowPackageStates.workflowPackageDigest, workflowPackageRevisions.digest),
    )
    .where(eq(workflowPackageRevisions.digest, digest));
  if (!row) throw new Error("Workflow revision not found");
  if (["revoked", "invalid"].includes(row.state.state)) {
    throw new Error(`Workflow state ${row.state.state} cannot be promoted`);
  }
  if (!row.revision.environmentLockDigest || environmentConfirmation !== row.revision.environmentLockDigest) {
    throw new Error("CONFIRM_ENVIRONMENT_LOCK_DIGEST must exactly match the immutable package lock");
  }

  const previousReport = record(row.state.validationReportJson);
  const importer = typeof previousReport.importedBy === "string" ? previousReport.importedBy : null;
  if (importer && importer === reviewer && !allowSelfReview()) {
    throw new Error("Workflow reviewer must differ from workflow importer");
  }

  const [backend] = await db.select().from(executionBackends).where(eq(executionBackends.id, backendId));
  if (!backend) throw new Error("Execution backend not found");
  if (!backend.enabled && process.env.ENABLE_BACKEND !== "true") {
    throw new Error("Backend is disabled; set ENABLE_BACKEND=true only after reviewing this exact backend");
  }

  const headers = await resolveBackendAuthHeaders(backend.authType, backend.authConfigJson);
  const transport = await createComfyUITransport(
    backend.baseUrl, backend.topology, headers,
    Array.isArray((backend.networkPolicyJson as { resolvedAddresses?: unknown }).resolvedAddresses)
      ? ((backend.networkPolicyJson as { resolvedAddresses: unknown[] }).resolvedAddresses.filter((value): value is string => typeof value === "string"))
      : [],
    { policyRevision: sha256(backend.networkPolicyJson) },
  );
  try {
    const workflow = normalizeComfyWorkflow(row.revision.workflowApiJson);
    assertWorkflowPromotionPolicy(workflow);
    const manifest = parseWorkflowManifest(row.revision.manifestJson);
    if (row.revision.workflowSha256 !== sha256(workflow)) {
      throw new Error("Workflow content digest mismatch");
    }

    const [features, objectInfo] = await Promise.all([
      probeBackendFeatures(transport),
      probeObjectInfo(transport),
    ]);
    const missingNodeClasses = manifest.requirements.nodeClasses.filter(
      (classType) => !objectInfo[classType],
    );
    if (missingNodeClasses.length) {
      throw new Error(`Backend is missing required node classes: ${missingNodeClasses.join(", ")}`);
    }

    const modelFolders = new Map<string, string[]>();
    for (const model of manifest.requirements.models) {
      if (!modelFolders.has(model.folder)) {
        modelFolders.set(model.folder, await probeModelFolder(transport, model.folder));
      }
    }
    const missingModels = manifest.requirements.models.filter(
      (model) => !modelFolders.get(model.folder)?.includes(model.filename.replace(/\\/g, "/")),
    );
    if (missingModels.length) {
      throw new Error(`Backend is missing required models: ${missingModels.map((item) => `${item.folder}/${item.filename}`).join(", ")}`);
    }

    const profileId = process.env.PROFILE_REVISION_ID?.trim();
    let profile: typeof generationProfileRevisions.$inferSelect | undefined;
    if (profileId) {
      [profile] = await db.select().from(generationProfileRevisions).where(and(
        eq(generationProfileRevisions.id, profileId),
        eq(generationProfileRevisions.workflowPackageDigest, digest),
        eq(generationProfileRevisions.executionBackendId, backendId),
        eq(generationProfileRevisions.adapterKind, "comfyui"),
      ));
      if (!profile) throw new Error("Profile does not match the exact workflow, backend, and adapter");
      if (profile.capability !== manifest.capability) {
        throw new Error("Profile capability does not match workflow manifest capability");
      }
    }

    const now = Date.now();
    const validationId = sha256({ workflowPackageDigest: digest, executionBackendId: backendId });
    const validationReport = {
      importedBy: importer,
      importedAtMs: typeof previousReport.importedAtMs === "number" ? previousReport.importedAtMs : null,
      reviewedBy: reviewer,
      reviewedAtMs: now,
      backendId,
      environmentFingerprint: features.environmentFingerprint,
      environmentLockDigest: row.revision.environmentLockDigest,
      requiredNodeClasses: manifest.requirements.nodeClasses,
      missingNodeClasses: [],
      requiredModels: manifest.requirements.models,
      missingModels: [],
    };

    await db.transaction(async (tx) => {
      await tx.update(executionBackends).set({
        environmentFingerprint: features.environmentFingerprint,
        featureSnapshotJson: features as unknown as Record<string, unknown>,
        validatedAtMs: now,
        enabled: process.env.ENABLE_BACKEND === "true" ? 1 : backend.enabled,
        updatedAtMs: now,
      }).where(eq(executionBackends.id, backendId));

      await tx.insert(workflowBackendValidations).values({
        id: validationId,
        workflowPackageDigest: digest,
        executionBackendId: backendId,
        environmentFingerprint: features.environmentFingerprint,
        environmentLockDigest: row.revision.environmentLockDigest,
        reviewerId: reviewer,
        reportJson: validationReport,
        validatedAtMs: now,
        updatedAtMs: now,
      }).onConflictDoUpdate({
        target: workflowBackendValidations.id,
        set: {
          environmentFingerprint: features.environmentFingerprint,
          environmentLockDigest: row.revision.environmentLockDigest,
          reviewerId: reviewer,
          reportJson: validationReport,
          validatedAtMs: now,
          updatedAtMs: now,
        },
      });

      await tx.update(workflowPackageStates).set({
        state: "active",
        reviewedBy: reviewer,
        reviewedAtMs: now,
        updatedAtMs: now,
        validationReportJson: validationReport,
      }).where(eq(workflowPackageStates.workflowPackageDigest, digest));

      if (!profile) return;
      await tx.update(generationProfileStates).set({
        enabled: 1,
        visibility: "workspace",
        updatedAtMs: now,
      }).where(eq(generationProfileStates.generationProfileRevisionId, profile.id));

      const scopeCapability = process.env.SET_DEFAULT_CAPABILITY?.trim();
      if (!scopeCapability) return;
      if (
        scopeCapability !== profile.capability
        || !["text", "image", "video", "speech"].includes(scopeCapability)
      ) {
        throw new Error("SET_DEFAULT_CAPABILITY does not match profile capability");
      }
      const pointer = {
        scopeType: "global" as const,
        scopeId: "default",
        capability: scopeCapability as "text" | "image" | "video" | "speech",
      };
      const [existing] = await tx.select().from(defaultGenerationProfilePointers).where(and(
        eq(defaultGenerationProfilePointers.scopeType, pointer.scopeType),
        eq(defaultGenerationProfilePointers.scopeId, pointer.scopeId),
        eq(defaultGenerationProfilePointers.capability, pointer.capability),
      ));
      if (existing) {
        await tx.update(defaultGenerationProfilePointers).set({
          generationProfileRevisionId: profile.id,
          updatedBy: reviewer,
          updatedAtMs: now,
        }).where(and(
          eq(defaultGenerationProfilePointers.scopeType, pointer.scopeType),
          eq(defaultGenerationProfilePointers.scopeId, pointer.scopeId),
          eq(defaultGenerationProfilePointers.capability, pointer.capability),
        ));
      } else {
        await tx.insert(defaultGenerationProfilePointers).values({
          ...pointer,
          generationProfileRevisionId: profile.id,
          updatedBy: reviewer,
          updatedAtMs: now,
        });
      }
    });

    console.log(JSON.stringify({
      digest,
      state: "active",
      backendId,
      reviewer,
      environmentFingerprint: features.environmentFingerprint,
      profileRevisionId: profile?.id ?? null,
    }, null, 2));
  } finally {
    transport.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
