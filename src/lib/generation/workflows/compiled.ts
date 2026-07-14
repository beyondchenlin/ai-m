import type { CompiledBinding, CompiledBindings, CompiledOutput } from "./types";

export class CompiledBindingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompiledBindingsError";
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CompiledBindingsError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, pattern?: RegExp): string {
  if (typeof value !== "string" || !value) throw new CompiledBindingsError(`${name} must be a non-empty string`);
  if (pattern && !pattern.test(value)) throw new CompiledBindingsError(`${name} has an invalid format`);
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new CompiledBindingsError(`${name} must be boolean`);
  return value;
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new CompiledBindingsError(`${name} must be finite`);
  return value;
}

export function parseCompiledBindings(value: unknown): CompiledBindings {
  const root = record(value, "compiledBindings");
  const allowedRoot = new Set([
    "schemaVersion", "compilerVersion", "workflowId", "version", "workflowSha256",
    "authorContractSha256", "bindings", "outputs",
  ]);
  const unknownRoot = Object.keys(root).filter((key) => !allowedRoot.has(key));
  if (unknownRoot.length) throw new CompiledBindingsError(`compiledBindings has unknown field(s): ${unknownRoot.join(", ")}`);
  if (root.schemaVersion !== 1) throw new CompiledBindingsError("compiledBindings.schemaVersion must equal 1");
  if (!Array.isArray(root.bindings) || !Array.isArray(root.outputs)) throw new CompiledBindingsError("compiled bindings and outputs must be arrays");
  if (root.bindings.length > 200 || root.outputs.length < 1 || root.outputs.length > 64) {
    throw new CompiledBindingsError("compiled binding/output count is invalid");
  }

  const bindingKeys = new Set<string>();
  const bindings: CompiledBinding[] = root.bindings.map((item, index) => {
    const entry = record(item, `bindings[${index}]`);
    const allowed = new Set(["key", "inputName", "valueType", "source", "required", "userOverride", "default", "minimum", "maximum", "nodeId", "classType"]);
    const unknown = Object.keys(entry).filter((key) => !allowed.has(key));
    if (unknown.length) throw new CompiledBindingsError(`bindings[${index}] has unknown field(s): ${unknown.join(", ")}`);
    const key = text(entry.key, `bindings[${index}].key`, /^[A-Za-z][A-Za-z0-9_.-]*$/);
    if (bindingKeys.has(key)) throw new CompiledBindingsError(`duplicate compiled binding key: ${key}`);
    bindingKeys.add(key);
    const valueType = text(entry.valueType, `bindings[${index}].valueType`) as CompiledBinding["valueType"];
    if (!["string", "integer", "number", "boolean", "image", "audio", "json"].includes(valueType)) throw new CompiledBindingsError(`unsupported compiled binding type: ${valueType}`);
    const source = text(entry.source ?? "request", `bindings[${index}].source`) as CompiledBinding["source"];
    if (!["request", "reference-image", "voice-reference"].includes(source)) throw new CompiledBindingsError(`unsupported compiled binding source: ${source}`);
    const minimum = optionalNumber(entry.minimum, `bindings[${index}].minimum`);
    const maximum = optionalNumber(entry.maximum, `bindings[${index}].maximum`);
    if (minimum !== undefined && maximum !== undefined && maximum < minimum) throw new CompiledBindingsError(`bindings[${index}] maximum is below minimum`);
    return {
      key,
      inputName: text(entry.inputName, `bindings[${index}].inputName`),
      valueType,
      source,
      required: boolean(entry.required, `bindings[${index}].required`),
      userOverride: boolean(entry.userOverride, `bindings[${index}].userOverride`),
      ...(entry.default !== undefined ? { default: structuredClone(entry.default) } : {}),
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {}),
      nodeId: text(entry.nodeId, `bindings[${index}].nodeId`, /^\d+$/),
      classType: text(entry.classType, `bindings[${index}].classType`),
    };
  });

  const outputKeys = new Set<string>();
  const outputs: CompiledOutput[] = root.outputs.map((item, index) => {
    const entry = record(item, `outputs[${index}]`);
    const allowed = new Set(["key", "field", "mediaKind", "maxItems", "nodeId", "classType"]);
    const unknown = Object.keys(entry).filter((key) => !allowed.has(key));
    if (unknown.length) throw new CompiledBindingsError(`outputs[${index}] has unknown field(s): ${unknown.join(", ")}`);
    const key = text(entry.key, `outputs[${index}].key`);
    if (outputKeys.has(key)) throw new CompiledBindingsError(`duplicate compiled output key: ${key}`);
    outputKeys.add(key);
    const maxItems = entry.maxItems;
    if (!Number.isSafeInteger(maxItems) || (maxItems as number) < 1 || (maxItems as number) > 64) throw new CompiledBindingsError(`outputs[${index}].maxItems is invalid`);
    const mediaKind = text(entry.mediaKind, `outputs[${index}].mediaKind`) as CompiledOutput["mediaKind"];
    if (!["image", "video", "audio"].includes(mediaKind)) throw new CompiledBindingsError(`outputs[${index}].mediaKind is invalid`);
    return {
      key,
      field: text(entry.field, `outputs[${index}].field`),
      mediaKind,
      maxItems: maxItems as number,
      nodeId: text(entry.nodeId, `outputs[${index}].nodeId`, /^\d+$/),
      classType: text(entry.classType, `outputs[${index}].classType`),
    };
  });

  return {
    schemaVersion: 1,
    compilerVersion: text(root.compilerVersion, "compiledBindings.compilerVersion"),
    workflowId: text(root.workflowId, "compiledBindings.workflowId"),
    version: text(root.version, "compiledBindings.version"),
    workflowSha256: text(root.workflowSha256, "compiledBindings.workflowSha256", /^sha256:[a-f0-9]{64}$/i),
    authorContractSha256: text(root.authorContractSha256, "compiledBindings.authorContractSha256", /^sha256:[a-f0-9]{64}$/i),
    bindings,
    outputs,
  };
}
