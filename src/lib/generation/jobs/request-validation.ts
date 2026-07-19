import type { CompiledBinding, CompiledBindings } from "@/lib/generation/workflows";
import { canonicalize } from "@/lib/generation/workflows";

const MAX_NORMALIZED_BYTES = 256 * 1024;
const MAX_STRING_CHARS = 100_000;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_COLLECTION_ITEMS = 1_000;

export class GenerationRequestValidationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
    readonly code: string,
  ) {
    super(message);
    this.name = "GenerationRequestValidationError";
  }
}

function semanticError(message: string, code: string): never {
  throw new GenerationRequestValidationError(message, 400, code);
}

function limitError(message: string, code: string): never {
  throw new GenerationRequestValidationError(message, 413, code);
}

function assertJsonLimits(value: unknown, depth = 0): void {
  if (depth > MAX_JSON_DEPTH) {
    limitError("Workflow input exceeds the nesting limit", "workflow_input_too_deep");
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > MAX_STRING_CHARS) {
      limitError("Workflow input string is too large", "workflow_input_string_too_large");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) semanticError("Workflow input numbers must be finite", "workflow_input_number_invalid");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_COLLECTION_ITEMS) {
      limitError("Workflow input collection is too large", "workflow_input_collection_too_large");
    }
    for (const item of value) assertJsonLimits(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") {
    semanticError("Workflow input must contain only JSON values", "workflow_input_type_invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    semanticError("Workflow input must contain only plain JSON objects", "workflow_input_type_invalid");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_JSON_COLLECTION_ITEMS) {
    limitError("Workflow input collection is too large", "workflow_input_collection_too_large");
  }
  for (const [, item] of entries) assertJsonLimits(item, depth + 1);
}

function normalizeValue(value: unknown, binding: CompiledBinding): unknown {
  if (binding.valueType === "string" || binding.valueType === "image" || binding.valueType === "audio") {
    if (typeof value !== "string") {
      semanticError(`${binding.key} must be a string`, "workflow_input_type_invalid");
    }
    if (value.length > MAX_STRING_CHARS) {
      limitError(`${binding.key} is too large`, "workflow_input_string_too_large");
    }
    return value;
  }
  if (binding.valueType === "boolean") {
    if (typeof value !== "boolean") {
      semanticError(`${binding.key} must be boolean`, "workflow_input_type_invalid");
    }
    return value;
  }
  if (binding.valueType === "integer" || binding.valueType === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)
      || (binding.valueType === "integer" && !Number.isSafeInteger(value))) {
      semanticError(`${binding.key} must be a finite ${binding.valueType}`, "workflow_input_number_invalid");
    }
    if (binding.minimum !== undefined && value < binding.minimum) {
      semanticError(`${binding.key} is below its minimum`, "workflow_input_out_of_range");
    }
    if (binding.maximum !== undefined && value > binding.maximum) {
      semanticError(`${binding.key} exceeds its maximum`, "workflow_input_out_of_range");
    }
    if (binding.step !== undefined) {
      const steps = (value - (binding.minimum ?? 0)) / binding.step;
      const tolerance = Number.EPSILON * 16 * Math.max(1, Math.abs(steps));
      if (Math.abs(steps - Math.round(steps)) > tolerance) {
        semanticError(`${binding.key} does not align to its step`, "workflow_input_out_of_range");
      }
    }
    return value;
  }
  assertJsonLimits(value);
  return structuredClone(value);
}

function plainRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    semanticError(`${name} must be an object`, "workflow_input_type_invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    semanticError(`${name} must be a plain object`, "workflow_input_type_invalid");
  }
  return value as Record<string, unknown>;
}

/**
 * Produces the exact typed request snapshot that is hashed, persisted and later
 * bound. Materialized image/audio sources are deliberately excluded.
 */
export function normalizeCompiledWorkflowRequest(
  compiled: CompiledBindings,
  requestValue: unknown,
  defaultValue: unknown = {},
): Record<string, unknown> {
  const request = plainRecord(requestValue, "request");
  const defaults = plainRecord(defaultValue, "defaultParameters");
  const requestBindings = compiled.bindings.filter((binding) => (binding.source ?? "request") === "request");
  const byKey = new Map(requestBindings.map((binding) => [binding.key, binding]));
  const allBindingKeys = new Set(compiled.bindings.map((binding) => binding.key));

  const unknownRequest = Object.keys(request).filter((key) => !byKey.has(key));
  if (unknownRequest.length) {
    semanticError(
      `Unknown or non-request workflow input(s): ${unknownRequest.sort().join(", ")}`,
      "workflow_input_unknown",
    );
  }
  const unknownDefaults = Object.keys(defaults).filter((key) => !allBindingKeys.has(key));
  if (unknownDefaults.length) {
    semanticError(
      `Unknown workflow default(s): ${unknownDefaults.sort().join(", ")}`,
      "workflow_default_unknown",
    );
  }

  const normalized: Record<string, unknown> = {};
  for (const binding of requestBindings) {
    const supplied = Object.prototype.hasOwnProperty.call(request, binding.key);
    if (supplied && !binding.userOverride) {
      semanticError(`${binding.key} cannot be overridden`, "workflow_input_override_forbidden");
    }
    const value = supplied
      ? request[binding.key]
      : Object.prototype.hasOwnProperty.call(defaults, binding.key)
        ? defaults[binding.key]
        : binding.default;
    if (value === undefined) {
      if (binding.required) {
        semanticError(`Missing required workflow input: ${binding.key}`, "workflow_input_required");
      }
      continue;
    }
    normalized[binding.key] = normalizeValue(value, binding);
  }

  assertJsonLimits(normalized);
  let canonical: string;
  try {
    canonical = canonicalize(normalized);
  } catch {
    semanticError("Workflow input must be canonical JSON", "workflow_input_type_invalid");
  }
  if (Buffer.byteLength(canonical, "utf8") > MAX_NORMALIZED_BYTES) {
    limitError("Normalized workflow input is too large", "workflow_input_too_large");
  }
  return normalized;
}
