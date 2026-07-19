import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { canonicalize } from "../src/lib/generation/workflows/canonical";

export interface RecoverySource {
  name: string;
  sourcePath: string;
  /** Optional exact relative files for non-secret metadata-only components. */
  includeFiles?: string[];
}

interface RecoveryFile {
  component: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}

export interface RecoveryManifest {
  schemaVersion: 1;
  producer: "ai-m/recovery-bundle-v1";
  createdAtMs: number;
  databaseRelativePath: string;
  files: RecoveryFile[];
  contentDigest: string;
}

const MANIFEST_FILE = "recovery-manifest.json";
const COMPONENT_NAME = /^[a-z][a-z0-9-]{0,63}$/;

function inside(root: string, candidate: string): boolean {
  return candidate.startsWith(`${root}${path.sep}`);
}

function sameIdentity(left: Awaited<ReturnType<typeof fs.stat>>, right: Awaited<ReturnType<typeof fs.stat>>): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

async function copyStableFile(source: string, destination: string): Promise<{ sizeBytes: number; sha256: string }> {
  const sourceHandle = await fs.open(source, "r");
  const destinationHandle = await fs.open(destination, "wx", 0o600);
  try {
    const initial = await sourceHandle.stat();
    if (!initial.isFile()) throw new Error("Recovery source contains a non-regular file");
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of sourceHandle.createReadStream({ autoClose: false, start: 0 })) {
      const bytes = chunk as Buffer;
      hash.update(bytes);
      sizeBytes += bytes.byteLength;
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await destinationHandle.write(bytes, offset, bytes.byteLength - offset);
        if (result.bytesWritten <= 0) throw new Error("Recovery bundle copy made no progress");
        offset += result.bytesWritten;
      }
    }
    await destinationHandle.sync();
    const final = await sourceHandle.stat();
    const finalPath = await fs.stat(source);
    if (!sameIdentity(initial, final) || !sameIdentity(initial, finalPath) || sizeBytes !== initial.size) {
      throw new Error("Recovery source changed while being copied");
    }
    return { sizeBytes, sha256: hash.digest("hex") };
  } finally {
    await Promise.allSettled([sourceHandle.close(), destinationHandle.close()]);
  }
}

async function enumerateRegularTree(root: string): Promise<string[]> {
  const absoluteRoot = path.resolve(root);
  const rootStat = await fs.lstat(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Recovery component must be a regular directory");
  }
  if (await fs.realpath(absoluteRoot) !== absoluteRoot) {
    throw new Error("Recovery component must use its canonical path");
  }
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error("Recovery component contains a link or reparse point");
      if (stat.isDirectory()) await walk(absolute);
      else if (stat.isFile()) files.push(absolute);
      else throw new Error("Recovery component contains an unsupported entry");
    }
  }
  await walk(absoluteRoot);
  return files;
}

function manifestDigest(files: RecoveryFile[], databaseRelativePath: string): string {
  return createHash("sha256").update(Buffer.from(canonicalize({
    schemaVersion: 1,
    databaseRelativePath,
    files,
  }), "utf8")).digest("hex");
}

async function assertDatabaseHealthy(databasePath: string): Promise<void> {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    if (database.pragma("integrity_check", { simple: true }) !== "ok") {
      throw new Error("Recovery database integrity_check failed");
    }
  } finally {
    database.close();
  }
}

