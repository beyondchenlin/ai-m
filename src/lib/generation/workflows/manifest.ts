import type { AuthorBinding, AuthorOutput, WorkflowManifest, WorkflowSelector } from "./types";

export class WorkflowManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowManifestError";
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkflowManifestError(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new WorkflowManifestError(`${name} has unknown field(s): ${unknown.join(", ")}`);
}
function string(value: unknown, name: string, pattern?: RegExp): string {
  if (typeof value !== "string" || !value.trim()) throw new WorkflowManifestError(`${name} must be a non-empty string`);
  const result = value.trim();
  if (pattern && !pattern.test(result)) throw new WorkflowManifestError(`${name} has an invalid format`);
  return result;
}
function number(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new WorkflowManifestError(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}
function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const result = number(value, name, min, max);
  if (!Number.isSafeInteger(result)) throw new WorkflowManifestError(`${name} must be a safe integer`);
  return result;
}
function assertDefaultValue(value: unknown, type: AuthorBinding["valueType"], name: string): void {
  if (type === "string") {
    if (typeof value !== "string" || value.length > 200_000) throw new WorkflowManifestError(`${name} must be a bounded string`);
    return;
  }
  if (type === "integer" || type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || (type === "integer" && !Number.isSafeInteger(value))) {
      throw new WorkflowManifestError(`${name} must be ${type}`);
    }
    return;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") throw new WorkflowManifestError(`${name} must be boolean`);
    return;
  }
  if (type === "image" || type === "audio") {
    throw new WorkflowManifestError(`${name} cannot provide a default for controlled media input`);
  }
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw new WorkflowManifestError(`${name} must be JSON serializable`); }
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > 64 * 1024) {
    throw new WorkflowManifestError(`${name} exceeds the JSON default limit`);
  }
}

function selector(value: unknown, name: string): WorkflowSelector {
  const data = object(value, name);
  keys(data, ["nodeId", "classType", "metaTitle"], name);
  const classType = string(data.classType, `${name}.classType`);
  const nodeId = data.nodeId === undefined ? undefined : string(data.nodeId, `${name}.nodeId`, /^\d+$/);
  const metaTitle = data.metaTitle === undefined ? undefined : string(data.metaTitle, `${name}.metaTitle`);
  if (Boolean(nodeId) === Boolean(metaTitle)) throw new WorkflowManifestError(`${name} requires exactly one of nodeId or metaTitle`);
  return {
    classType,
    ...(nodeId !== undefined ? { nodeId } : {}),
    ...(metaTitle !== undefined ? { metaTitle } : {}),
  };
}

