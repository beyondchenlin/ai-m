import { db } from "@/lib/db";
import { workflowPackageRevisions, workflowPackageStates } from "@/lib/db/schema";
import { normalizeComfyWorkflow } from "./normalize";
import { parseWorkflowManifest } from "./manifest";
import { compileWorkflowBindings, WORKFLOW_COMPILER_VERSION } from "./compiler";
import { canonicalize, sha256 } from "./canonical";
import { parseWorkflowPackageLock, verifyLockedFiles } from "./package-lock";
import { applyStaticPolicy, validateWorkflowStructure } from "./validator";
import type { WorkflowPackageInput } from "./types";

export async function importWorkflowPackage(
  input: WorkflowPackageInput,
  actorId: string,
): Promise<{ digest: string; state: "installed" }> {
  const workflow = normalizeComfyWorkflow(input.workflowApi);
  const structure = validateWorkflowStructure(workflow);
  const staticPolicy = applyStaticPolicy(workflow);
  const validationErrors = [...structure.errors, ...staticPolicy.errors];
  if (validationErrors.length) throw new Error(`Workflow package validation failed: ${validationErrors.join("; ")}`);
  const manifest = parseWorkflowManifest(input.manifest);
  const compiled = compileWorkflowBindings(workflow, manifest);
  const packageLock = parseWorkflowPackageLock(input.packageLock, manifest);
  verifyLockedFiles(packageLock, input.verifiedFileDigests);
  const digest = sha256({ workflow, manifest, compiled, packageLock });
  const now = Date.now();
  db.transaction((tx) => {
    tx.insert(workflowPackageRevisions).values({
      digest,
      workflowId: manifest.workflowId,
      version: manifest.version,
      capability: manifest.capability,
      workflowApiJson: workflow,
      manifestJson: manifest,
      compiledBindingsJson: compiled,
      packageLockJson: packageLock,
      packagePath: input.packagePath,
      workflowSha256: compiled.workflowSha256,
      compilerVersion: WORKFLOW_COMPILER_VERSION,
      compiledAtMs: now,
      environmentLockDigest: typeof packageLock.environmentLockDigest === "string" ? packageLock.environmentLockDigest : null,
      createdAtMs: now,
    }).onConflictDoNothing().run();
    tx.insert(workflowPackageStates).values({
      workflowPackageDigest: digest,
      state: "installed",
      validationReportJson: {
        importedBy: actorId,
        importedAtMs: now,
        workflowNodeCount: Object.keys(workflow).length,
        contractSha256: sha256(canonicalize(manifest)),
        ...(input.generationProvenance ? { generationProvenance: input.generationProvenance } : {}),
      },
      updatedAtMs: now,
    }).onConflictDoNothing().run();
  });
  return { digest, state: "installed" };
}
