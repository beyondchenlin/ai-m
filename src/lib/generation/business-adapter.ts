/** Business compatibility bridge from the existing comic domain to durable generation. */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  businessTaskGenerationJobs,
  characters,
  defaultGenerationProfilePointers,
  dialogues,
  generationArtifacts,
  generationJobs,
  generationProfileRevisions,
  generationProfileStates,
  shotAssets,
  shots,
} from "@/lib/db/schema";
import { id as genId } from "@/lib/id";
import { isEnabled, FF } from "@/lib/feature-flags";
import { createGenerationJob } from "./jobs/service";
import type { CreateGenerationJobInput } from "./contracts";
import { normalizeParameters, type InputParameters } from "./parameter-normalization";
import { processReferenceImages, type ReferenceImageInput, type ReferenceMode } from "./reference-image-processor";
import { chunkText, type ChunkingConfig } from "./audio-chunking";
import { getVoiceProfile } from "./voice-profiles";
import { resolveRunnableProfile } from "./profiles/service";
import { assertSpeechProfileCompatibility } from "./speech-domain";

export type BusinessContextKind = "character-image" | "shot-frame" | "scene-frame" | "dialogue-audio";

export class SpeechJobError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
    readonly code: string,
  ) {
    super(message);
    this.name = "SpeechJobError";
  }
}

export async function mergeGenerationJobMetadata(
  jobId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await db.update(generationJobs).set({
    metadataJson: sql`json_patch(${generationJobs.metadataJson}, ${JSON.stringify(patch)})`,
    updatedAtMs: Date.now(),
  }).where(eq(generationJobs.id, jobId));
}

async function assertCharacterProject(characterId: string, projectId: string) {
  const [character] = await db.select().from(characters).where(and(eq(characters.id, characterId), eq(characters.projectId, projectId)));
  if (!character) throw new Error("Character does not belong to the project");
  return character;
}

async function assertShotProject(shotId: string, projectId: string) {
  const [shot] = await db.select().from(shots).where(and(eq(shots.id, shotId), eq(shots.projectId, projectId)));
  if (!shot) throw new Error("Shot does not belong to the project");
  return shot;
}

export async function createCharacterImageJob(
  characterId: string,
  projectId: string,
  userId: string,
  options: {
    prompt?: string; negativePrompt?: string; width?: number; height?: number;
    aspectRatio?: string; seed?: string; referenceImages?: ReferenceImageInput[];
    referenceMode?: ReferenceMode; profileRevisionId?: string; operationId?: string;
  } = {},
): Promise<{ jobId: string; profileRevisionId: string }> {
  if (!isEnabled(FF.V2_LOCAL_IMAGE)) throw new Error("v2.0 local image generation is not enabled");
  const character = await assertCharacterProject(characterId, projectId);
  const profileRevisionId = options.profileRevisionId || await resolveDefaultProfile("image");
  if (!profileRevisionId) throw new Error("No image generation profile configured");
  const prompt = options.prompt || character.visualHint || character.description || "";
  if (!prompt) throw new Error("No prompt available for character image generation");
  const normalized = normalizeParameters({
    prompt, negativePrompt: options.negativePrompt, width: options.width, height: options.height,
    aspectRatio: options.aspectRatio, seed: options.seed,
  } satisfies InputParameters);
  const processedReferences = options.referenceImages?.length
    ? await processReferenceImages(options.referenceImages, {}, projectId)
    : [];
  const input: CreateGenerationJobInput = {
    capability: "image", profileRevisionId, projectId,
    idempotencyKey: options.operationId,
    request: { prompt: normalized.prompt, negativePrompt: normalized.negativePrompt, width: normalized.width, height: normalized.height, seed: normalized.seed },
    businessContext: { kind: "character-image", id: characterId },
    metadata: processedReferences.length ? {
      referenceMode: options.referenceMode || "auto",
      referenceImages: processedReferences.map((reference) => ({
        artifactId: reference.artifactId, sha256: reference.sha256, sizeBytes: reference.sizeBytes,
        mimeType: reference.mimeType, strength: reference.strength,
        semanticLabel: reference.semanticLabel, semanticType: reference.semanticType,
      })),
    } : undefined,
  };
  const job = await createGenerationJob(input, { userId, roles: ["user"] });
  return { jobId: job.id, profileRevisionId };
}

