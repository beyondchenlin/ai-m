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

async function protectAcl(target: string, sid: string, directory: boolean): Promise<void> {
  const inheritance = directory ? "(OI)(CI)(F)" : "(F)";
  await execFileAsync("icacls.exe", [target, "/inheritance:r", "/grant:r", `*${sid}:${inheritance}`, `*${SYSTEM_SID}:${inheritance}`], {
    windowsHide: true, maxBuffer: 64 * 1024,
  });
}

type AclSummary = { owner: string; protected: boolean; reparse: boolean; directory: boolean; rules: Array<{ sid: string; inherited: boolean; type: string; rights: string }> };

async function aclSummary(target: string): Promise<AclSummary> {
  const encoded = Buffer.from(target, "utf16le").toString("base64");
  const script = `$p=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'));$i=Get-Item -LiteralPath $p -Force;$a=Get-Acl -LiteralPath $p;$r=@($a.Access|ForEach-Object{@{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;inherited=$_.IsInherited;type=$_.AccessControlType.ToString();rights=$_.FileSystemRights.ToString()}});$o=([System.Security.Principal.NTAccount]$a.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value;@{owner=$o;protected=$a.AreAccessRulesProtected;reparse=[bool]($i.Attributes -band [IO.FileAttributes]::ReparsePoint);directory=$i.PSIsContainer;rules=$r}|ConvertTo-Json -Compress -Depth 4`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, maxBuffer: 64 * 1024 });
  return JSON.parse(stdout) as AclSummary;
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
  for (const [name, target] of Object.entries(paths)) {
    const summary = await aclSummary(target);
    const allowedSids = new Set(summary.rules.map((rule) => rule.sid));
    if (summary.reparse || summary.directory !== (name === "root")) throw new Error(`Pixelle trust ${name} must be regular and have no reparse point`);
    if (summary.owner !== sid || !summary.protected || summary.rules.length < 1
      || allowedSids.size !== 2 || !allowedSids.has(sid) || !allowedSids.has(SYSTEM_SID)
      || summary.rules.some((rule) => rule.inherited || rule.type !== "Allow" || rule.rights !== "FullControl" || ![sid, SYSTEM_SID].includes(rule.sid))) {
      throw new Error(`Pixelle trust ${name} owner or protected DACL is invalid`);
    }
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

export async function provisionPixelleTrustStore(options: { root?: string } = {}): Promise<ReturnType<typeof pathsFor>> {
  const paths = pathsFor(options.root ?? PIXELLE_TRUST_PATHS.root);
  const sid = await currentWindowsSid();
  await fs.mkdir(paths.root, { recursive: true });
  await protectAcl(paths.root, sid, true);
  const present = await Promise.all([paths.privateKey, paths.publicKey, paths.auditKey, paths.metadata].map((file) => fs.lstat(file).then(() => true, () => false)));
  if (present.some(Boolean) && !present.every(Boolean)) throw new Error("Pixelle trust store is partial; refusing to replace or complete keys automatically");
  if (!present.every(Boolean)) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
    const publicPem = publicKey.export({ type: "spki", format: "pem" });
    const metadata = { schemaVersion: 1, keyId: "pixelle-task4-local-ed25519-v1", publicKeySha256: publicFingerprint(Buffer.from(publicPem)) };
    await fs.writeFile(paths.privateKey, privatePem, { flag: "wx" });
    await fs.writeFile(paths.publicKey, publicPem, { flag: "wx" });
    await fs.writeFile(paths.auditKey, randomBytes(32), { flag: "wx" });
    await fs.writeFile(paths.metadata, `${canonicalize(metadata)}\n`, { flag: "wx" });
  }
  for (const target of [paths.privateKey, paths.publicKey, paths.auditKey, paths.metadata]) await protectAcl(target, sid, false);
  await verifyPixelleTrustStore({ root: paths.root });
  return paths;
}

export async function loadProductionTask4PublicKey(): Promise<Buffer> {
  await verifyPixelleTrustStore();
  return readRegularBounded(PIXELLE_TRUST_PATHS.publicKey);
}

export async function loadProductionPixelleAuditKey(): Promise<Buffer> {
  await verifyPixelleTrustStore();
  return readRegularBounded(PIXELLE_TRUST_PATHS.auditKey, 32);
}
