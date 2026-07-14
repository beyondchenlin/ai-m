/** Voice profiles reference immutable user-owned source audio or a legacy generated artifact. */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  generationArtifacts,
  generationAttempts,
  generationJobs,
  projects,
  sourceMediaAssets,
  voiceProfiles,
} from "@/lib/db/schema";
import { id as genId } from "@/lib/id";
import { deleteOwnedSourceAsset } from "./source-assets";

export const VOICE_CONSENT_VERSION = "voice-clone-consent-v1";
export type VoiceProvider = "indextts2" | "omnivoice";

export class VoiceProfileError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
    readonly code: string,
  ) {
    super(message);
    this.name = "VoiceProfileError";
  }
}

export interface VoiceProfileInput {
  projectId: string;
  userId: string;
  name: string;
  provider: VoiceProvider;
  referenceSourceAssetId?: string;
  /** Legacy generated audio can still be used as a source. */
  referenceArtifactId?: string;
  referenceText?: string;
  language?: string;
  defaultSpeed?: number;
  defaultPitch?: number;
  consentConfirmed: boolean;
  consentStatementVersion: string;
}

export interface ProcessedVoiceProfile {
  id: string;
  projectId: string;
  userId: string;
  name: string;
  provider: VoiceProvider;
  referenceSourceAssetId: string | null;
  referenceArtifactId: string | null;
  referenceUrl: string;
  referenceText: string | null;
  language: string;
  defaultSpeed: number;
  defaultPitch: number;
  durationMs: number | null;
  createdAtMs: number;
}

async function assertOwnedProject(projectId: string, userId: string): Promise<void> {
  const [project] = await db.select({ userId: projects.userId }).from(projects).where(eq(projects.id, projectId));
  if (!project || project.userId !== userId) throw new VoiceProfileError("Project not found", 404, "project_not_found");
}

async function loadOwnedSourceAudio(projectId: string, userId: string, sourceAssetId: string) {
  const [asset] = await db.select().from(sourceMediaAssets).where(and(
    eq(sourceMediaAssets.id, sourceAssetId),
    eq(sourceMediaAssets.projectId, projectId),
    eq(sourceMediaAssets.userId, userId),
    eq(sourceMediaAssets.status, "COMMITTED"),
  ));
  if (!asset || asset.kind !== "audio" || !asset.mimeType.startsWith("audio/")) throw new VoiceProfileError("Reference source audio is not accessible", 404, "source_audio_unavailable");
  if (asset.sizeBytes <= 0 || asset.sizeBytes > 50 * 1024 * 1024) throw new VoiceProfileError("Reference audio exceeds 50 MB", 400, "source_audio_size_invalid");
  if (asset.durationMs === null || asset.durationMs < 3_000 || asset.durationMs > 60_000) throw new VoiceProfileError("Reference audio must be between 3 and 60 seconds", 400, "source_audio_duration_invalid");
  return asset;
}

async function loadOwnedGeneratedAudio(projectId: string, userId: string, artifactId: string) {
  const [row] = await db.select({
    artifact: generationArtifacts,
    projectUserId: projects.userId,
    jobProjectId: generationJobs.projectId,
  }).from(generationArtifacts)
    .innerJoin(generationAttempts, eq(generationAttempts.id, generationArtifacts.attemptId))
    .innerJoin(generationJobs, eq(generationJobs.id, generationAttempts.jobId))
    .innerJoin(projects, eq(projects.id, generationJobs.projectId))
    .where(and(eq(generationArtifacts.id, artifactId), eq(projects.id, projectId)));
  if (!row || row.projectUserId !== userId || row.jobProjectId !== projectId) throw new VoiceProfileError("Reference audio artifact is not accessible", 404, "artifact_audio_unavailable");
  if (row.artifact.status !== "COMMITTED" || row.artifact.kind !== "audio") throw new VoiceProfileError("Reference artifact must be committed audio", 400, "artifact_audio_invalid");
  if (!["private-original", "project"].includes(row.artifact.visibility)) throw new VoiceProfileError("Reference audio visibility is invalid", 404, "artifact_audio_unavailable");
  if (row.artifact.sizeBytes <= 0 || row.artifact.sizeBytes > 50 * 1024 * 1024) throw new VoiceProfileError("Reference audio exceeds 50 MB", 400, "artifact_audio_size_invalid");
  if (row.artifact.durationMs === null || row.artifact.durationMs < 3_000 || row.artifact.durationMs > 60_000) throw new VoiceProfileError("Reference audio must be between 3 and 60 seconds", 400, "artifact_audio_duration_invalid");
  return row.artifact;
}

