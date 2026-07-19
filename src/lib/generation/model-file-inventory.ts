import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { canonicalize } from "./workflows/canonical";
import type { WorkflowManifest } from "./workflows/types";

export type RequiredModel = WorkflowManifest["requirements"]["models"][number];

export interface VerifiedModelFile {
  folder: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
}

export interface VerifiedModelInventory {
  schemaVersion: 1;
  models: VerifiedModelFile[];
  inventoryDigest: string;
}

interface ModelInventoryCacheEntry {
  state: "pending" | "fulfilled";
  expiresAtMs: number;
  promise: Promise<{ inventory: VerifiedModelInventory; identityDigest: string }>;
}

const modelInventoryCache = new Map<string, ModelInventoryCacheEntry>();
const MAX_MODEL_INVENTORY_CACHE_ENTRIES = 64;

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function safeRelativeModelPath(model: RequiredModel): string[] {
  if (!/^[A-Za-z0-9._-]+$/.test(model.folder)) throw new Error("Model folder is unsafe");
  const normalized = model.filename.replace(/\\/g, "/");
  if (!normalized || path.posix.isAbsolute(normalized)) throw new Error("Model filename is unsafe");
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) {
    throw new Error("Model filename is unsafe");
  }
  return [model.folder, ...parts];
}

async function assertNoLinkedComponents(root: string, file: string): Promise<void> {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Model path escapes the managed model root");
  }
  let cursor = root;
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component);
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error("Model path contains a link or reparse point");
  }
}

function sameIdentity(
  left: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>["stat"]>>,
  right: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>["stat"]>>,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

async function hashStableRegularFile(file: string): Promise<{ sizeBytes: number; sha256: string }> {
  const handle = await fs.open(file, "r");
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.size <= 0) throw new Error("Model must be a non-empty regular file");
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      const bytes = chunk as Buffer;
      sizeBytes += bytes.byteLength;
      hash.update(bytes);
    }
    const final = await handle.stat();
    const finalPath = await fs.stat(file);
    if (!sameIdentity(initial, final) || !sameIdentity(initial, finalPath) || sizeBytes !== initial.size) {
      throw new Error("Model file changed while its inventory was captured");
    }
    return { sizeBytes, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

export async function verifyRequiredModelFiles(
  modelsRoot: string,
  requirements: RequiredModel[],
): Promise<VerifiedModelInventory> {
  const root = path.resolve(modelsRoot);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Managed model root must be a regular directory");
  }
  const realRoot = await fs.realpath(root);
  if (!samePath(realRoot, root)) throw new Error("Managed model root must use its canonical path");
  const identityDigestBefore = await captureRequiredModelIdentityDigest(root, requirements);

  const unique = new Map<string, RequiredModel>();
  for (const model of requirements) {
    const parts = safeRelativeModelPath(model);
    const key = parts.join("/");
    const existing = unique.get(key);
    if (existing?.sizeBytes !== undefined && model.sizeBytes !== undefined
      && existing.sizeBytes !== model.sizeBytes) {
      throw new Error(`Conflicting expected sizes for model ${key}`);
    }
    if (existing?.sha256 && model.sha256 && existing.sha256.toLowerCase() !== model.sha256.toLowerCase()) {
      throw new Error(`Conflicting expected digests for model ${key}`);
    }
    if (existing && (existing.runtimeFolder ?? existing.folder) !== (model.runtimeFolder ?? model.folder)) {
      throw new Error(`Conflicting runtime folders for model ${key}`);
    }
    if (existing && (existing.runtimeVisible ?? true) !== (model.runtimeVisible ?? true)) {
      throw new Error(`Conflicting runtime visibility for model ${key}`);
    }
    unique.set(key, {
      folder: model.folder,
      ...(model.runtimeFolder ? { runtimeFolder: model.runtimeFolder } : {}),
      ...(model.runtimeVisible !== undefined ? { runtimeVisible: model.runtimeVisible } : {}),
      filename: model.filename.replace(/\\/g, "/"),
      ...(model.sizeBytes !== undefined || existing?.sizeBytes !== undefined
        ? { sizeBytes: model.sizeBytes ?? existing!.sizeBytes }
        : {}),
      ...(model.sha256 || existing?.sha256
        ? { sha256: (model.sha256 ?? existing!.sha256)!.toLowerCase() }
        : {}),
    });
  }

  const models: VerifiedModelFile[] = [];
  for (const [key, model] of [...unique.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const file = path.resolve(root, ...safeRelativeModelPath(model));
    if (!inside(root, file)) throw new Error("Model path escapes the managed model root");
    await assertNoLinkedComponents(root, file);
    const realFileBefore = await fs.realpath(file);
    if (!inside(realRoot, realFileBefore) || !samePath(realFileBefore, file)) {
      throw new Error("Model path escapes the canonical managed model root");
    }
    const actual = await hashStableRegularFile(file);
    const realFileAfter = await fs.realpath(file);
    if (!samePath(realFileBefore, realFileAfter)) throw new Error("Model path changed while its inventory was captured");
    if (model.sizeBytes !== undefined && actual.sizeBytes !== model.sizeBytes) {
      throw new Error(`Required model size drifted: ${key}`);
    }
    if (model.sha256 && actual.sha256 !== model.sha256) {
      throw new Error(`Required model digest drifted: ${key}`);
    }
    models.push({
      folder: model.folder,
      filename: model.filename.replace(/\\/g, "/"),
      sizeBytes: actual.sizeBytes,
      sha256: actual.sha256,
    });
  }

  const identityDigestAfter = await captureRequiredModelIdentityDigest(root, requirements);
  if (identityDigestAfter !== identityDigestBefore) {
    throw new Error("Model identity changed while its inventory was captured");
  }

  const inventoryDigest = createHash("sha256")
    .update(Buffer.from(canonicalize({ schemaVersion: 1, models }), "utf8"))
    .digest("hex");
  return { schemaVersion: 1, models, inventoryDigest };
}

export async function verifyRequiredModelFilesCached(
  modelsRoot: string,
  requirements: RequiredModel[],
  options: { nowMs?: number; ttlMs?: number } = {},
): Promise<VerifiedModelInventory> {
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60 * 60_000) {
    throw new Error("Model inventory cache timing is invalid");
  }
  const normalizedRoot = process.platform === "win32"
    ? path.resolve(modelsRoot).toLowerCase()
    : path.resolve(modelsRoot);
  const normalizedRequirements = requirements.map((model) => ({
    folder: model.folder,
    runtimeFolder: model.runtimeFolder ?? model.folder,
    runtimeVisible: model.runtimeVisible ?? true,
    filename: model.filename.replace(/\\/g, "/"),
    sizeBytes: model.sizeBytes ?? null,
    sha256: model.sha256?.toLowerCase() ?? null,
  })).sort((left, right) => `${left.folder}/${left.filename}`.localeCompare(`${right.folder}/${right.filename}`));
  const cacheKey = createHash("sha256")
    .update(Buffer.from(canonicalize({ normalizedRoot, normalizedRequirements }), "utf8"))
    .digest("hex");
  const existing = modelInventoryCache.get(cacheKey);
  if (existing && (existing.state === "pending" || existing.expiresAtMs > nowMs)) {
    const cached = await existing.promise;
    if (await captureRequiredModelIdentityDigest(modelsRoot, requirements) === cached.identityDigest) return cached.inventory;
    modelInventoryCache.delete(cacheKey);
  } else if (existing) {
    modelInventoryCache.delete(cacheKey);
  }

  const entry: ModelInventoryCacheEntry = {
    state: "pending",
    expiresAtMs: Number.POSITIVE_INFINITY,
    promise: Promise.resolve(undefined as never),
  };
  const promise = (async () => {
    const before = await captureRequiredModelIdentityDigest(modelsRoot, requirements);
    const inventory = await verifyRequiredModelFiles(modelsRoot, requirements);
    const after = await captureRequiredModelIdentityDigest(modelsRoot, requirements);
    if (before !== after) throw new Error("Model identity changed while its cached inventory was captured");
    entry.state = "fulfilled";
    entry.expiresAtMs = nowMs + ttlMs;
    return { inventory, identityDigest: after };
  })();
  entry.promise = promise;
  modelInventoryCache.set(cacheKey, entry);
  if (modelInventoryCache.size > MAX_MODEL_INVENTORY_CACHE_ENTRIES) {
    const oldest = modelInventoryCache.keys().next().value as string | undefined;
    if (oldest && oldest !== cacheKey) modelInventoryCache.delete(oldest);
  }
  try {
    return (await promise).inventory;
  } catch (error) {
    if (modelInventoryCache.get(cacheKey)?.promise === promise) modelInventoryCache.delete(cacheKey);
    throw error;
  }
}