export function parseWorkflowManifest(value: unknown): WorkflowManifest {
  const data = object(value, "manifest");
  keys(data, ["schemaVersion", "workflowId", "version", "displayName", "capability", "workflowFile", "bindings", "outputs", "requirements", "limits"], "manifest");
  if (data.schemaVersion !== 1) throw new WorkflowManifestError("manifest.schemaVersion must equal 1");
  const capability = string(data.capability, "manifest.capability") as WorkflowManifest["capability"];
  if (!["image", "video", "speech", "utility"].includes(capability)) throw new WorkflowManifestError("manifest.capability is unsupported");
  if (!Array.isArray(data.bindings) || !Array.isArray(data.outputs)) throw new WorkflowManifestError("manifest bindings and outputs must be arrays");
  if (data.bindings.length > 200) throw new WorkflowManifestError("manifest has too many bindings");
  if (data.outputs.length < 1 || data.outputs.length > 64) throw new WorkflowManifestError("manifest outputs must contain between 1 and 64 entries");
  const bindingKeys = new Set<string>();
  const bindings: AuthorBinding[] = data.bindings.map((item, index) => {
    const binding = object(item, `bindings[${index}]`);
    keys(binding, ["key", "selector", "inputName", "valueType", "source", "required", "userOverride", "default", "minimum", "maximum", "step"], `bindings[${index}]`);
    const key = string(binding.key, `bindings[${index}].key`, /^[A-Za-z][A-Za-z0-9_.-]*$/);
    if (bindingKeys.has(key)) throw new WorkflowManifestError(`Duplicate binding key: ${key}`);
    bindingKeys.add(key);
    const valueType = string(binding.valueType, `bindings[${index}].valueType`) as AuthorBinding["valueType"];
    if (!["string", "integer", "number", "boolean", "image", "audio", "json"].includes(valueType)) throw new WorkflowManifestError(`Unsupported binding type: ${valueType}`);
    if (typeof binding.required !== "boolean" || typeof binding.userOverride !== "boolean") throw new WorkflowManifestError(`bindings[${index}] required/userOverride must be boolean`);
    const source = binding.source === undefined ? "request" : string(binding.source, `bindings[${index}].source`) as AuthorBinding["source"];
    if (!["request", "reference-image", "voice-reference"].includes(source)) throw new WorkflowManifestError(`bindings[${index}].source is unsupported`);
    if (source === "request" && (valueType === "image" || valueType === "audio")) {
      throw new WorkflowManifestError(`bindings[${index}] media values must use a controlled reference source`);
    }
    if (source === "reference-image" && !["image", "json"].includes(valueType)) throw new WorkflowManifestError(`bindings[${index}] reference-image source requires image or json valueType`);
    if (source === "voice-reference" && valueType !== "audio") throw new WorkflowManifestError(`bindings[${index}] voice-reference source requires audio valueType`);
    if (source !== "request" && binding.userOverride) throw new WorkflowManifestError(`bindings[${index}] controlled media bindings cannot be user-overridden`);
    if (binding.default !== undefined) assertDefaultValue(binding.default, valueType, `bindings[${index}].default`);
    const minimum = binding.minimum === undefined ? undefined : number(binding.minimum, `bindings[${index}].minimum`, -Number.MAX_SAFE_INTEGER);
    const maximum = binding.maximum === undefined ? undefined : number(binding.maximum, `bindings[${index}].maximum`, -Number.MAX_SAFE_INTEGER);
    const step = binding.step === undefined ? undefined : number(binding.step, `bindings[${index}].step`, Number.MIN_VALUE);
    if (minimum !== undefined && maximum !== undefined && maximum < minimum) {
      throw new WorkflowManifestError(`bindings[${index}].maximum must be >= minimum`);
    }
    if ((minimum !== undefined || maximum !== undefined || step !== undefined) && !["integer", "number"].includes(valueType)) {
      throw new WorkflowManifestError(`bindings[${index}] numeric limits require integer or number valueType`);
    }
    return {
      key,
      source,
      selector: selector(binding.selector, `bindings[${index}].selector`),
      inputName: string(binding.inputName, `bindings[${index}].inputName`),
      valueType,
      required: binding.required,
      userOverride: binding.userOverride,
      ...(binding.default !== undefined ? { default: binding.default } : {}),
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {}),
      ...(step !== undefined ? { step } : {}),
    };
  });
  const outputKeys = new Set<string>();
  const outputs: AuthorOutput[] = data.outputs.map((item, index) => {
    const output = object(item, `outputs[${index}]`);
    keys(output, ["key", "selector", "field", "mediaKind", "maxItems"], `outputs[${index}]`);
    const key = string(output.key, `outputs[${index}].key`, /^[A-Za-z][A-Za-z0-9_.-]*$/);
    if (outputKeys.has(key)) throw new WorkflowManifestError(`Duplicate output key: ${key}`);
    outputKeys.add(key);
    const mediaKind = string(output.mediaKind, `outputs[${index}].mediaKind`) as AuthorOutput["mediaKind"];
    if (!["image", "video", "audio"].includes(mediaKind)) throw new WorkflowManifestError(`Unsupported media kind: ${mediaKind}`);
    return { key, selector: selector(output.selector, `outputs[${index}].selector`), field: string(output.field, `outputs[${index}].field`, /^[A-Za-z][A-Za-z0-9_.-]*$/), mediaKind, maxItems: integer(output.maxItems, `outputs[${index}].maxItems`, 1, 64) };
  });
  const requirements = object(data.requirements, "requirements");
  keys(requirements, ["nodeClasses", "models", "referenceModes"], "requirements");
  if (!Array.isArray(requirements.nodeClasses) || !requirements.nodeClasses.every((item) => typeof item === "string" && item.trim().length > 0)) throw new WorkflowManifestError("requirements.nodeClasses must be non-empty string[]");
  if (requirements.nodeClasses.length > 512) throw new WorkflowManifestError("requirements.nodeClasses is too large");
  if ((requirements.nodeClasses as string[]).some((item) => item.length > 200)) throw new WorkflowManifestError("requirements.nodeClasses contains an oversized class name");
  if (!Array.isArray(requirements.models)) throw new WorkflowManifestError("requirements.models must be an array");
  if (requirements.models.length > 256) throw new WorkflowManifestError("requirements.models is too large");
  const models = requirements.models.map((item, index) => {
    const model = object(item, `requirements.models[${index}]`);
    keys(model, ["folder", "runtimeFolder", "runtimeVisible", "filename", "sizeBytes", "sha256"], `requirements.models[${index}]`);
    const digest = model.sha256 === undefined ? undefined : string(model.sha256, `requirements.models[${index}].sha256`, /^[0-9a-f]{64}$/i);
    const sizeBytes = model.sizeBytes === undefined
      ? undefined
      : integer(model.sizeBytes, `requirements.models[${index}].sizeBytes`, 1);
    const folder = string(model.folder, `requirements.models[${index}].folder`, /^[A-Za-z0-9._-]+$/);
    const runtimeFolder = model.runtimeFolder === undefined
      ? undefined
      : string(model.runtimeFolder, `requirements.models[${index}].runtimeFolder`, /^[A-Za-z0-9._-]+$/);
    if (model.runtimeVisible !== undefined && typeof model.runtimeVisible !== "boolean") {
      throw new WorkflowManifestError(`requirements.models[${index}].runtimeVisible must be boolean`);
    }
    const filename = string(model.filename, `requirements.models[${index}].filename`, /^[A-Za-z0-9._/\\ -]+$/).replace(/\\/g, "/");
    const filenameParts = filename.split("/");
    if (filename.length > 1024 || filenameParts.some((part) => !part || part === "." || part === ".." || part.length > 255)) {
      throw new WorkflowManifestError(`requirements.models[${index}].filename is unsafe`);
    }
    return {
      folder,
      ...(runtimeFolder !== undefined ? { runtimeFolder } : {}),
      ...(model.runtimeVisible !== undefined ? { runtimeVisible: model.runtimeVisible } : {}),
      filename,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(digest ? { sha256: digest.toLowerCase() } : {}),
    };
  });
  const requiredNodeClasses = new Set((requirements.nodeClasses as string[]).map((item) => item.trim()));
  for (const [index, model] of models.entries()) {
    if (model.runtimeVisible !== false) continue;
    const authorizedAuxiliary =
      capability === "speech"
      && model.runtimeFolder === undefined
      && (
        (model.folder === "IndexTTS-2" && requiredNodeClasses.has("IndexTTS2BaseNode"))
        || (model.folder === "omnivoice"
          && (requiredNodeClasses.has("OmniVoiceLongformTTS") || requiredNodeClasses.has("OmniVoiceVoiceCloneTTS")))
        || (model.folder === "audio_encoders" && requiredNodeClasses.has("OmniVoiceWhisperLoader"))
      );
    if (!authorizedAuxiliary) {
      throw new WorkflowManifestError(
        `requirements.models[${index}].runtimeVisible=false is not an authorized speech auxiliary file`,
      );
    }
  }
  if (!Array.isArray(requirements.referenceModes) || !requirements.referenceModes.every((item) => ["off", "auto", "required"].includes(String(item)))) throw new WorkflowManifestError("requirements.referenceModes is invalid");
  const limits = object(data.limits, "limits");
  keys(limits, ["maxPromptChars", "maxPixels", "maxBatch", "maxReferenceInputs", "maxOutputs", "maxJobMs", "maxOutputBytes"], "limits");
  return {
    schemaVersion: 1,
    workflowId: string(data.workflowId, "manifest.workflowId", /^[a-z0-9][a-z0-9._-]*$/),
    version: string(data.version, "manifest.version", /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),
    displayName: string(data.displayName, "manifest.displayName"),
    capability,
    workflowFile: string(data.workflowFile, "manifest.workflowFile", /^[A-Za-z0-9._-]+\.json$/),
    bindings,
    outputs,
    requirements: { nodeClasses: [...new Set((requirements.nodeClasses as string[]).map((item) => item.trim()))], models, referenceModes: requirements.referenceModes as WorkflowManifest["requirements"]["referenceModes"] },
    limits: {
      maxPromptChars: integer(limits.maxPromptChars, "limits.maxPromptChars", 1, 200_000),
      maxPixels: integer(limits.maxPixels, "limits.maxPixels", 1, 268_435_456),
      maxBatch: integer(limits.maxBatch, "limits.maxBatch", 1, 64),
      ...(limits.maxReferenceInputs === undefined
        ? {}
        : { maxReferenceInputs: integer(limits.maxReferenceInputs, "limits.maxReferenceInputs", 1, 64) }),
      maxOutputs: integer(limits.maxOutputs, "limits.maxOutputs", 1, 64),
      maxJobMs: integer(limits.maxJobMs, "limits.maxJobMs", 1000, 24 * 60 * 60 * 1000),
      maxOutputBytes: integer(limits.maxOutputBytes, "limits.maxOutputBytes", 1, 10 * 1024 * 1024 * 1024),
    },
  };
}