function validateInput(input: VoiceProfileInput): void {
  if (!input.consentConfirmed) throw new VoiceProfileError("Voice usage consent must be confirmed", 400, "consent_required");
  if (input.consentStatementVersion !== VOICE_CONSENT_VERSION) throw new VoiceProfileError("Voice consent statement version is invalid", 400, "consent_version_invalid");
  if (!input.name.trim() || input.name.trim().length > 120) throw new VoiceProfileError("Voice profile name is invalid", 400, "profile_name_invalid");
  if (!(["indextts2", "omnivoice"] as string[]).includes(input.provider)) throw new VoiceProfileError("Voice provider is unsupported", 400, "provider_unsupported");
  if (Boolean(input.referenceSourceAssetId) === Boolean(input.referenceArtifactId)) throw new VoiceProfileError("Exactly one voice reference must be provided", 400, "reference_count_invalid");
  if (input.referenceText && input.referenceText.length > 20_000) throw new VoiceProfileError("referenceText is too long", 400, "reference_text_too_long");
  if (input.language && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(input.language)) throw new VoiceProfileError("language tag is invalid", 400, "language_invalid");
  if (!Number.isFinite(input.defaultSpeed ?? 1) || (input.defaultSpeed ?? 1) < 0.5 || (input.defaultSpeed ?? 1) > 2) throw new VoiceProfileError("defaultSpeed must be between 0.5 and 2.0", 400, "speed_invalid");
  if (!Number.isFinite(input.defaultPitch ?? 1) || (input.defaultPitch ?? 1) < 0.5 || (input.defaultPitch ?? 1) > 2) throw new VoiceProfileError("defaultPitch must be between 0.5 and 2.0", 400, "pitch_invalid");
}

