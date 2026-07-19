import type { ComfyObjectInfo } from "./comfyui";

function normalizeRuntimeChoice(value: string): string {
  return value.replace(/\\/g, "/");
}

function choiceValues(definition: unknown): string[] | null {
  if (!Array.isArray(definition) || !Array.isArray(definition[0])) return null;
  return definition[0].filter((value): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0"));
}

/**
 * Adapt path-like widget values to the exact spelling exposed by this runtime.
 * The immutable package is never mutated, and ambiguous normalized choices fail closed.
 */
export function adaptComfyWorkflowRuntimeChoices(
  workflow: Record<string, unknown>,
  objectInfo: ComfyObjectInfo,
  dynamicInputTargets: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const adapted = structuredClone(workflow);
  for (const [nodeId, rawNode] of Object.entries(adapted)) {
    if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) continue;
    const node = rawNode as Record<string, unknown>;
    if (typeof node.class_type !== "string") continue;
    const inputs = node.inputs;
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) continue;
    const runtimeNode = objectInfo[node.class_type];
    if (!runtimeNode) continue;
    const definitions = {
      ...(runtimeNode.input.required ?? {}),
      ...(runtimeNode.input.optional ?? {}),
    };
    for (const [inputName, currentValue] of Object.entries(inputs)) {
      if (typeof currentValue !== "string") continue;
      // Uploaded media is created after object_info was captured, so the old
      // runtime enum cannot authoritatively list the new system-generated name.
      if (dynamicInputTargets.has(`${nodeId}:${inputName}`)) continue;
      const candidates = choiceValues(definitions[inputName]);
      // Text widgets use scalar definitions such as ["STRING", {...}] and remain untouched.
      // An array definition is an enum supplied by the runtime, so a missing choice must fail
      // before submission instead of relying on a backend-specific fallback.
      if (candidates === null) continue;
      const normalized = normalizeRuntimeChoice(currentValue);
      const matches = candidates.filter((candidate) => normalizeRuntimeChoice(candidate) === normalized);
      if (matches.length > 1) {
        throw new Error(`ComfyUI runtime choice is ambiguous for ${node.class_type}.${inputName}`);
      }
      if (matches.length === 0) {
        throw new Error(`ComfyUI runtime choice is unavailable for ${node.class_type}.${inputName}`);
      }
      (inputs as Record<string, unknown>)[inputName] = matches[0];
    }
  }
  return adapted;
}
