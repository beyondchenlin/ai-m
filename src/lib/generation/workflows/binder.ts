import { sha256Canonical } from "./canonical";
import type { BindingValueType, ComfyWorkflow, CompiledBinding, CompiledBindings } from "./types";

export class WorkflowBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowBindingError";
  }
}

function coerce(value: unknown, binding: CompiledBinding): unknown {
  const type: BindingValueType = binding.valueType;
  if (type === "string" || type === "image" || type === "audio") {
    if (typeof value !== "string") throw new WorkflowBindingError(`${binding.key} must be a string`);
    return value;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") throw new WorkflowBindingError(`${binding.key} must be boolean`);
    return value;
  }
  if (type === "integer" || type === "number") {
    const numberValue = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numberValue) || (type === "integer" && !Number.isInteger(numberValue))) {
      throw new WorkflowBindingError(`${binding.key} must be ${type}`);
    }
    if (binding.minimum !== undefined && numberValue < binding.minimum) throw new WorkflowBindingError(`${binding.key} is below minimum ${binding.minimum}`);
    if (binding.maximum !== undefined && numberValue > binding.maximum) throw new WorkflowBindingError(`${binding.key} exceeds maximum ${binding.maximum}`);
    if (binding.step !== undefined) {
      const steps = (numberValue - (binding.minimum ?? 0)) / binding.step;
      const tolerance = Number.EPSILON * 16 * Math.max(1, Math.abs(steps));
      if (Math.abs(steps - Math.round(steps)) > tolerance) {
        throw new WorkflowBindingError(`${binding.key} must align to step ${binding.step}`);
      }
    }
    return numberValue;
  }
  return structuredClone(value);
}

export function bindWorkflow(
  workflow: ComfyWorkflow,
  compiled: CompiledBindings,
  parameters: Record<string, unknown>,
  systemOutputPrefix: string,
): ComfyWorkflow {
  if (compiled.workflowSha256 !== sha256Canonical(workflow)) throw new WorkflowBindingError("Compiled bindings do not match workflow content");
  const result = structuredClone(workflow);
  const allowed = new Set(compiled.bindings.map((binding) => binding.key));
  const unknown = Object.keys(parameters).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new WorkflowBindingError(`Unknown workflow parameter(s): ${unknown.join(", ")}`);

  for (const binding of compiled.bindings) {
    const raw = parameters[binding.key] ?? binding.default;
    if (raw === undefined) {
      if (binding.required) throw new WorkflowBindingError(`Missing required parameter: ${binding.key}`);
      continue;
    }
    const node = result[binding.nodeId];
    if (!node || node.class_type !== binding.classType) throw new WorkflowBindingError(`Binding target drift detected for ${binding.key}`);
    node.inputs[binding.inputName] = coerce(raw, binding);
  }

  for (const output of compiled.outputs) {
    const node = result[output.nodeId];
    if (!node || node.class_type !== output.classType) throw new WorkflowBindingError(`Output target drift detected for ${output.key}`);
    if (typeof node.inputs.filename_prefix === "string") node.inputs.filename_prefix = systemOutputPrefix;
  }
  return result;
}
