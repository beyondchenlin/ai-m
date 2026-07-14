import type { ComfyWorkflow, ComfyWorkflowNode } from "./types";

export class WorkflowFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowFormatError";
  }
}

function isNode(value: unknown): value is ComfyWorkflowNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  return typeof node.class_type === "string"
    && node.class_type.length > 0
    && typeof node.inputs === "object"
    && node.inputs !== null
    && !Array.isArray(node.inputs);
}

/** Normalize official API format and the former { nodes: { ... } } wrapper. */
export function normalizeComfyWorkflow(value: unknown): ComfyWorkflow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowFormatError("Workflow API must be an object keyed by numeric node IDs");
  }
  const candidate = value as Record<string, unknown>;
  const rawNodes = candidate.nodes && typeof candidate.nodes === "object" && !Array.isArray(candidate.nodes)
    ? candidate.nodes as Record<string, unknown>
    : candidate;
  const workflow: ComfyWorkflow = {};
  for (const [nodeId, node] of Object.entries(rawNodes)) {
    if (nodeId === "outputs") continue;
    if (!/^\d+$/.test(nodeId)) throw new WorkflowFormatError(`Node ID must be numeric: ${nodeId}`);
    if (!isNode(node)) throw new WorkflowFormatError(`Node ${nodeId} is malformed`);
    workflow[nodeId] = structuredClone(node);
  }
  if (Object.keys(workflow).length === 0) throw new WorkflowFormatError("Workflow has no executable nodes");
  return workflow;
}
