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
} from "./jobs";
export { LegacyAIProviderFacade, LegacyVideoProviderFacade } from "./adapters/legacy-facade";
export {
  ZImageAdapter,
  createZImageAdapter,
  buildZImageWorkflow,
} from "./adapters/zimage";
export type { QualityWorkflow, ZImageBuildInput } from "./adapters/zimage";
export {
  LocalSpeechAdapter,
  createLocalSpeechAdapter,
  buildSpeechWorkflow,
} from "./adapters/local-speech";
export type { VoiceProfile } from "./adapters/local-speech";
export {
  LEASE_CONFIG,
  acquireResourceSlot,
  renewResourceSlot,
  releaseResourceSlot,
  claimJob,
  renewJobClaim,
  releaseJobClaim,
  scanExpiredClaims,
} from "./resources";
export {
  validateWorkflowStructure,
  applyStaticPolicy,
  validateAndCreateWorkflowPackage,
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
  probeQueueStatus,
  probeHistory,
  downloadOutput,
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
} from "./transports";
export type {
  ComfyUITransport,
  ComfyPromptRequest,
  ComfyPromptResponse,
  ComfyProgress,
  ComfyExecutionResult,
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
  ExecutionConfig,
  OrchestratorResult,
} from "./transports";
export {
  streamCommitArtifact,
  commitArtifactFromBuffer,
  validateMagicBytes,
  checkArtifactAccess,
  cleanupStagingDir,
  ContenType,
} from "./archiving";
export type { ArtifactStreamInput, ArtifactCommitResult } from "./archiving";