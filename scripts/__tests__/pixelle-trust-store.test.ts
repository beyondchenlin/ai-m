import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  PIXELLE_TRUST_PATHS,
  provisionPixelleTrustStore,
  verifyPixelleTrustStore,
} from "../pixelle-trust-store";
import { readTask4EvidenceFile } from "../verify-generation-package";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe("Pixelle production trust store", () => {
  it("uses fixed production paths that cannot be replaced by environment variables", () => {
    expect(PIXELLE_TRUST_PATHS.root).toBe(path.join(os.homedir(), ".ai-m", "trust"));
    expect(PIXELLE_TRUST_PATHS.publicKey).toBe(path.join(PIXELLE_TRUST_PATHS.root, "pixelle-task4-ed25519-public.pem"));
    expect(PIXELLE_TRUST_PATHS.privateKey).toBe(path.join(PIXELLE_TRUST_PATHS.root, "pixelle-task4-ed25519-private.pem"));
    expect(PIXELLE_TRUST_PATHS.auditKey).toBe(path.join(PIXELLE_TRUST_PATHS.root, "pixelle-gc-audit-hmac.key"));
  });

  it.runIf(process.platform === "win32")("provisions and verifies owner-only Windows keys plus protected fingerprint metadata", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "pixelle-trust-"));
    roots.push(parent);
    const root = path.join(parent, "trust");
    const paths = await provisionPixelleTrustStore({ root });
    await expect(verifyPixelleTrustStore({ root })).resolves.toMatchObject({ valid: true });
    const metadata = JSON.parse(await fs.readFile(paths.metadata, "utf8")) as { publicKeySha256: string };
    expect(metadata.publicKeySha256).toMatch(/^[a-f0-9]{64}$/);
    await execFileAsync("icacls.exe", [paths.metadata, "/remove:g", "*S-1-5-18"], { windowsHide: true });
    await expect(verifyPixelleTrustStore({ root })).rejects.toThrow(/DACL|SYSTEM|ACL/i);
    await expect(provisionPixelleTrustStore({ root })).rejects.toThrow(/DACL|SYSTEM|ACL/i);
    await execFileAsync("icacls.exe", [paths.metadata, "/grant:r", "*S-1-5-18:(F)"], { windowsHide: true });
    await fs.writeFile(paths.metadata, JSON.stringify({ ...metadata, publicKeySha256: "0".repeat(64) }));
    await expect(verifyPixelleTrustStore({ root })).rejects.toThrow(/fingerprint|metadata/i);
  }, 45_000);

  it.runIf(process.platform === "win32")("writes no keys through an existing junction or an invalid target ACL", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "pixelle-trust-target-"));
    roots.push(parent);
    const victim = path.join(parent, "victim");
    const junction = path.join(parent, "trust");
    await fs.mkdir(victim);
    await fs.symlink(victim, junction, "junction");
    await expect(provisionPixelleTrustStore({ root: junction })).rejects.toThrow(/reparse|junction|regular|DACL/i);
    expect(await fs.readdir(victim)).toEqual([]);

    const valid = path.join(parent, "valid");
    const paths = await provisionPixelleTrustStore({ root: valid });
    const originalPrivate = await fs.readFile(paths.privateKey);
    await execFileAsync("icacls.exe", [valid, "/grant", "*S-1-5-32-545:(R)"], { windowsHide: true });
    await expect(provisionPixelleTrustStore({ root: valid })).rejects.toThrow(/DACL|ACL/i);
    expect(await fs.readFile(paths.privateKey)).toEqual(originalPrivate);
  }, 20_000);

  it.runIf(process.platform === "win32")("cleans its private temporary root on atomic rename failure", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "pixelle-trust-rename-"));
    roots.push(parent);
    const root = path.join(parent, "trust");
    await expect(provisionPixelleTrustStore({
      root,
      renameRoot: async () => { throw new Error("injected trust rename failure"); },
    })).rejects.toThrow(/injected trust rename failure/);
    await expect(fs.lstat(root)).rejects.toThrow();
    expect((await fs.readdir(parent)).filter((name) => name.includes("provision"))).toEqual([]);
  }, 15_000);

  it.runIf(process.platform === "win32")("publishes exactly one valid root under concurrent provisioning", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "pixelle-trust-race-"));
    roots.push(parent);
    const root = path.join(parent, "trust");
    const results = await Promise.allSettled([provisionPixelleTrustStore({ root }), provisionPixelleTrustStore({ root })]);
    expect(results.filter((result) => result.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    await expect(verifyPixelleTrustStore({ root })).resolves.toMatchObject({ valid: true });
    expect((await fs.readdir(parent)).filter((name) => name.includes("provision"))).toEqual([]);
  }, 30_000);

  it("rejects oversized evidence before JSON parsing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixelle-evidence-"));
    roots.push(root);
    const evidence = path.join(root, "evidence.json");
    await fs.writeFile(evidence, Buffer.alloc(256 * 1024 + 1, 0x20));
    await expect(readTask4EvidenceFile(evidence)).rejects.toThrow(/size limit|bounded/i);
  });

  it.runIf(process.platform === "win32")("rejects a linked evidence path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pixelle-evidence-link-"));
    roots.push(root);
    const targetDir = path.join(root, "target");
    const linkedDir = path.join(root, "linked");
    await fs.mkdir(targetDir);
    await fs.writeFile(path.join(targetDir, "evidence.json"), "{}\n");
    await fs.symlink(targetDir, linkedDir, "junction");
    await expect(readTask4EvidenceFile(path.join(linkedDir, "evidence.json"))).rejects.toThrow(/regular file|links|reparse/i);
  });
});