export async function createShotFrameJob(
  shotId: string,
  projectId: string,
  userId: string,
  options: { frameType: "start" | "end" | "keyframe"; prompt?: string; negativePrompt?: string; width?: number; height?: number; seed?: string; operationId?: string },
): Promise<{ jobId: string; profileRevisionId: string }> {
  if (!isEnabled(FF.V2_LOCAL_IMAGE)) throw new Error("v2.0 local image generation is not enabled");
  const shot = await assertShotProject(shotId, projectId);
  const profileRevisionId = await resolveDefaultProfile("image");
  if (!profileRevisionId) throw new Error("No default image generation profile configured");
  const assetType = options.frameType === "start" ? "first_frame" : options.frameType === "end" ? "last_frame" : "reference";
  const [existingAsset] = await db.select({ prompt: shotAssets.prompt }).from(shotAssets).where(and(
    eq(shotAssets.shotId, shotId), eq(shotAssets.type, assetType), eq(shotAssets.isActive, 1),
  )).orderBy(desc(shotAssets.assetVersion)).limit(1);
  const prompt = options.prompt || existingAsset?.prompt || shot.videoPrompt || shot.prompt || "";
  if (!prompt) throw new Error("No prompt available for shot frame generation");
  const job = await createGenerationJob({
    capability: "image", profileRevisionId, projectId,
    idempotencyKey: options.operationId,
    request: { prompt, negativePrompt: options.negativePrompt || "", width: options.width || 1024, height: options.height || 1024, seed: options.seed },
    businessContext: { kind: "shot-frame", id: shotId },
    metadata: { frameType: options.frameType, shotAssetType: assetType },
  }, { userId, roles: ["user"] });
  return { jobId: job.id, profileRevisionId };
}

export interface SpeechJobOptions {
  text: string;
  voiceProfileId: string;
  profileRevisionId?: string;
  speed?: number;
  pitch?: number;
  language?: string;
  emotion?: string;
  emotionStrength?: number;
  chunkingConfig?: Partial<ChunkingConfig>;
  operationId?: string;
  businessContext?: { kind: string; id: string };
}

function validateSpeechOverrides(options: SpeechJobOptions): void {
  if (!options.text.trim() || options.text.length > 100_000) throw new SpeechJobError("Speech text is invalid", 400, "speech_text_invalid");
  if (options.speed !== undefined && (!Number.isFinite(options.speed) || options.speed < 0.5 || options.speed > 2)) {
    throw new SpeechJobError("speed must be between 0.5 and 2.0", 400, "speech_speed_invalid");
  }
  if (options.pitch !== undefined && (!Number.isFinite(options.pitch) || options.pitch < 0.5 || options.pitch > 2)) {
    throw new SpeechJobError("pitch must be between 0.5 and 2.0", 400, "speech_pitch_invalid");
  }
  if (options.emotionStrength !== undefined
    && (!Number.isFinite(options.emotionStrength) || options.emotionStrength < 0 || options.emotionStrength > 1)) {
    throw new SpeechJobError("emotionStrength must be between 0 and 1", 400, "speech_emotion_strength_invalid");
  }
  if (options.language && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(options.language)) {
    throw new SpeechJobError("language tag is invalid", 400, "speech_language_invalid");
  }
  if (options.emotion && options.emotion.length > 80) throw new SpeechJobError("emotion is too long", 400, "speech_emotion_invalid");
}

