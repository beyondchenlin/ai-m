export {
  ComfyUIHttpTransport,
  submitPrompt,
  probeSystemInfo,
  probeObjectInfo,
  probeModelFolder,
  probeQueueStatus,
  probeHistory,
  classifyComfyHistory,
  createComfyUITransport,
} from "./comfyui";
export type {
  ComfyUITransport,
  ComfyPromptRequest,
  ComfyPromptResponse,
  ComfyProgress,
  ComfyExecutionResult,
  ComfyHistoryOutcome,
  ComfySystemInfo,
  ComfyObjectInfo,
  ComfyWSMessage,
} from "./comfyui";

export {
  probeBackendFeatures,
  isProbeFresh,
  checkEnvironmentDrift,
} from "./comfyui-behavior-probe";
export type {
  BackendFeatureSnapshot,
  ExternalIdStrategy,
  CancellationCapabilities,
  OutputCapabilities,
  ProbeConfig,
} from "./comfyui-behavior-probe";

export {
  ComfyUIConnectionManager,
  connectionManagerRegistry,
} from "./comfyui-connection-manager";
export type {
  ConnectionState,
  ProgressSnapshot,
  ConnectionEventListener,
  ConnectionEvent,
  TaskEventHandler,
  ReconnectConfig,
} from "./comfyui-connection-manager";

export {
  safeCancelJob,
  resolveCancelCompletionRace,
  classifyCancellationError,
} from "./comfyui-cancellation";
export type {
  CancellationResult,
  CancellationPolicyConfig,
} from "./comfyui-cancellation";

export {
  reconcileSubmission,
  shouldEscalateToAttention,
  nextReconciliationDelay,
  classifySubmissionError,
} from "./comfyui-reconciliation";
export type {
  EvidenceStrength,
  ReconciliationResult,
  ReconciliationEvidence,
  ReconciliationConfig,
} from "./comfyui-reconciliation";

export { ComfyUIExecutionOrchestrator, ExecutionCallbackPersistenceError } from "./comfyui-execution-orchestrator";
export type {
  OrchestratorPhase,
  ExecutionCallbacks,
  ExternalTerminationEvidence,
  ExecutionConfig,
  OrchestratorResult,
} from "./comfyui-execution-orchestrator";
