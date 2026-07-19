/**
 * v2.0 generation 模块入口
 */

export * from "./naming";
export * from "./contracts";
export {
  getEnabledProfiles,
  getProfileDetail,
  getDefaultProfile,
  resolveBackendForProfile,
} from "./profiles";
export type { GenerationProfileSummary, GenerationProfileDetail } from "./profiles";
export {
  createGenerationJob,
  getGenerationJob,
  cancelGenerationJob,
  retryGenerationJob,
  listGenerationJobs,
} from "./jobs";
export { LegacyAIProviderFacade, LegacyVideoProviderFacade } from "./adapters/legacy-facade";
export {
  LEASE_CONFIG,
  acquireResourceSlot,
  renewResourceSlot,
  releaseResourceSlot,
  recordResourceTerminationProof,
  claimJob,
  renewJobClaim,
  releaseJobClaim,
  scanExpiredClaims,
} from "./resources";
export type { ResourceTerminationProofInput } from "./resources";
export {
  validateWorkflowStructure,
  applyStaticPolicy,
  assertWorkflowPromotionPolicy,
  captureEnvironmentFingerprint,
  compareEnvironmentFingerprints,
} from "./workflows";
export type {
  WorkflowStructureConstraints,
  WorkflowStaticPolicy,
  WorkflowValidationResult,
} from "./workflows";
export {
  ComfyUIHttpTransport,
  ComfyUIOperationError,
  ComfyUIOperationDeadlineError,
  parseComfyUIOperationTimeouts,
  submitPrompt,
  probeSystemInfo,
  probeObjectInfo,
  probeModelFolder,
  probeQueueStatus,
  probeHistory,
  classifyComfyHistory,
  createComfyUITransport,
  probeBackendEnvironment,
  probeBackendFeatures,
  isProbeFresh,
  checkEnvironmentDrift,
  ComfyUIConnectionManager,
  connectionManagerRegistry,
  safeCancelJob,
  resolveCancelCompletionRace,
  classifyCancellationError,
  reconcileSubmission,
  shouldEscalateToAttention,
  nextReconciliationDelay,
  classifySubmissionError,
  ComfyUIExecutionOrchestrator,
  ExecutionCallbackPersistenceError,
  adaptComfyWorkflowRuntimeChoices,
} from "./transports";
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
  ComfyUIOperationOptions,
  ComfyUISubmissionDisposition,
  BackendEnvironmentProbe,
  BackendFeatureSnapshot,
  ExternalIdStrategy,
  CancellationCapabilities,
  OutputCapabilities,
  ProbeConfig,
  ConnectionState,
  ProgressSnapshot,
  ConnectionEventListener,
  ConnectionEvent,
  TaskEventHandler,
  ReconnectConfig,
  CancellationResult,
  CancellationPolicyConfig,
  EvidenceStrength,
  ReconciliationResult,
  ReconciliationEvidence,
  ReconciliationConfig,
  OrchestratorPhase,
  ExecutionCallbacks,
  ExternalTerminationEvidence,
  ExecutionConfig,
  OrchestratorResult,
} from "./transports";
export {
  streamCommitArtifact,
  commitArtifactFromBuffer,
  validateMagicBytes,
  checkArtifactAccess,
  cleanupStagingDir,
  recoverStagingArtifacts,
  isArtifactStorageKeySafe,
  ContentType,
  ContenType,
} from "./archiving";
export type { ArtifactStreamInput, ArtifactCommitResult } from "./archiving";
export { InputMaterializationError, materializeWorkflowInputs } from "./input-materializer";
export type { MaterializedWorkflowInput } from "./input-materializer";
export {
  ManagedComfyUIRuntime,
  ManagedComfyUIEndpointRegistry,
  ManagedCommandStdioDrainError,
  ManagedProcessCleanupError,
  createPowerShellCommandRunner,
  parseManagedComfyUIRuntimeConfig,
} from "./runtime/managed-comfyui-runtime";
export type {
  ManagedCommandRequest,
  ManagedCommandResult,
  ManagedCommandRunner,
  ManagedComfyUIEndpointState,
  ManagedProbeTransport,
  ManagedRuntimeConfig,
  ManagedRuntimeDependencies,
  PowerShellCommandRunnerOptions,
} from "./runtime/managed-comfyui-runtime";