async function resolveSpeechProfile(
  requestedProfileRevisionId: string | undefined,
  voiceProvider: string,
): Promise<string> {
  const profileRevisionId = requestedProfileRevisionId || await resolveDefaultProfile("speech");
  if (!profileRevisionId) throw new SpeechJobError("No speech generation profile configured", 409, "speech_profile_missing");
  const profile = await resolveRunnableProfile(profileRevisionId);
  if (!profile || !profile.enabled || profile.capability !== "speech") {
    throw new SpeechJobError("Speech generation profile is unavailable", 409, "speech_profile_unavailable");
  }
  try {
    assertSpeechProfileCompatibility(profile, voiceProvider);
  } catch {
    throw new SpeechJobError("The selected speech profile is incompatible with this voice profile", 409, "speech_profile_incompatible");
  }
  return profileRevisionId;
}

export async function createSpeechJob(
  projectId: string,
  userId: string,
  options: SpeechJobOptions,
): Promise<{ jobId: string; profileRevisionId: string; chunkCount: number }> {
  if (!isEnabled(FF.V2_LOCAL_SPEECH)) throw new SpeechJobError("Local speech generation is not enabled", 409, "speech_disabled");
  validateSpeechOverrides(options);
  const voiceProfile = await getVoiceProfile(options.voiceProfileId, userId);
  if (!voiceProfile || voiceProfile.projectId !== projectId) throw new SpeechJobError("Voice profile is not accessible in this project", 404, "voice_profile_unavailable");
  const profileRevisionId = await resolveSpeechProfile(options.profileRevisionId, voiceProfile.provider);
  const chunking = chunkText(options.text, options.chunkingConfig);
  if (chunking.chunkCount !== 1) {
    throw new SpeechJobError("This endpoint accepts one narration block at a time; split long narration before submission", 400, "speech_block_too_long");
  }
  const text = chunking.chunks[0]?.text || options.text.trim();
  const request = {
    text,
    voiceProfileId: options.voiceProfileId,
    speed: options.speed ?? voiceProfile.defaultSpeed,
    pitch: options.pitch ?? voiceProfile.defaultPitch,
    language: options.language ?? voiceProfile.language,
    referenceText: voiceProfile.referenceText ?? undefined,
    emotion: options.emotion,
    emotionStrength: options.emotionStrength,
  };
  const job = await createGenerationJob({
    capability: "speech",
    profileRevisionId,
    projectId,
    idempotencyKey: options.operationId,
    request,
    businessContext: options.businessContext,
    sourceAssets: voiceProfile.referenceSourceAssetId
      ? [{ id: voiceProfile.referenceSourceAssetId, role: "voice-reference" }]
      : undefined,
    metadata: {
      voiceProfileId: voiceProfile.id,
      voiceProvider: voiceProfile.provider,
      voiceReferenceSourceAssetId: voiceProfile.referenceSourceAssetId,
      voiceReferenceArtifactId: voiceProfile.referenceArtifactId,
      narrationBlock: {
        text,
        sourceStart: chunking.chunks[0]?.startOffset ?? 0,
        sourceEnd: chunking.chunks[0]?.endOffset ?? text.length,
      },
    },
  }, { userId, roles: ["user"] });
  return { jobId: job.id, profileRevisionId, chunkCount: chunking.chunkCount };
}

export async function createDialogueAudioJob(
  dialogueId: string,
  projectId: string,
  userId: string,
  options: Omit<SpeechJobOptions, "text" | "businessContext"> & { text?: string },
): Promise<{ jobId: string; profileRevisionId: string; chunkCount: number }> {
  const [dialogue] = await db.select({ text: dialogues.text }).from(dialogues)
    .innerJoin(shots, eq(shots.id, dialogues.shotId))
    .where(and(eq(dialogues.id, dialogueId), eq(shots.projectId, projectId)));
  if (!dialogue) throw new SpeechJobError("Dialogue not found in this project", 404, "dialogue_not_found");
  const text = options.text?.trim() || dialogue.text?.trim() || "";
  if (!text) throw new SpeechJobError("No text provided for dialogue audio generation", 400, "dialogue_text_missing");
  return createSpeechJob(projectId, userId, {
    ...options,
    text,
    businessContext: { kind: "dialogue-audio", id: dialogueId },
  });
}

