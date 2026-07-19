import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

const MAX_FILES = 64;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

type FileRecord = { relativePath: string; sizeBytes: number; sha256: string };

function inside(root: string, candidate: string): boolean {
  return candidate.startsWith(`${root}${path.sep}`);
}

async function inspectRegularTree(root: string): Promise<FileRecord[]> {
  const resolvedRoot = path.resolve(root);
  const rootStat = await fs.lstat(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Workflow package root must be a regular directory");
  }
  const files: FileRecord[] = [];
  let totalBytes = 0;
  async function walk(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error("Workflow package tree cannot contain links or reparse points");
      if (stat.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!stat.isFile()) throw new Error("Workflow package tree contains an unsupported entry");
      if (files.length >= MAX_FILES) throw new Error(`Workflow package exceeds ${MAX_FILES} files`);
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Workflow package exceeds the isolated staging byte limit");
      const bytes = await fs.readFile(absolute);
      const after = await fs.lstat(absolute);
      if (after.dev !== stat.dev || after.ino !== stat.ino
        || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
        throw new Error("Workflow package file changed while entering quarantine");
      }
      files.push({
        relativePath: path.relative(resolvedRoot, absolute).split(path.sep).join("/"),
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  await walk(resolvedRoot);
  if (!files.length) throw new Error("Workflow package is empty");
  return files;
}

async function copyTree(source: string, destination: string, files: FileRecord[]): Promise<void> {
  for (const file of files) {
    const sourceFile = path.join(source, ...file.relativePath.split("/"));
    const destinationFile = path.join(destination, ...file.relativePath.split("/"));
    await fs.mkdir(path.dirname(destinationFile), { recursive: true });
    await fs.copyFile(sourceFile, destinationFile, constants.COPYFILE_EXCL);
  }
}

export async function stageWorkflowPackage(
  sourceDirectory: string,
  supplyChainRoot: string,
): Promise<{ stagingDirectory: string; files: FileRecord[] }> {
  const source = await fs.realpath(path.resolve(sourceDirectory));
  const root = path.resolve(supplyChainRoot);
  if (source === root || inside(source, root) || inside(root, source)) {
    throw new Error("Workflow source and supply-chain root must be separate trees");
  }
  await fs.mkdir(root, { recursive: true });
  const realRoot = await fs.realpath(root);
  const quarantineRoot = path.join(realRoot, "quarantine");
  const publishedRoot = path.join(realRoot, "published");
  await fs.mkdir(quarantineRoot, { recursive: true });
  await fs.mkdir(publishedRoot, { recursive: true });
  const files = await inspectRegularTree(source);
  const stagingDirectory = path.join(quarantineRoot, randomUUID());
  await fs.mkdir(stagingDirectory);
  try {
    await copyTree(source, stagingDirectory, files);
    const copied = await inspectRegularTree(stagingDirectory);
    if (JSON.stringify(copied) !== JSON.stringify(files)) {
      throw new Error("Workflow quarantine copy does not match the reviewed source bytes");
    }
    return { stagingDirectory, files };
  } catch (error) {
    await fs.rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function makeTreeReadOnly(root: string): Promise<void> {
  const directories: string[] = [];
  async function walk(directory: string): Promise<void> {
    directories.push(directory);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error("Published workflow cannot contain links");
      if (stat.isDirectory()) await walk(absolute);
      else if (stat.isFile()) await fs.chmod(absolute, 0o444);
      else throw new Error("Published workflow contains an unsupported entry");
    }
  }
  await walk(root);
  for (const directory of directories.reverse()) await fs.chmod(directory, 0o555);
}

export async function protectPublishedWorkflowTree(root: string): Promise<void> {
  await inspectRegularTree(root);
  await makeTreeReadOnly(root);
  await assertPublishedWorkflowReadOnly(root);
}

export async function assertPublishedWorkflowReadOnly(publishedDirectory: string): Promise<void> {
  const root = path.resolve(publishedDirectory);
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Published workflow root is unsafe");
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const item = await fs.lstat(absolute);
      if (item.isSymbolicLink()) throw new Error("Published workflow cannot contain links");
      if ((item.mode & 0o222) !== 0) throw new Error("Published workflow tree is writable");
      if (item.isDirectory()) await walk(absolute);
      else if (!item.isFile()) throw new Error("Published workflow contains an unsupported entry");
    }
  }
  if ((stat.mode & 0o222) !== 0) throw new Error("Published workflow root is writable");
  await walk(root);
}

export async function publishStagedWorkflowPackage(
  stagingDirectory: string,
  supplyChainRoot: string,
): Promise<string> {
  const root = await fs.realpath(path.resolve(supplyChainRoot));
  const quarantineRoot = await fs.realpath(path.join(root, "quarantine"));
  const staging = await fs.realpath(path.resolve(stagingDirectory));
  if (!inside(quarantineRoot, staging) || path.dirname(staging) !== quarantineRoot) {
    throw new Error("Only a direct quarantine child can be published");
  }
  await inspectRegularTree(staging);
  const publishedRoot = await fs.realpath(path.join(root, "published"));
  const destination = path.join(publishedRoot, randomUUID());
  await fs.rename(staging, destination);
  try {
    await protectPublishedWorkflowTree(destination);
    return destination;
  } catch (error) {
    // The directory remains isolated and unreferenced for privileged recovery.
    throw new Error("Workflow publication could not establish read-only permissions", { cause: error });
  }
}

export async function discardStagedWorkflowPackage(
  stagingDirectory: string,
  supplyChainRoot: string,
): Promise<void> {
  const root = await fs.realpath(path.resolve(supplyChainRoot));
  const quarantineRoot = await fs.realpath(path.join(root, "quarantine"));
  const staging = path.resolve(stagingDirectory);
  if (!inside(quarantineRoot, staging) || path.dirname(staging) !== quarantineRoot) {
    throw new Error("Refusing to discard a path outside the workflow quarantine");
  }
  await fs.rm(staging, { recursive: true, force: true });
}
