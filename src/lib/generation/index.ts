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
  submitPrompt,
  probeSystemInfo,
  probeObjectInfo,
  probeModelFolder,
  probeQueueStatus,
  probeHistory,
  classifyComfyHistory,
  createComfyUITransport,
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
export { materializeWorkflowInputs } from "./input-materializer";
export type { MaterializedWorkflowInput } from "./input-materializer";
