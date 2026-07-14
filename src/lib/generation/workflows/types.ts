export type WorkflowCapability = "image" | "video" | "speech" | "utility";
export type BindingValueType = "string" | "integer" | "number" | "boolean" | "image" | "audio" | "json";
export type MediaKind = "image" | "video" | "audio";

export interface ComfyWorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

export type ComfyWorkflow = Record<string, ComfyWorkflowNode>;

export interface WorkflowSelector {
  nodeId?: string;
  classType: string;
  metaTitle?: string;
}

export interface AuthorBinding {
  key: string;
  selector: WorkflowSelector;
  inputName: string;
  valueType: BindingValueType;
  /** Explicit source prevents business metadata from being guessed by key name. */
  source: "request" | "reference-image" | "voice-reference";
  required: boolean;
  userOverride: boolean;
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

export interface AuthorOutput {
  key: string;
  selector: WorkflowSelector;
  field: string;
  mediaKind: MediaKind;
  maxItems: number;
}

export interface WorkflowManifest {
  schemaVersion: 1;
  workflowId: string;
  version: string;
  displayName: string;
  capability: WorkflowCapability;
  workflowFile: string;
  bindings: AuthorBinding[];
  outputs: AuthorOutput[];
  requirements: {
    nodeClasses: string[];
    models: Array<{ folder: string; filename: string; sha256?: string }>;
    referenceModes: Array<"off" | "auto" | "required">;
  };
  limits: {
    maxPromptChars: number;
    maxPixels: number;
    maxBatch: number;
    maxOutputs: number;
    maxJobMs: number;
    maxOutputBytes: number;
  };
}

export interface CompiledBinding extends Omit<AuthorBinding, "selector"> {
  nodeId: string;
  classType: string;
}

export interface CompiledOutput extends Omit<AuthorOutput, "selector"> {
  nodeId: string;
  classType: string;
}

export interface CompiledBindings {
  schemaVersion: 1;
  compilerVersion: string;
  workflowId: string;
  version: string;
  workflowSha256: string;
  authorContractSha256: string;
  bindings: CompiledBinding[];
  outputs: CompiledOutput[];
}

export interface WorkflowPackageInput {
  workflowApi: unknown;
  manifest: unknown;
  packageLock: unknown;
  /** SHA-256 of the exact bytes listed by package.lock.json. */
  verifiedFileDigests: Record<string, string>;
  packagePath: string;
}
