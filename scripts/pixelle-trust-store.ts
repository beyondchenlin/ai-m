import { execFile } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { canonicalize } from "../src/lib/generation/workflows/canonical";

const execFileAsync = promisify(execFile);
const SYSTEM_SID = "S-1-5-18";
const MAX_KEY_BYTES = 16 * 1024;

function pathsFor(root: string) {
  const resolved = path.resolve(root);
  return Object.freeze({
    root: resolved,
    privateKey: path.join(resolved, "pixelle-task4-ed25519-private.pem"),
    publicKey: path.join(resolved, "pixelle-task4-ed25519-public.pem"),
    auditKey: path.join(resolved, "pixelle-gc-audit-hmac.key"),
    metadata: path.join(resolved, "pixelle-trust-metadata.json"),
  });
}

export const PIXELLE_TRUST_PATHS = pathsFor(path.join(os.homedir(), ".ai-m", "trust"));

async function currentWindowsSid(): Promise<string> {
  if (process.platform !== "win32") throw new Error("Pixelle production trust provisioning requires Windows");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { windowsHide: true, maxBuffer: 16 * 1024 });
  const sid = stdout.trim();
  if (!/^S-1-(?:\d+-)+\d+$/.test(sid)) throw new Error("Unable to resolve the current Windows SID");
  return sid;
}

async function setProtectedAcl(target: string, sid: string, directory: boolean): Promise<void> {
  const encoded = Buffer.from(target, "utf16le").toString("base64");
  const aclType = directory ? "DirectorySecurity" : "FileSecurity";
  const inheritance = directory ? "[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'" : "[Security.AccessControl.InheritanceFlags]::None";
  const script = `$p=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'));$s=[Security.Principal.SecurityIdentifier]'${sid}';$y=[Security.Principal.SecurityIdentifier]'${SYSTEM_SID}';$a=New-Object Security.AccessControl.${aclType};$a.SetOwner($s);$a.SetAccessRuleProtection($true,$false);$f=[Security.AccessControl.FileSystemRights]::FullControl;$n=[Security.AccessControl.PropagationFlags]::None;$t=[Security.AccessControl.AccessControlType]::Allow;$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($s,$f,${inheritance},$n,$t)));$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($y,$f,${inheritance},$n,$t)));Set-Acl -LiteralPath $p -AclObject $a`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, maxBuffer: 64 * 1024 });
}

type AclSummary = { owner: string; protected: boolean; reparse: boolean; directory: boolean; rules: Array<{ sid: string; inherited: boolean; type: string; rights: string }> };

async function aclSummary(target: string): Promise<AclSummary> {
  const encoded = Buffer.from(target, "utf16le").toString("base64");
  const script = `$p=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'));$i=Get-Item -LiteralPath $p -Force;$a=Get-Acl -LiteralPath $p;$r=@($a.Access|ForEach-Object{@{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;inherited=$_.IsInherited;type=$_.AccessControlType.ToString();rights=$_.FileSystemRights.ToString()}});$o=([System.Security.Principal.NTAccount]$a.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value;@{owner=$o;protected=$a.AreAccessRulesProtected;reparse=[bool]($i.Attributes -band [IO.FileAttributes]::ReparsePoint);directory=$i.PSIsContainer;rules=$r}|ConvertTo-Json -Compress -Depth 4`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, maxBuffer: 64 * 1024 });
  return JSON.parse(stdout) as AclSummary;
}

async function assertNoReparseComponents(target: string): Promise<void> {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error(`Pixelle trust path contains a junction or reparse point: ${cursor}`);
  }
}

function assertAcl(summary: AclSummary, sid: string, name: string, directory: boolean): void {
  const allowedSids = new Set(summary.rules.map((rule) => rule.sid));
  if (summary.reparse || summary.directory !== directory) throw new Error(`Pixelle trust ${name} must be regular and have no reparse point`);
  if (summary.owner !== sid || !summary.protected || summary.rules.length < 1
    || allowedSids.size !== 2 || !allowedSids.has(sid) || !allowedSids.has(SYSTEM_SID)
    || summary.rules.some((rule) => rule.inherited || rule.type !== "Allow" || rule.rights !== "FullControl" || ![sid, SYSTEM_SID].includes(rule.sid))) {
    throw new Error(`Pixelle trust ${name} owner or protected DACL is invalid`);
  }
}

async function readRegularBounded(file: string, maximum = MAX_KEY_BYTES): Promise<Buffer> {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) throw new Error(`Trust file is not a bounded regular no-link file: ${path.basename(file)}`);
  const bytes = await fs.readFile(file);
  const after = await fs.lstat(file);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("Trust file changed while being verified");
  return bytes;
}

