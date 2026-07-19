import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowPackageRevisions, workflowPackageStates } from "@/lib/db/schema";
import { normalizeComfyWorkflow } from "./normalize";
import { parseWorkflowManifest } from "./manifest";
import { parseCompiledBindings } from "./compiled";
import { sha256Canonical } from "./canonical";
import {
  workflowStateAllowedForValidation,
  type WorkflowValidationKind,
} from "./validation-policy";

export async function loadActiveWorkflowPackage(digest: string) {
  return loadValidatedWorkflowPackage(digest, "release");
}

export async function loadValidatedWorkflowPackage(
  digest: string,
  validationKind: WorkflowValidationKind,
) {
  const [row] = await db.select({
    revision: workflowPackageRevisions,
    state: workflowPackageStates,
  }).from(workflowPackageRevisions)
    .innerJoin(workflowPackageStates, eq(workflowPackageStates.workflowPackageDigest, workflowPackageRevisions.digest))
    .where(eq(workflowPackageRevisions.digest, digest));
  if (!row || !workflowStateAllowedForValidation(validationKind, row.state.state)) {
    throw new Error(`Validated workflow package not found: ${digest}`);
  }
  const workflow = normalizeComfyWorkflow(row.revision.workflowApiJson);
  const manifest = parseWorkflowManifest(row.revision.manifestJson);
  const compiled = parseCompiledBindings(row.revision.compiledBindingsJson);
  const workflowDigest = sha256Canonical(workflow);
  if (compiled.workflowSha256 !== workflowDigest || row.revision.workflowSha256 !== workflowDigest) {
    throw new Error("Workflow package integrity check failed");
  }
  if (compiled.workflowId !== manifest.workflowId || compiled.version !== manifest.version) {
    throw new Error("Compiled workflow identity does not match manifest");
  }
  for (const binding of compiled.bindings) {
    const node = workflow[binding.nodeId];
    if (!node || node.class_type !== binding.classType || !(binding.inputName in node.inputs)) {
      throw new Error(`Compiled binding target drifted: ${binding.key}`);
    }
  }
  for (const output of compiled.outputs) {
    const node = workflow[output.nodeId];
    if (!node || node.class_type !== output.classType) throw new Error(`Compiled output target drifted: ${output.key}`);
  }
  return { workflow, manifest, compiled, revision: row.revision, state: row.state };
}