export async function processVoiceProfile(input: VoiceProfileInput): Promise<ProcessedVoiceProfile> {
  validateInput(input);
  await assertOwnedProject(input.projectId, input.userId);
  if (input.referenceSourceAssetId) await loadOwnedSourceAudio(input.projectId, input.userId, input.referenceSourceAssetId);
  if (input.referenceArtifactId) await loadOwnedGeneratedAudio(input.projectId, input.userId, input.referenceArtifactId);
  const id = genId();
  const now = Date.now();
  db.transaction((tx) => {
    const [ownedProject] = tx.select({ userId: projects.userId }).from(projects)
      .where(eq(projects.id, input.projectId)).all();
    if (!ownedProject || ownedProject.userId !== input.userId) throw new VoiceProfileError("Project not found", 404, "project_not_found");

    if (input.referenceSourceAssetId) {
      const [source] = tx.select({ id: sourceMediaAssets.id }).from(sourceMediaAssets).where(and(
        eq(sourceMediaAssets.id, input.referenceSourceAssetId),
        eq(sourceMediaAssets.projectId, input.projectId),
        eq(sourceMediaAssets.userId, input.userId),
        eq(sourceMediaAssets.status, "COMMITTED"),
        eq(sourceMediaAssets.kind, "audio"),
      )).all();
      if (!source) throw new VoiceProfileError("Reference source audio is not accessible", 404, "source_audio_unavailable");
    }
    if (input.referenceArtifactId) {
      const [artifact] = tx.select({ id: generationArtifacts.id }).from(generationArtifacts)
        .innerJoin(generationAttempts, eq(generationAttempts.id, generationArtifacts.attemptId))
        .innerJoin(generationJobs, eq(generationJobs.id, generationAttempts.jobId))
        .where(and(
          eq(generationArtifacts.id, input.referenceArtifactId),
          eq(generationArtifacts.status, "COMMITTED"),
          eq(generationArtifacts.kind, "audio"),
          eq(generationJobs.projectId, input.projectId),
        )).all();
      if (!artifact) throw new VoiceProfileError("Reference audio artifact is not accessible", 404, "artifact_audio_unavailable");
    }

    tx.insert(voiceProfiles).values({
      id,
      projectId: input.projectId,
      userId: input.userId,
      name: input.name.trim(),
      provider: input.provider,
      referenceArtifactId: input.referenceArtifactId ?? null,
      referenceSourceAssetId: input.referenceSourceAssetId ?? null,
      referenceText: input.referenceText?.trim() || null,
      language: input.language?.trim() || "zh-CN",
      defaultSpeed: Math.round((input.defaultSpeed ?? 1) * 1000),
      defaultPitch: Math.round((input.defaultPitch ?? 1) * 1000),
      consentConfirmedAtMs: now,
      consentStatementVersion: VOICE_CONSENT_VERSION,
      createdAtMs: now,
      updatedAtMs: now,
    }).run();
  });
  const created = await getVoiceProfile(id, input.userId);
  if (!created) throw new Error("Voice profile was created but could not be reloaded");
  return created;
}

export async function getVoiceProfile(profileId: string, userId: string): Promise<ProcessedVoiceProfile | null> {
  const [row] = await db.select({ profile: voiceProfiles }).from(voiceProfiles).where(and(
    eq(voiceProfiles.id, profileId),
    eq(voiceProfiles.userId, userId),
  ));
  if (!row) return null;

  let durationMs: number | null = null;
  let referenceUrl = "";
  const ownerId = row.profile.userId;
  if (row.profile.referenceSourceAssetId) {
    const source = await loadOwnedSourceAudio(row.profile.projectId, ownerId, row.profile.referenceSourceAssetId).catch(() => null);
    if (!source) return null;
    durationMs = source.durationMs;
    referenceUrl = `/api/source-assets/${encodeURIComponent(row.profile.referenceSourceAssetId)}`;
  } else if (row.profile.referenceArtifactId) {
    const artifact = await loadOwnedGeneratedAudio(row.profile.projectId, ownerId, row.profile.referenceArtifactId).catch(() => null);
    if (!artifact) return null;
    durationMs = artifact.durationMs;
    referenceUrl = `/api/generation/artifacts/${encodeURIComponent(row.profile.referenceArtifactId)}`;
  } else {
    return null;
  }

  return {
    id: row.profile.id,
    projectId: row.profile.projectId,
    userId: row.profile.userId,
    name: row.profile.name,
    provider: row.profile.provider as VoiceProvider,
    referenceSourceAssetId: row.profile.referenceSourceAssetId,
    referenceArtifactId: row.profile.referenceArtifactId,
    referenceUrl,
    referenceText: row.profile.referenceText,
    language: row.profile.language,
    defaultSpeed: row.profile.defaultSpeed / 1000,
    defaultPitch: row.profile.defaultPitch / 1000,
    durationMs,
    createdAtMs: row.profile.createdAtMs,
  };
}

