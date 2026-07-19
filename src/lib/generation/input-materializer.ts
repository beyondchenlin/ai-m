import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  generationArtifacts,
  generationAttempts,
  generationJobs,
  generationJobSourceAssets,
  jobInputArtifacts,
  sourceMediaAssets,
} from "@/lib/db/schema";
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
  const [snapshot] = await db.select().from(jobInputArtifacts).where(and(
    eq(jobInputArtifacts.jobId, job.id),
    eq(jobInputArtifacts.artifactKind, "generation-artifact"),
    eq(jobInputArtifacts.artifactId, artifactId),
  ));
  if (snapshot) return {
    id: snapshot.artifactId,
    storageKey: snapshot.storageKey,
    mimeType: snapshot.mimeType,
    sizeBytes: snapshot.sizeBytes,
    sha256: snapshot.sha256,
  };
  const [anySnapshot] = await db.select({ artifactId: jobInputArtifacts.artifactId })
    .from(jobInputArtifacts).where(eq(jobInputArtifacts.jobId, job.id)).limit(1);
  if (anySnapshot) throw new Error("Input artifact snapshot is missing");
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
  const [snapshot] = await db.select().from(jobInputArtifacts).where(and(
    eq(jobInputArtifacts.jobId, job.id),
    eq(jobInputArtifacts.artifactKind, "source-media"),
    eq(jobInputArtifacts.artifactId, assetId),
  ));
  if (snapshot) {
    return {
      id: snapshot.artifactId,
      projectId: job.projectId ?? "",
      userId: job.requestedBy ?? "",
      storageKey: snapshot.storageKey,
      mimeType: snapshot.mimeType,
      sizeBytes: snapshot.sizeBytes,
      sha256: snapshot.sha256,
    };
  }
  const [anySnapshot] = await db.select({ artifactId: jobInputArtifacts.artifactId })
    .from(jobInputArtifacts).where(eq(jobInputArtifacts.jobId, job.id)).limit(1);
  if (anySnapshot) throw new Error("Source asset snapshot is missing");
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

interface ExpectedFileDescriptor {
  sizeBytes: number;
  sha256: string;
}

function sameFileIdentity(
  left: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>["stat"]>>,
  right: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>["stat"]>>,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

async function consumeVerifiedArtifactFile(
  filePath: string,
  maxBytes: number,
  expected?: ExpectedFileDescriptor,
  consume?: (chunk: Buffer) => Promise<void> | void,
): Promise<{ sizeBytes: number; sha256: string }> {
  const pathInfo = await fs.lstat(filePath);
  if (pathInfo.isSymbolicLink()) throw new Error("Input artifact file is invalid");
  const handle = await fs.open(filePath, "r");
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.size <= 0 || initial.size > maxBytes) {
      throw new Error("Input artifact file is invalid");
    }
    if (expected && initial.size !== expected.sizeBytes) {
      throw new Error("Input artifact integrity changed after commit");
    }
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      const bytes = chunk as Buffer;
      sizeBytes += bytes.byteLength;
      if (sizeBytes > maxBytes) throw new Error("Input artifact exceeds the materialisation limit");
      hash.update(bytes);
      await consume?.(bytes);
    }
    const digest = hash.digest("hex");
    const final = await handle.stat();
    const finalPath = await fs.stat(filePath);
    if (!sameFileIdentity(initial, final) || !sameFileIdentity(initial, finalPath)
      || sizeBytes !== initial.size) {
      throw new Error("Input artifact changed while being read");
    }
    if (expected && (sizeBytes !== expected.sizeBytes || digest !== expected.sha256)) {
      throw new Error("Input artifact integrity changed after commit");
    }
    return { sizeBytes, sha256: digest };
  } finally {
    await handle.close();
  }
}

export async function readVerifiedFileBytes(
  filePath: string,
  expected: ExpectedFileDescriptor,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  await consumeVerifiedArtifactFile(
    filePath,
    maxBytes,
    expected,
    (chunk) => { chunks.push(Buffer.from(chunk)); },
  );
  return new Uint8Array(Buffer.concat(chunks));
}

async function readBoundedArtifact(artifact: ArtifactDescriptor, maxBytes: number): Promise<Uint8Array> {
  if (artifact.sizeBytes <= 0 || artifact.sizeBytes > maxBytes) throw new Error("Input artifact exceeds the materialisation limit");
  const source = resolveArtifactStoragePath(artifact.storageKey);
  return readVerifiedFileBytes(source, artifact, maxBytes);
}

