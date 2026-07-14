import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { generationArtifacts, generationAttempts, generationJobs, generationJobSourceAssets, sourceMediaAssets } from "@/lib/db/schema";
import type { ComfyUITransport } from "./transports/comfyui";
import type { CompiledBindings } from "./workflows";
import { resolveArtifactStoragePath } from "./archiving";
import { resolveSourceAssetPath } from "./source-assets";

interface ArtifactDescriptor {
  id: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

async function loadArtifactForJob(artifactId: string, job: typeof generationJobs.$inferSelect): Promise<ArtifactDescriptor> {
  const [row] = await db.select({ artifact: generationArtifacts, projectId: generationJobs.projectId })
    .from(generationArtifacts)
    .innerJoin(generationAttempts, eq(generationAttempts.id, generationArtifacts.attemptId))
    .innerJoin(generationJobs, eq(generationJobs.id, generationAttempts.jobId))
    .where(and(eq(generationArtifacts.id, artifactId), eq(generationArtifacts.status, "COMMITTED")));
  if (!row || !job.projectId || row.projectId !== job.projectId) throw new Error("Input artifact is not accessible to this generation job");
  if (!["private-original", "project", "export"].includes(row.artifact.visibility)) throw new Error("Input artifact visibility is invalid");
  return row.artifact;
}


interface SourceAssetDescriptor {
  id: string;
  projectId: string;
  userId: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

async function loadSourceAssetForJob(assetId: string, job: typeof generationJobs.$inferSelect): Promise<SourceAssetDescriptor> {
  const [asset] = await db.select().from(sourceMediaAssets).where(and(
    eq(sourceMediaAssets.id, assetId),
    eq(sourceMediaAssets.status, "COMMITTED"),
  ));
  // Access was captured transactionally in generation_job_source_assets.
  // Runtime materialisation verifies the immutable project boundary rather than
  // requestedBy, because an administrator may enqueue a job on behalf of the
  // project owner.
  if (!asset || !job.projectId || asset.projectId !== job.projectId) {
    throw new Error("Source media asset is not accessible to this generation job");
  }
  return asset;
}
function extensionForMime(mimeType: string): string {
  const map: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "audio/wav": "wav", "audio/mpeg": "mp3" };
  const extension = map[mimeType];
  if (!extension) throw new Error(`Unsupported input artifact MIME type: ${mimeType}`);
  return extension;
}

async function inspectArtifactFile(
  filePath: string,
  maxBytes: number,
): Promise<{ sizeBytes: number; sha256: string }> {
  const info = await fs.lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > maxBytes) {
    throw new Error("Input artifact file is invalid");
  }
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    const bytes = chunk as Buffer;
    sizeBytes += bytes.byteLength;
    if (sizeBytes > maxBytes) throw new Error("Input artifact exceeds the materialisation limit");
    hash.update(bytes);
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

async function readBoundedArtifact(artifact: ArtifactDescriptor, maxBytes: number): Promise<Uint8Array> {
  if (artifact.sizeBytes <= 0 || artifact.sizeBytes > maxBytes) throw new Error("Input artifact exceeds the materialisation limit");
  const source = resolveArtifactStoragePath(artifact.storageKey);
  const inspected = await inspectArtifactFile(source, maxBytes);
  if (inspected.sizeBytes !== artifact.sizeBytes || inspected.sha256 !== artifact.sha256) {
    throw new Error("Input artifact integrity changed after commit");
  }
  const data = new Uint8Array(await fs.readFile(source));
  if (data.byteLength !== inspected.sizeBytes) throw new Error("Input artifact changed while being read");
  return data;
}

async function copyVerifiedArtifact(
  artifact: { storageKey: string; sizeBytes: number; sha256: string },
  destination: string,
  maxBytes: number,
  resolveSource: (storageKey: string) => string,
): Promise<void> {
  const source = resolveSource(artifact.storageKey);
  const sourceInfo = await inspectArtifactFile(source, maxBytes);
  if (sourceInfo.sizeBytes !== artifact.sizeBytes || sourceInfo.sha256 !== artifact.sha256) {
    throw new Error("Input artifact integrity changed after commit");
  }

  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(destination, "wx", 0o600);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "EEXIST") throw error;
    const existing = await inspectArtifactFile(destination, maxBytes);
    if (existing.sizeBytes !== artifact.sizeBytes || existing.sha256 !== artifact.sha256) {
      throw new Error("Existing shared input file failed integrity verification");
    }
    return;
  }

  try {
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of createReadStream(source)) {
      const bytes = chunk as Buffer;
      sizeBytes += bytes.byteLength;
      if (sizeBytes > maxBytes) throw new Error("Input artifact exceeds the materialisation limit");
      hash.update(bytes);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.write(bytes, offset, bytes.byteLength - offset);
        if (result.bytesWritten <= 0) throw new Error("Shared input copy made no progress");
        offset += result.bytesWritten;
      }
    }
    await handle.sync();
    if (sizeBytes !== artifact.sizeBytes || hash.digest("hex") !== artifact.sha256) {
      throw new Error("Input artifact changed during shared-input copy");
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    handle = null;
    await fs.rm(destination, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function audioInputRoot(): Promise<string> {
  const configured = process.env.AI_M_COMFYUI_SHARED_INPUT_ROOT;
  if (!configured) throw new Error("AI_M_COMFYUI_SHARED_INPUT_ROOT is required for audio workflows");
  const root = path.resolve(configured);
  const filesystemRoot = path.parse(root).root;
  const cwd = path.resolve(process.cwd());
  const uploadRoot = path.resolve(process.env.UPLOAD_DIR || "./uploads");
  if (root === filesystemRoot || root === cwd) throw new Error("Shared input root is too broad");
  if (root === uploadRoot || root.startsWith(`${uploadRoot}${path.sep}`) || uploadRoot.startsWith(`${root}${path.sep}`)) {
    throw new Error("Shared input root must be isolated from application uploads");
  }
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const realRoot = await fs.realpath(root);
  if (realRoot === filesystemRoot || realRoot === cwd || realRoot === uploadRoot) throw new Error("Resolved shared input root is unsafe");
  return realRoot;
}


/** Remove deterministic shared-input namespaces only after their attempts are terminal. */
export async function cleanupTerminalSharedInputs(limit = 100): Promise<number> {
  if (!process.env.AI_M_COMFYUI_SHARED_INPUT_ROOT) return 0;
  const root = await audioInputRoot();
  const rows = await db.select({ id: generationAttempts.id, jobId: generationAttempts.jobId })
    .from(generationAttempts)
    .where(inArray(generationAttempts.phase, ["SUCCEEDED", "FAILED", "CANCELLED"]))
    .limit(Math.max(1, Math.min(limit, 1_000)));
  let removed = 0;
  for (const row of rows) {
    const directory = path.resolve(root, "ai-m", row.jobId, row.id);
    if (!directory.startsWith(`${root}${path.sep}`)) continue;
    const info = await fs.lstat(directory).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isDirectory()) {
      console.error("[input-materializer] refusing unsafe shared-input cleanup entry", { attemptId: row.id });
      continue;
    }
    const realDirectory = await fs.realpath(directory).catch(() => null);
    if (!realDirectory || !realDirectory.startsWith(`${root}${path.sep}`)) {
      console.error("[input-materializer] refusing escaped shared-input cleanup entry", { attemptId: row.id });
      continue;
    }
    await fs.rm(directory, { recursive: true, force: true });
    removed++;
    await fs.rmdir(path.dirname(directory)).catch(() => undefined);
  }
  return removed;
}

export interface MaterializedWorkflowInput {
  parameters: Record<string, unknown>;
  cleanup(): Promise<void>;
}

export class InputMaterializationError extends Error {
  constructor(cause: unknown, readonly cleanupOnFailure: () => Promise<void>) {
    super("Input materialization failed", { cause });
    this.name = "InputMaterializationError";
  }
}

export async function materializeWorkflowInputs(input: {
  job: typeof generationJobs.$inferSelect;
  attemptId: string;
  compiled: CompiledBindings;
  transport: ComfyUITransport;
  request: Record<string, unknown>;
  metadata: Record<string, unknown>;
  maxReferenceInputs?: number;
  signal?: AbortSignal;
}): Promise<MaterializedWorkflowInput> {
  const parameters = structuredClone(input.request);
  const cleanupPaths: string[] = [];
  const cleanupActions: Array<() => Promise<void>> = [];
  const cleanup = async () => {
    for (const action of cleanupActions.splice(0).reverse()) await action().catch(() => undefined);
    const dirs = [...new Set(cleanupPaths.map((file) => path.dirname(file)))].sort((a, b) => b.length - a.length);
    for (const file of cleanupPaths.splice(0)) await fs.rm(file, { force: true }).catch(() => undefined);
    for (const dir of dirs) await fs.rmdir(dir).catch(() => undefined);
  };
  const referenceRows = Array.isArray(input.metadata.referenceImages)
    ? input.metadata.referenceImages.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
  const maxReferenceInputs = input.maxReferenceInputs ?? 16;
  if (!Number.isSafeInteger(maxReferenceInputs) || maxReferenceInputs < 1 || maxReferenceInputs > 64) throw new Error("Invalid reference input limit");
  if (referenceRows.length > maxReferenceInputs) throw new Error(`Too many reference inputs; maximum is ${maxReferenceInputs}`);
  let referenceIndex = 0;

  try {
    for (const binding of input.compiled.bindings) {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("Input materialization aborted");
    const source = binding.source ?? "request";
    if (source === "request" || parameters[binding.key] !== undefined) continue;
    if (source === "reference-image") {
      if (binding.valueType === "json") {
        const uploaded: string[] = [];
        for (const row of referenceRows) {
          if (typeof row.artifactId !== "string") continue;
          const artifact = await loadArtifactForJob(row.artifactId, input.job);
          if (!artifact.mimeType.startsWith("image/")) throw new Error("Reference artifact is not an image");
          const bytes = await readBoundedArtifact(artifact, 20 * 1024 * 1024);
          const name = `${artifact.sha256}.${extensionForMime(artifact.mimeType)}`;
          const result = await input.transport.uploadImage(
            { filename: name, bytes, mimeType: artifact.mimeType, subfolder: `ai-m/${input.job.id}/${input.attemptId}` },
            { signal: input.signal },
          );
          if (result.cleanup) cleanupActions.push(result.cleanup);
          uploaded.push(result.subfolder ? `${result.subfolder}/${result.name}` : result.name);
        }
        if (uploaded.length > 0) parameters[binding.key] = uploaded;
      } else {
        const row = referenceRows[referenceIndex++];
        if (!row || typeof row.artifactId !== "string") continue;
        const artifact = await loadArtifactForJob(row.artifactId, input.job);
        if (!artifact.mimeType.startsWith("image/")) throw new Error("Reference artifact is not an image");
        const bytes = await readBoundedArtifact(artifact, 20 * 1024 * 1024);
        const name = `${artifact.sha256}.${extensionForMime(artifact.mimeType)}`;
        const result = await input.transport.uploadImage(
          { filename: name, bytes, mimeType: artifact.mimeType, subfolder: `ai-m/${input.job.id}/${input.attemptId}` },
          { signal: input.signal },
        );
        if (result.cleanup) cleanupActions.push(result.cleanup);
        parameters[binding.key] = result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
      }
      continue;
    }
    if (source === "voice-reference") {
      const durableSources = await db.select({ sourceAssetId: generationJobSourceAssets.sourceAssetId })
        .from(generationJobSourceAssets)
        .where(and(
          eq(generationJobSourceAssets.jobId, input.job.id),
          eq(generationJobSourceAssets.role, "voice-reference"),
        )).limit(2);
      if (durableSources.length > 1) throw new Error("Speech job has multiple voice-reference source assets");
      const sourceAssetId = durableSources[0]?.sourceAssetId;
      const artifactId = input.metadata.voiceReferenceArtifactId;
      const voiceReference = sourceAssetId
        ? await loadSourceAssetForJob(sourceAssetId, input.job)
        : typeof artifactId === "string"
          ? await loadArtifactForJob(artifactId, input.job)
          : null;
      if (!voiceReference) continue;
      if (!voiceReference.mimeType.startsWith("audio/")) throw new Error("Voice reference is not audio");
      const root = await audioInputRoot();
      const relative = path.posix.join("ai-m", input.job.id, input.attemptId, `${voiceReference.sha256}.${extensionForMime(voiceReference.mimeType)}`);
      const destination = path.resolve(root, ...relative.split("/"));
      if (!destination.startsWith(`${root}${path.sep}`)) throw new Error("Audio input path escapes shared root");
      const parent = path.dirname(destination);
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      const realParent = await fs.realpath(parent);
      if (realParent !== root && !realParent.startsWith(`${root}${path.sep}`)) {
        throw new Error("Audio input directory escaped the shared root");
      }
      await copyVerifiedArtifact(
        voiceReference,
        destination,
        100 * 1024 * 1024,
        typeof sourceAssetId === "string" ? resolveSourceAssetPath : resolveArtifactStoragePath,
      );
      cleanupPaths.push(destination);
      parameters[binding.key] = relative;
    }
    }

    return { parameters, cleanup };
  } catch (error) {
    await cleanup();
    throw new InputMaterializationError(error, cleanup);
  }
}
