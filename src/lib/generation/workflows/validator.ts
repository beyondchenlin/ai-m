/** Platform-owned workflow validation. Workflow authors cannot relax these rules. */
import { normalizeComfyWorkflow } from "./normalize";
import { sha256 } from "./canonical";

export interface WorkflowStructureConstraints {
  maxNodes: number;
  maxNodeClasses: number;
  allowedNodeClasses: string[];
  maxPackageSizeBytes: number;
}

export interface WorkflowStaticPolicy {
  enforcePathTraversalCheck: boolean;
  blockedNodeClasses: string[];
}

export interface WorkflowValidationResult {
  valid: boolean;
  digest: string;
  nodeCount: number;
  nodeClasses: Set<string>;
  errors: string[];
  warnings: string[];
}

const DEFAULT_CONSTRAINTS: WorkflowStructureConstraints = {
  maxNodes: 512,
  maxNodeClasses: 256,
  allowedNodeClasses: ["*"],
  maxPackageSizeBytes: 10 * 1024 * 1024,
};

const DEFAULT_BLOCKED_NODE_CLASSES = new Set([
  "ExecutePython", "PythonScript", "ShellCommand", "SystemCommand",
  "LoadImageFromUrl", "DownloadFile", "HTTPRequest", "HTTPNode",
]);

function unsafePathReason(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.includes("\0")) return "NUL byte";
  if (trimmed.includes("../") || trimmed.includes("..\\")) return "path traversal";
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{1,2}|file:)/i.test(trimmed)) return "absolute file path";
  if (/^https?:\/\//i.test(trimmed)) return "embedded network URL";
  return null;
}

function findUnsafeInput(value: unknown, pointer = "inputs"): string | null {
  if (typeof value === "string") {
    const reason = unsafePathReason(value);
    return reason ? `${pointer}: ${reason}` : null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const result = findUnsafeInput(value[index], `${pointer}[${index}]`);
      if (result) return result;
    }
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const result = findUnsafeInput(item, `${pointer}.${key}`);
      if (result) return result;
    }
  }
  return null;
}

function serializedSize(value: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return Number.MAX_SAFE_INTEGER; }
}

export function validateWorkflowStructure(
  workflowApi: Record<string, unknown>,
  constraints: Partial<WorkflowStructureConstraints> = {},
): WorkflowValidationResult {
  const settings = { ...DEFAULT_CONSTRAINTS, ...constraints };
  const errors: string[] = [];
  const warnings: string[] = [];
  const packageSize = serializedSize(workflowApi);
  if (packageSize > settings.maxPackageSizeBytes) {
    errors.push(`Workflow API exceeds ${settings.maxPackageSizeBytes} bytes`);
  }
  let workflow: ReturnType<typeof normalizeComfyWorkflow> = {};
  try {
    workflow = normalizeComfyWorkflow(workflowApi);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const nodeCount = Object.keys(workflow).length;
  const nodeClasses = new Set(Object.values(workflow).map((node) => node.class_type));
  if (nodeCount > settings.maxNodes) errors.push(`Workflow has ${nodeCount} nodes, max is ${settings.maxNodes}`);
  if (nodeClasses.size > settings.maxNodeClasses) errors.push(`Workflow has ${nodeClasses.size} node classes, max is ${settings.maxNodeClasses}`);
  if (!settings.allowedNodeClasses.includes("*")) {
    for (const classType of nodeClasses) {
      if (!settings.allowedNodeClasses.includes(classType)) errors.push(`Node class not allowed: ${classType}`);
    }
  }
  return { valid: errors.length === 0, digest: sha256(workflow), nodeCount, nodeClasses, errors, warnings };
}

export function applyStaticPolicy(
  workflowApi: Record<string, unknown>,
  policy: Partial<WorkflowStaticPolicy> = {},
): WorkflowValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let workflow: ReturnType<typeof normalizeComfyWorkflow> = {};
  try {
    workflow = normalizeComfyWorkflow(workflowApi);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const blocked = new Set([...DEFAULT_BLOCKED_NODE_CLASSES, ...(policy.blockedNodeClasses ?? [])]);
  const nodeClasses = new Set<string>();
  for (const [nodeId, node] of Object.entries(workflow)) {
    nodeClasses.add(node.class_type);
    if (blocked.has(node.class_type)) errors.push(`Blocked node class: ${node.class_type}`);
    if (policy.enforcePathTraversalCheck !== false) {
      const unsafe = findUnsafeInput(node.inputs, `node ${nodeId}.inputs`);
      if (unsafe) errors.push(`Unsafe static workflow input: ${unsafe}`);
    }
  }
  return { valid: errors.length === 0, digest: sha256(workflow), nodeCount: Object.keys(workflow).length, nodeClasses, errors, warnings };
}

export function assertWorkflowPromotionPolicy(workflowApi: Record<string, unknown>): void {
  const structure = validateWorkflowStructure(workflowApi);
  const policy = applyStaticPolicy(workflowApi);
  const errors = [...structure.errors, ...policy.errors];
  const allowlist = (process.env.AI_M_WORKFLOW_NODE_ALLOWLIST ?? "")
    .split(",").map((item) => item.trim()).filter(Boolean);
  const requireAllowlist = process.env.NODE_ENV === "production"
    || process.env.AI_M_REQUIRE_WORKFLOW_NODE_ALLOWLIST === "true";
  if (requireAllowlist && allowlist.length === 0) {
    errors.push("AI_M_WORKFLOW_NODE_ALLOWLIST is required for workflow promotion");
  }
  if (allowlist.length > 0) {
    for (const classType of structure.nodeClasses) {
      if (!allowlist.includes(classType)) errors.push(`Node class is not in the platform allowlist: ${classType}`);
    }
  }
  if (errors.length) throw new Error(`Workflow promotion policy failed: ${errors.join("; ")}`);
}

export function captureEnvironmentFingerprint(): Record<string, unknown> {
  return {
    os: process.platform,
    nodeVersion: process.version,
    architecture: process.arch,
    capturedAtMs: Date.now(),
  };
}

export function compareEnvironmentFingerprints(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): { compatible: boolean; differences: string[] } {
  const ignored = new Set(["capturedAtMs", "timestamp"]);
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const differences = [...keys]
    .filter((key) => !ignored.has(key) && JSON.stringify(expected[key]) !== JSON.stringify(actual[key]))
    .map((key) => `${key}: expected=${JSON.stringify(expected[key])}, actual=${JSON.stringify(actual[key])}`);
  return { compatible: differences.length === 0, differences };
}