function publicFingerprint(publicPem: Buffer): string {
  const der = createPublicKey(publicPem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

export async function verifyPixelleTrustStore(options: { root?: string } = {}): Promise<{ valid: true; publicKeySha256: string }> {
  const paths = pathsFor(options.root ?? PIXELLE_TRUST_PATHS.root);
  const sid = await currentWindowsSid();
  await assertNoReparseComponents(paths.root);
  for (const [name, target] of Object.entries(paths)) {
    const summary = await aclSummary(target);
    assertAcl(summary, sid, name, name === "root");
  }
  const privatePem = await readRegularBounded(paths.privateKey);
  const publicPem = await readRegularBounded(paths.publicKey);
  const auditKey = await readRegularBounded(paths.auditKey, 32);
  const metadataBytes = await readRegularBounded(paths.metadata, 4 * 1024);
  if (auditKey.length !== 32) throw new Error("Pixelle audit key must be exactly 32 bytes");
  const derived = createPublicKey(createPrivateKey(privatePem)).export({ type: "spki", format: "der" });
  const actual = createPublicKey(publicPem).export({ type: "spki", format: "der" });
  if (!Buffer.from(derived).equals(Buffer.from(actual))) throw new Error("Pixelle public/private keys do not match");
  let metadata: unknown;
  try { metadata = JSON.parse(metadataBytes.toString("utf8")); } catch { throw new Error("Pixelle trust metadata is invalid JSON"); }
  const fingerprint = publicFingerprint(publicPem);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
    || Object.keys(metadata).sort().join(",") !== "keyId,publicKeySha256,schemaVersion"
    || Reflect.get(metadata, "schemaVersion") !== 1 || Reflect.get(metadata, "keyId") !== "pixelle-task4-local-ed25519-v1"
    || Reflect.get(metadata, "publicKeySha256") !== fingerprint) throw new Error("Pixelle trust metadata fingerprint pin is invalid");
  return { valid: true, publicKeySha256: fingerprint };
}

async function cleanupOwnedTempRoot(tempRoot: string): Promise<void> {
  const stat = await fs.lstat(tempRoot).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing to clean an unsafe Pixelle trust temporary root");
  const allowed = new Set(["pixelle-task4-ed25519-private.pem", "pixelle-task4-ed25519-public.pem", "pixelle-gc-audit-hmac.key", "pixelle-trust-metadata.json"]);
  for (const name of await fs.readdir(tempRoot)) {
    if (!allowed.has(name)) throw new Error("Refusing to clean an unfamiliar Pixelle trust temporary root");
    const child = await fs.lstat(path.join(tempRoot, name));
    if (!child.isFile() || child.isSymbolicLink()) throw new Error("Refusing to clean a linked Pixelle trust temporary file");
  }
  await fs.rm(tempRoot, { recursive: true, force: false });
}

export async function provisionPixelleTrustStore(options: { root?: string; renameRoot?: typeof fs.rename } = {}): Promise<ReturnType<typeof pathsFor>> {
  const paths = pathsFor(options.root ?? PIXELLE_TRUST_PATHS.root);
  const sid = await currentWindowsSid();
  await assertNoReparseComponents(paths.root);
  const target = await fs.lstat(paths.root).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (target) {
    await verifyPixelleTrustStore({ root: paths.root });
    return paths;
  }
  const parent = path.dirname(paths.root);
  await fs.mkdir(parent, { recursive: true });
  await assertNoReparseComponents(parent);
  const token = randomBytes(16).toString("hex");
  const tempRoot = path.join(parent, `.${path.basename(paths.root)}.provision-${token}`);
  const tempPaths = pathsFor(tempRoot);
  let published = false;
  try {
    await fs.mkdir(tempRoot);
    await setProtectedAcl(tempRoot, sid, true);
    assertAcl(await aclSummary(tempRoot), sid, "temporary root", true);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
    const publicPem = publicKey.export({ type: "spki", format: "pem" });
    const metadata = { schemaVersion: 1, keyId: "pixelle-task4-local-ed25519-v1", publicKeySha256: publicFingerprint(Buffer.from(publicPem)) };
    await fs.writeFile(tempPaths.privateKey, privatePem, { flag: "wx" });
    await fs.writeFile(tempPaths.publicKey, publicPem, { flag: "wx" });
    await fs.writeFile(tempPaths.auditKey, randomBytes(32), { flag: "wx" });
    await fs.writeFile(tempPaths.metadata, `${canonicalize(metadata)}\n`, { flag: "wx" });
    for (const file of [tempPaths.privateKey, tempPaths.publicKey, tempPaths.auditKey, tempPaths.metadata]) await setProtectedAcl(file, sid, false);
    await verifyPixelleTrustStore({ root: tempRoot });
    try {
      await (options.renameRoot ?? fs.rename)(tempRoot, paths.root);
      published = true;
    } catch (error) {
      const appeared = await fs.lstat(paths.root).then(() => true, () => false);
      if (!appeared) throw error;
      await verifyPixelleTrustStore({ root: paths.root });
    }
    await verifyPixelleTrustStore({ root: paths.root });
    return paths;
  } finally {
    if (!published) await cleanupOwnedTempRoot(tempRoot);
  }
}

export async function loadProductionTask4PublicKey(): Promise<Buffer> {
  await verifyPixelleTrustStore();
  return readRegularBounded(PIXELLE_TRUST_PATHS.publicKey);
}

export async function loadProductionTask4PrivateKey(): Promise<Buffer> {
  await verifyPixelleTrustStore();
  return readRegularBounded(PIXELLE_TRUST_PATHS.privateKey);
}

export async function loadProductionPixelleAuditKey(): Promise<Buffer> {
  await verifyPixelleTrustStore();
  return readRegularBounded(PIXELLE_TRUST_PATHS.auditKey, 32);
}