export async function captureRequiredModelIdentityDigest(
  modelsRoot: string,
  requirements: RequiredModel[],
): Promise<string> {
  const root = path.resolve(modelsRoot);
  const realRoot = await fs.realpath(root);
  if (!samePath(root, realRoot)) throw new Error("Managed model root must use its canonical path");
  const keys = [...new Set(requirements.map((model) => safeRelativeModelPath(model).join("/")))].sort();
  const identities = [];
  for (const key of keys) {
    const parts = key.split("/");
    const file = path.resolve(root, ...parts);
    if (!inside(root, file)) throw new Error("Model path escapes the managed model root");
    await assertNoLinkedComponents(root, file);
    const realFile = await fs.realpath(file);
    if (!inside(realRoot, realFile) || !samePath(file, realFile)) throw new Error("Model path escapes the canonical managed model root");
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error("Model must be a non-empty regular file");
    identities.push({
      key, dev: stat.dev, ino: stat.ino, size: stat.size,
      mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, birthtimeMs: stat.birthtimeMs,
    });
  }
  return createHash("sha256")
    .update(Buffer.from(canonicalize(identities), "utf8"))
    .digest("hex");
}

export function applyVerifiedModelDigests(
  requirements: RequiredModel[],
  inventory: VerifiedModelInventory,
): RequiredModel[] {
  const byKey = new Map(inventory.models.map((model) => [`${model.folder}/${model.filename}`, model]));
  return requirements.map((model) => {
    const filename = model.filename.replace(/\\/g, "/");
    const verified = byKey.get(`${model.folder}/${filename}`);
    if (!verified) throw new Error(`Model inventory omitted ${model.folder}/${filename}`);
    return {
      folder: model.folder,
      ...(model.runtimeFolder ? { runtimeFolder: model.runtimeFolder } : {}),
      ...(model.runtimeVisible !== undefined ? { runtimeVisible: model.runtimeVisible } : {}),
      filename,
      sizeBytes: verified.sizeBytes,
      sha256: verified.sha256,
    };
  });
}