async function copyVerifiedArtifact(
  artifact: { storageKey: string; sizeBytes: number; sha256: string },
  destination: string,
  maxBytes: number,
  resolveSource: (storageKey: string) => string,
): Promise<void> {
  const source = resolveSource(artifact.storageKey);

  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(destination, "wx", 0o600);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "EEXIST") throw error;
    const existing = await consumeVerifiedArtifactFile(destination, maxBytes);
    if (existing.sizeBytes !== artifact.sizeBytes || existing.sha256 !== artifact.sha256) {
      throw new Error("Existing shared input file failed integrity verification");
    }
    return;
  }

  try {
    const destinationHandle = handle;
    if (!destinationHandle) throw new Error("Shared input destination is unavailable");
    const inspected = await consumeVerifiedArtifactFile(
      source,
      maxBytes,
      artifact,
      async (bytes) => {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await destinationHandle.write(bytes, offset, bytes.byteLength - offset);
        if (result.bytesWritten <= 0) throw new Error("Shared input copy made no progress");
        offset += result.bytesWritten;
      }
      },
    );
    await destinationHandle.sync();
    if (inspected.sizeBytes !== artifact.sizeBytes || inspected.sha256 !== artifact.sha256) {
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

async function sharedInputRoot(): Promise<string> {
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

export async function assertManagedInputIsolation(jobId: string, attemptId: string): Promise<void> {
  if (process.env.AI_M_MANAGED_COMFYUI_ENABLED !== "true") return;
  const root = await sharedInputRoot();
  const allowed = [
    { directory: root, child: "ai-m" },
    { directory: path.join(root, "ai-m"), child: jobId },
    { directory: path.join(root, "ai-m", jobId), child: attemptId },
  ];
  for (const level of allowed) {
    const stat = await fs.lstat(level.directory).catch(() => null);
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Managed input namespace contains an unsafe entry");
    for (const entry of await fs.readdir(level.directory, { withFileTypes: true })) {
      if (entry.name !== level.child) {
        const unexpected = path.join(level.directory, entry.name);
        const unexpectedStat = await fs.lstat(unexpected);
        if (level.directory === root && unexpectedStat.isDirectory() && !unexpectedStat.isSymbolicLink()
          && (await fs.readdir(unexpected)).length === 0) {
          await fs.rmdir(unexpected);
          continue;
        }
        throw new Error("Managed input root contains data outside the current slot attempt");
      }
      const child = await fs.lstat(path.join(level.directory, entry.name));
      if (!child.isDirectory() || child.isSymbolicLink()) {
        throw new Error("Managed input namespace contains an unsafe entry");
      }
    }
  }
}

async function trackManagedUploadedInput(
  expectedSubfolder: string,
  expectedName: string,
  result: { name: string; subfolder: string },
): Promise<void> {
  if (result.subfolder !== expectedSubfolder || result.name !== expectedName) {
    throw new Error("ComfyUI upload response escaped the current attempt namespace");
  }
}

async function registerManagedUploadCleanup(
  cleanupPaths: string[],
  expectedSubfolder: string,
  expectedName: string,
): Promise<void> {
  if (!process.env.AI_M_COMFYUI_SHARED_INPUT_ROOT) return;
  const root = await sharedInputRoot();
  const destination = path.resolve(root, ...expectedSubfolder.split("/"), expectedName);
  if (!destination.startsWith(`${root}${path.sep}`)) throw new Error("Uploaded input path escapes the managed root");
  if (!cleanupPaths.includes(destination)) cleanupPaths.push(destination);
}


/** Remove deterministic shared-input namespaces only after their attempts are terminal. */
export async function cleanupTerminalSharedInputs(limit = 100): Promise<number> {
  if (!process.env.AI_M_COMFYUI_SHARED_INPUT_ROOT) return 0;
  const root = await sharedInputRoot();
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
    await assertManagedInputIsolation(input.job.id, input.attemptId);
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
           const expectedSubfolder = `ai-m/${input.job.id}/${input.attemptId}`;
           await registerManagedUploadCleanup(cleanupPaths, expectedSubfolder, name);
           const result = await input.transport.uploadImage(
            { filename: name, bytes, mimeType: artifact.mimeType, subfolder: expectedSubfolder },
            { signal: input.signal },
          );
           await trackManagedUploadedInput(expectedSubfolder, name, result);
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
         const expectedSubfolder = `ai-m/${input.job.id}/${input.attemptId}`;
         await registerManagedUploadCleanup(cleanupPaths, expectedSubfolder, name);
         const result = await input.transport.uploadImage(
          { filename: name, bytes, mimeType: artifact.mimeType, subfolder: expectedSubfolder },
          { signal: input.signal },
        );
         await trackManagedUploadedInput(expectedSubfolder, name, result);
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
      const root = await sharedInputRoot();
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