export async function getBusinessTaskJobs(businessTaskId: string, kind: BusinessContextKind) {
  const rows = await db.select({ jobId: businessTaskGenerationJobs.generationJobId, status: generationJobs.status, artifactId: generationJobs.currentArtifactId })
    .from(businessTaskGenerationJobs).innerJoin(generationJobs, eq(businessTaskGenerationJobs.generationJobId, generationJobs.id))
    .where(and(eq(businessTaskGenerationJobs.businessTaskId, businessTaskId), eq(businessTaskGenerationJobs.relationKind, kind)))
    .orderBy(desc(businessTaskGenerationJobs.createdAtMs));
  return rows.map((row) => ({ jobId: row.jobId, status: row.status, artifactId: row.artifactId || undefined }));
}

export async function linkArtifactToBusinessEntity(jobId: string, artifactId: string): Promise<void> {
  const [relation] = await db.select({ generationJobId: businessTaskGenerationJobs.generationJobId })
    .from(businessTaskGenerationJobs)
    .where(eq(businessTaskGenerationJobs.generationJobId, jobId))
    .limit(1);
  if (!relation) return;
  const [row] = await db.select({ job: generationJobs, artifact: generationArtifacts, link: businessTaskGenerationJobs })
    .from(generationJobs)
    .innerJoin(generationArtifacts, eq(generationArtifacts.id, artifactId))
    .innerJoin(businessTaskGenerationJobs, eq(businessTaskGenerationJobs.generationJobId, generationJobs.id))
    .where(and(eq(generationJobs.id, jobId), eq(generationArtifacts.id, artifactId)));
  if (!row || row.artifact.status !== "COMMITTED" || row.job.currentAttemptId !== row.artifact.attemptId) throw new Error("Committed artifact does not belong to the current job attempt");
  const url = `/api/generation/artifacts/${artifactId}`;
  if (row.link.relationKind === "character-image") {
    const [character] = await db.select().from(characters).where(and(eq(characters.id, row.link.businessTaskId), eq(characters.projectId, row.job.projectId ?? "")));
    if (!character) throw new Error("Character business target is invalid");
    if (character.referenceImage === url) return;
    const history = JSON.parse(character.referenceImageHistory || "[]") as unknown[];
    if (character.referenceImage) history.push({ url: character.referenceImage, replacedAt: Date.now() });
    await db.update(characters).set({ referenceImage: url, referenceImageHistory: JSON.stringify(history.slice(-20)), isStale: 0 }).where(eq(characters.id, character.id));
    return;
  }
  if (row.link.relationKind === "shot-frame") {
    await assertShotProject(row.link.businessTaskId, row.job.projectId ?? "");
    const metadata = row.job.metadataJson as Record<string, unknown>;
    const type = (metadata.shotAssetType === "last_frame" || metadata.shotAssetType === "reference") ? metadata.shotAssetType : "first_frame";
    const [alreadyLinked] = await db.select({ id: shotAssets.id }).from(shotAssets)
      .where(and(eq(shotAssets.shotId, row.link.businessTaskId), eq(shotAssets.type, type), eq(shotAssets.fileUrl, url)))
      .limit(1);
    if (alreadyLinked) return;
    const [latest] = await db.select({ version: shotAssets.assetVersion }).from(shotAssets)
      .where(and(eq(shotAssets.shotId, row.link.businessTaskId), eq(shotAssets.type, type)))
      .orderBy(desc(shotAssets.assetVersion)).limit(1);
    await db.update(shotAssets).set({ isActive: 0, updatedAt: new Date() }).where(and(eq(shotAssets.shotId, row.link.businessTaskId), eq(shotAssets.type, type), eq(shotAssets.isActive, 1)));
    await db.insert(shotAssets).values({
      id: genId(), shotId: row.link.businessTaskId, type, sequenceInType: 0,
      assetVersion: (latest?.version ?? 0) + 1, isActive: 1, prompt: "", fileUrl: url,
      status: "completed", meta: JSON.stringify({ artifactId, generationJobId: jobId }), createdAt: new Date(), updatedAt: new Date(),
    });
    return;
  }
  if (row.link.relationKind === "dialogue-audio") {
    if (row.artifact.kind !== "audio" || !row.artifact.mimeType.startsWith("audio/")) {
      throw new Error("Dialogue audio projection requires a committed audio artifact");
    }
    const [dialogueTarget] = await db.select({ id: dialogues.id })
      .from(dialogues)
      .innerJoin(shots, eq(shots.id, dialogues.shotId))
      .where(and(
        eq(dialogues.id, row.link.businessTaskId),
        eq(shots.projectId, row.job.projectId ?? ""),
      ));
    if (!dialogueTarget) throw new Error("Dialogue audio business target is invalid");
    await db.update(dialogues).set({ audioUrl: url }).where(eq(dialogues.id, dialogueTarget.id));
  }
}

