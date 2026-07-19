import { sha256Canonical } from "./canonical";
import type { ComfyWorkflow, CompiledBindings, WorkflowManifest, WorkflowSelector } from "./types";

export const WORKFLOW_COMPILER_VERSION = "1.0.0";

export class WorkflowCompilationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowCompilationError";
  }
}

function resolveNode(workflow: ComfyWorkflow, selector: WorkflowSelector, label: string): string {
  if (selector.nodeId) {
    const node = workflow[selector.nodeId];
    if (!node) throw new WorkflowCompilationError(`${label} references missing node ${selector.nodeId}`);
    if (node.class_type !== selector.classType) throw new WorkflowCompilationError(`${label} expected ${selector.classType} at node ${selector.nodeId}, found ${node.class_type}`);
    return selector.nodeId;
  }
  const matches = Object.entries(workflow).filter(([, node]) =>
    node.class_type === selector.classType && node._meta?.title === selector.metaTitle,
  );
  if (matches.length !== 1) {
    throw new WorkflowCompilationError(`${label} selector must resolve to exactly one node; found ${matches.length}`);
  }
  return matches[0][0];
}

export function compileWorkflowBindings(
  workflow: ComfyWorkflow,
  manifest: WorkflowManifest,
): CompiledBindings {
  const workflowSha256 = sha256Canonical(workflow);
  const requiredClasses = new Set(manifest.requirements.nodeClasses);
  const actualClasses = new Set(Object.values(workflow).map((node) => node.class_type));
  for (const required of requiredClasses) {
    if (!actualClasses.has(required)) throw new WorkflowCompilationError(`Required node class is missing: ${required}`);
  }

  const bindings = manifest.bindings.map((binding) => {
    const nodeId = resolveNode(workflow, binding.selector, `binding ${binding.key}`);
    const node = workflow[nodeId];
    if (!(binding.inputName in node.inputs)) {
      throw new WorkflowCompilationError(`binding ${binding.key} targets missing input ${nodeId}.${binding.inputName}`);
    }
    const { selector: _selector, ...rest } = binding;
    return { ...rest, nodeId, classType: node.class_type };
  });
  const outputs = manifest.outputs.map((output) => {
    const nodeId = resolveNode(workflow, output.selector, `output ${output.key}`);
    const node = workflow[nodeId];
    const { selector: _selector, ...rest } = output;
    return { ...rest, nodeId, classType: node.class_type };
  });

  return {
    schemaVersion: 1,
    compilerVersion: WORKFLOW_COMPILER_VERSION,
    workflowId: manifest.workflowId,
    version: manifest.version,
    workflowSha256,
    authorContractSha256: sha256Canonical(manifest),
    bindings,
    outputs,
  };
}