export async function listVoiceProfiles(userId: string, projectId?: string): Promise<ProcessedVoiceProfile[]> {
  const rows = await db.select({ profile: voiceProfiles }).from(voiceProfiles)
    .where(projectId ? and(eq(voiceProfiles.userId, userId), eq(voiceProfiles.projectId, projectId)) : eq(voiceProfiles.userId, userId))
    .orderBy(desc(voiceProfiles.createdAtMs))
    .limit(500);
  if (!rows.length) return [];

  const sourceIds = rows.map((row) => row.profile.referenceSourceAssetId).filter((id): id is string => Boolean(id));
  const artifactIds = rows.map((row) => row.profile.referenceArtifactId).filter((id): id is string => Boolean(id));
  const sources = sourceIds.length
    ? await db.select().from(sourceMediaAssets).where(inArray(sourceMediaAssets.id, sourceIds))
    : [];
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const artifacts = artifactIds.length
    ? await db.select({
        artifact: generationArtifacts,
        projectUserId: projects.userId,
        jobProjectId: generationJobs.projectId,
      }).from(generationArtifacts)
        .innerJoin(generationAttempts, eq(generationAttempts.id, generationArtifacts.attemptId))
        .innerJoin(generationJobs, eq(generationJobs.id, generationAttempts.jobId))
        .innerJoin(projects, eq(projects.id, generationJobs.projectId))
        .where(inArray(generationArtifacts.id, artifactIds))
    : [];
  const artifactById = new Map(artifacts.map((row) => [row.artifact.id, row]));

  return rows.flatMap(({ profile }) => {
    let durationMs: number | null = null;
    let referenceUrl = "";
    if (profile.referenceSourceAssetId) {
      const source = sourceById.get(profile.referenceSourceAssetId);
      if (!source
        || source.projectId !== profile.projectId
        || source.userId !== profile.userId
        || source.kind !== "audio"
        || source.status !== "COMMITTED"
        || !source.mimeType.startsWith("audio/")
        || source.sizeBytes <= 0
        || source.sizeBytes > 50 * 1024 * 1024
        || source.durationMs === null
        || source.durationMs < 3_000
        || source.durationMs > 60_000) return [];
      durationMs = source.durationMs;
      referenceUrl = `/api/source-assets/${encodeURIComponent(source.id)}`;
    } else if (profile.referenceArtifactId) {
      const row = artifactById.get(profile.referenceArtifactId);
      if (!row
        || row.projectUserId !== profile.userId
        || row.jobProjectId !== profile.projectId
        || row.artifact.status !== "COMMITTED"
        || row.artifact.kind !== "audio"
        || !["private-original", "project"].includes(row.artifact.visibility)
        || row.artifact.sizeBytes <= 0
        || row.artifact.sizeBytes > 50 * 1024 * 1024
        || row.artifact.durationMs === null
        || row.artifact.durationMs < 3_000
        || row.artifact.durationMs > 60_000) return [];
      durationMs = row.artifact.durationMs;
      referenceUrl = `/api/generation/artifacts/${encodeURIComponent(row.artifact.id)}`;
    } else {
      return [];
    }
    return [{
      id: profile.id,
      projectId: profile.projectId,
      userId: profile.userId,
      name: profile.name,
      provider: profile.provider as VoiceProvider,
      referenceSourceAssetId: profile.referenceSourceAssetId,
      referenceArtifactId: profile.referenceArtifactId,
      referenceUrl,
      referenceText: profile.referenceText,
      language: profile.language,
      defaultSpeed: profile.defaultSpeed / 1000,
      defaultPitch: profile.defaultPitch / 1000,
      durationMs,
      createdAtMs: profile.createdAtMs,
    }];
  });
}

export async function deleteVoiceProfile(profileId: string, userId: string): Promise<void> {
  const profile = await getVoiceProfile(profileId, userId);
  if (!profile) throw new VoiceProfileError("Voice profile not found", 404, "profile_not_found");
  await db.delete(voiceProfiles).where(and(eq(voiceProfiles.id, profileId), eq(voiceProfiles.userId, userId)));
  if (profile.referenceSourceAssetId) {
    await deleteOwnedSourceAsset(profile.referenceSourceAssetId, userId, {
      requireUnreferenced: true,
      retainIfInUse: true,
    });
  }
}