export async function reconcileBusinessArtifactProjections(limit = 20): Promise<{ projected: number; failed: number }> {
  const rows = await db.select({
    id: generationJobs.id,
    artifactId: generationJobs.currentArtifactId,
    metadata: generationJobs.metadataJson,
  }).from(generationJobs)
    .where(eq(generationJobs.status, "SUCCEEDED"))
    .orderBy(desc(generationJobs.updatedAtMs))
    .limit(Math.max(1, Math.min(limit, 100)));
  let projected = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row.artifactId) continue;
    const metadata = row.metadata as Record<string, unknown>;
    if (metadata.businessProjectionStatus === "succeeded") continue;
    try {
      await linkArtifactToBusinessEntity(row.id, row.artifactId);
      await mergeGenerationJobMetadata(row.id, {
        businessProjectionStatus: "succeeded",
        businessProjectedAtMs: Date.now(),
        businessProjectionError: null,
      });
      projected++;
    } catch (error) {
      await mergeGenerationJobMetadata(row.id, {
        businessProjectionStatus: "pending",
        businessProjectionError: error instanceof Error ? error.message.slice(0, 200) : "projection_failed",
      }).catch(() => undefined);
      failed++;
    }
  }
  return { projected, failed };
}

async function resolveDefaultProfile(capability: "image" | "video" | "text" | "speech"): Promise<string | null> {
  const [pointer] = await db.select({ id: generationProfileRevisions.id })
    .from(defaultGenerationProfilePointers)
    .innerJoin(
      generationProfileRevisions,
      eq(generationProfileRevisions.id, defaultGenerationProfilePointers.generationProfileRevisionId),
    )
    .innerJoin(
      generationProfileStates,
      eq(generationProfileStates.generationProfileRevisionId, generationProfileRevisions.id),
    )
    .where(and(
      eq(defaultGenerationProfilePointers.scopeType, "global"),
      eq(defaultGenerationProfilePointers.scopeId, "default"),
      eq(defaultGenerationProfilePointers.capability, capability),
      eq(generationProfileRevisions.capability, capability),
      eq(generationProfileStates.enabled, 1),
      eq(generationProfileStates.visibility, "workspace"),
    ));
  if (pointer) return pointer.id;
  const [profile] = await db.select({ id: generationProfileRevisions.id }).from(generationProfileRevisions)
    .innerJoin(generationProfileStates, eq(generationProfileStates.generationProfileRevisionId, generationProfileRevisions.id))
    .where(and(
      eq(generationProfileRevisions.capability, capability),
      eq(generationProfileStates.enabled, 1),
      eq(generationProfileStates.visibility, "workspace"),
    ))
    .orderBy(desc(generationProfileRevisions.createdAtMs)).limit(1);
  return profile?.id || null;
}

export async function getJobArtifactUrl(jobId: string): Promise<string | null> {
  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
  return job?.currentArtifactId ? `/api/generation/artifacts/${job.currentArtifactId}` : null;
}