export async function createRecoveryBundle(input: {
  databasePath: string;
  components: RecoverySource[];
  destination: string;
  nowMs?: number;
}): Promise<RecoveryManifest> {
  const databasePath = path.resolve(input.databasePath);
  const destination = path.resolve(input.destination);
  const destinationParent = path.dirname(destination);
  const parentStat = await fs.lstat(destinationParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("Recovery bundle parent must be a regular directory");
  }
  if (await fs.lstat(destination).catch(() => null)) throw new Error("Recovery bundle destination already exists");
  const componentNames = new Set<string>();
  const components = input.components.map((component) => {
    if (!COMPONENT_NAME.test(component.name) || component.name === "database") {
      throw new Error("Recovery component name is invalid");
    }
    if (componentNames.has(component.name)) throw new Error("Recovery component names must be unique");
    componentNames.add(component.name);
    const includeFiles = component.includeFiles?.map((value) => value.replace(/\\/g, "/"));
    if (includeFiles?.some((value) => !value || path.posix.isAbsolute(value)
      || value.split("/").some((part) => !part || part === "." || part === ".."))) {
      throw new Error("Recovery component include path is invalid");
    }
    return {
      name: component.name,
      sourcePath: path.resolve(component.sourcePath),
      ...(includeFiles ? { includeFiles: [...new Set(includeFiles)].sort() } : {}),
    };
  });
  for (const component of components) {
    if (component.sourcePath === destination || inside(component.sourcePath, destination)
      || inside(destination, component.sourcePath)) {
      throw new Error("Recovery destination must be outside every source tree");
    }
  }

  await assertDatabaseHealthy(databasePath);
  const staging = path.join(destinationParent, `.${path.basename(destination)}.tmp-${randomUUID()}`);
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    const files: RecoveryFile[] = [];
    const databaseDirectory = path.join(staging, "database");
    await fs.mkdir(databaseDirectory);
    const databaseRelativePath = "database/application.sqlite";
    const stagedDatabase = path.join(staging, ...databaseRelativePath.split("/"));
    const liveDatabase = new Database(databasePath, { fileMustExist: true });
    try {
      await liveDatabase.backup(stagedDatabase);
    } finally {
      liveDatabase.close();
    }
    await fs.chmod(stagedDatabase, 0o600);
    await assertDatabaseHealthy(stagedDatabase);
    const databaseBytes = await copyStableFile(
      stagedDatabase,
      path.join(databaseDirectory, ".verified-copy.sqlite"),
    );
    await fs.rm(path.join(databaseDirectory, ".verified-copy.sqlite"));
    files.push({ component: "database", relativePath: databaseRelativePath, ...databaseBytes });

    for (const component of components) {
      const componentRoot = path.join(staging, component.name);
      await fs.mkdir(componentRoot);
      const sourceFiles = await enumerateRegularTree(component.sourcePath);
      const available = new Map(sourceFiles.map((sourceFile) => [
        path.relative(component.sourcePath, sourceFile).split(path.sep).join("/"),
        sourceFile,
      ]));
      const selected = component.includeFiles
        ? component.includeFiles.map((relative) => {
          const sourceFile = available.get(relative);
          if (!sourceFile) throw new Error(`Required recovery metadata is missing: ${component.name}/${relative}`);
          return sourceFile;
        })
        : sourceFiles;
      for (const sourceFile of selected) {
        const relative = path.relative(component.sourcePath, sourceFile).split(path.sep).join("/");
        const destinationFile = path.join(componentRoot, ...relative.split("/"));
        await fs.mkdir(path.dirname(destinationFile), { recursive: true });
        const identity = await copyStableFile(sourceFile, destinationFile);
        files.push({ component: component.name, relativePath: `${component.name}/${relative}`, ...identity });
      }
    }
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const manifest: RecoveryManifest = {
      schemaVersion: 1,
      producer: "ai-m/recovery-bundle-v1",
      createdAtMs: input.nowMs ?? Date.now(),
      databaseRelativePath,
      files,
      contentDigest: manifestDigest(files, databaseRelativePath),
    };
    await fs.writeFile(path.join(staging, MANIFEST_FILE), `${canonicalize(manifest)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(staging, destination);
    return manifest;
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function parseManifest(value: unknown): RecoveryManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Recovery manifest is invalid");
  const manifest = value as Partial<RecoveryManifest>;
  if (manifest.schemaVersion !== 1 || manifest.producer !== "ai-m/recovery-bundle-v1"
    || !Number.isSafeInteger(manifest.createdAtMs) || !Array.isArray(manifest.files)
    || typeof manifest.databaseRelativePath !== "string" || typeof manifest.contentDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(manifest.contentDigest)) {
    throw new Error("Recovery manifest contract is invalid");
  }
  for (const file of manifest.files) {
    if (!file || typeof file !== "object" || !COMPONENT_NAME.test(file.component)
      || typeof file.relativePath !== "string" || path.posix.isAbsolute(file.relativePath)
      || file.relativePath.split("/").some((part) => !part || part === "." || part === "..")
      || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0
      || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error("Recovery manifest file entry is invalid");
    }
  }
  if (manifest.contentDigest !== manifestDigest(manifest.files, manifest.databaseRelativePath)) {
    throw new Error("Recovery manifest content digest is invalid");
  }
  return manifest as RecoveryManifest;
}

async function verifyBundleFile(bundle: string, file: RecoveryFile): Promise<void> {
  const absolute = path.resolve(bundle, ...file.relativePath.split("/"));
  if (!inside(bundle, absolute)) throw new Error("Recovery file escapes its bundle");
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.sizeBytes) {
    throw new Error(`Recovery file identity is invalid: ${file.relativePath}`);
  }
  const hash = createHash("sha256");
  const handle = await fs.open(absolute, "r");
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk as Buffer);
  } finally {
    await handle.close();
  }
  if (hash.digest("hex") !== file.sha256) throw new Error(`Recovery file digest is invalid: ${file.relativePath}`);
}

export async function restoreRecoveryBundle(input: {
  bundle: string;
  destination: string;
}): Promise<{ manifest: RecoveryManifest; restoredAtMs: number; durationMs: number }> {
  const startedAt = Date.now();
  const bundle = path.resolve(input.bundle);
  const destination = path.resolve(input.destination);
  const bundleStat = await fs.lstat(bundle);
  if (!bundleStat.isDirectory() || bundleStat.isSymbolicLink() || await fs.realpath(bundle) !== bundle) {
    throw new Error("Recovery bundle root is unsafe");
  }
  if (destination === bundle || inside(destination, bundle) || inside(bundle, destination)) {
    throw new Error("Recovery rehearsal destination must be isolated from its bundle");
  }
  if (await fs.lstat(destination).catch(() => null)) throw new Error("Recovery rehearsal destination already exists");
  const bytes = await fs.readFile(path.join(bundle, MANIFEST_FILE));
  if (bytes.byteLength > 16 * 1024 * 1024) throw new Error("Recovery manifest exceeds its size limit");
  const manifest = parseManifest(JSON.parse(bytes.toString("utf8")) as unknown);
  const declared = new Set(manifest.files.map((file) => file.relativePath));
  if (declared.size !== manifest.files.length) throw new Error("Recovery manifest contains duplicate paths");
  for (const file of manifest.files) await verifyBundleFile(bundle, file);
  await assertDatabaseHealthy(path.join(bundle, ...manifest.databaseRelativePath.split("/")));

  const parent = path.dirname(destination);
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("Recovery destination parent is unsafe");
  const staging = path.join(parent, `.${path.basename(destination)}.restore-${randomUUID()}`);
  await fs.mkdir(staging, { mode: 0o700 });
  try {
    for (const file of manifest.files) {
      const source = path.join(bundle, ...file.relativePath.split("/"));
      const target = path.join(staging, ...file.relativePath.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      const copied = await copyStableFile(source, target);
      if (copied.sizeBytes !== file.sizeBytes || copied.sha256 !== file.sha256) {
        throw new Error(`Restored file verification failed: ${file.relativePath}`);
      }
    }
    await assertDatabaseHealthy(path.join(staging, ...manifest.databaseRelativePath.split("/")));
    await fs.rename(staging, destination);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
  const restoredAtMs = Date.now();
  return { manifest, restoredAtMs, durationMs: restoredAtMs - startedAt };
}
