import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  generationArtifacts,
  generationAttempts,
  generationJobs,
  projects,
  sourceMediaAssets,
} from "@/lib/db/schema";

export class GenerationInputAccessError extends Error {
  readonly code = "generation_input_unavailable";
}

export type InputAccessActor = { userId: string; isAdmin: boolean };

export type AccessibleSourceMediaInput = {
  id: string;
  projectId: string;
  userId: string;
  kind: string;
  status: string;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  durationMs: number | null;
};

export type AccessibleGenerationArtifactInput = {
  id: string;
  projectId: string;
  projectUserId: string;
  status: string;
  visibility: string;
  kind: string;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  durationMs: number | null;
};

function normalizedIds(ids: readonly string[]): string[] {
  const values = [...new Set(ids.map((id) => id.trim()))];
  if (values.length < 1 || values.length > 32
    || values.some((id) => !/^[A-Za-z0-9._:-]{1,160}$/.test(id))) {
    throw new GenerationInputAccessError("Generation input identifiers are invalid");
  }
  return values;
}

export async function loadAccessibleSourceMediaInputs(input: {
  ids: readonly string[];
  projectId: string;
  actor: InputAccessActor;
}): Promise<AccessibleSourceMediaInput[]> {
  const ids = normalizedIds(input.ids);
  const rows = await db.select({
    id: sourceMediaAssets.id,
    projectId: sourceMediaAssets.projectId,
    userId: sourceMediaAssets.userId,
    kind: sourceMediaAssets.kind,
    status: sourceMediaAssets.status,
    storageKey: sourceMediaAssets.storageKey,
    sha256: sourceMediaAssets.sha256,
    sizeBytes: sourceMediaAssets.sizeBytes,
    mimeType: sourceMediaAssets.mimeType,
    durationMs: sourceMediaAssets.durationMs,
  }).from(sourceMediaAssets).where(and(
    inArray(sourceMediaAssets.id, ids),
    eq(sourceMediaAssets.projectId, input.projectId),
    eq(sourceMediaAssets.status, "COMMITTED"),
  ));
  if (rows.length !== ids.length || (!input.actor.isAdmin
    && rows.some((row) => row.userId !== input.actor.userId))) {
    throw new GenerationInputAccessError("One or more generation inputs are unavailable");
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)!);
}

export async function loadAccessibleGenerationArtifactInputs(input: {
  ids: readonly string[];
  projectId: string;
  actor: InputAccessActor;
}): Promise<AccessibleGenerationArtifactInput[]> {
  const ids = normalizedIds(input.ids);
  const rows = await db.select({
    id: generationArtifacts.id,
    projectId: generationJobs.projectId,
    projectUserId: projects.userId,
    status: generationArtifacts.status,
    visibility: generationArtifacts.visibility,
    kind: generationArtifacts.kind,
    storageKey: generationArtifacts.storageKey,
    sha256: generationArtifacts.sha256,
    sizeBytes: generationArtifacts.sizeBytes,
    mimeType: generationArtifacts.mimeType,
    durationMs: generationArtifacts.durationMs,
  }).from(generationArtifacts)
    .innerJoin(generationAttempts, eq(generationAttempts.id, generationArtifacts.attemptId))
    .innerJoin(generationJobs, eq(generationJobs.id, generationAttempts.jobId))
    .innerJoin(projects, eq(projects.id, generationJobs.projectId))
    .where(and(
      inArray(generationArtifacts.id, ids),
      eq(generationJobs.projectId, input.projectId),
      eq(generationArtifacts.status, "COMMITTED"),
    ));
  if (rows.length !== ids.length || rows.some((row) => !row.projectId)
    || (!input.actor.isAdmin && rows.some((row) => row.projectUserId !== input.actor.userId))) {
    throw new GenerationInputAccessError("One or more generation inputs are unavailable");
  }
  const byId = new Map(rows.map((row) => [row.id, { ...row, projectId: row.projectId! }]));
  return ids.map((id) => byId.get(id)!);
}
