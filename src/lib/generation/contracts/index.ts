/**
 * v2.0 generation contracts 入口
 */

export type {
  TextRequest,
  TextResult,
  ImageRequest,
  ImageResult,
  ImageOutput,
  VideoRequest,
  VideoResult,
  SpeechRequest,
  SpeechResult,
  ExecutionContext,
  TextProvider,
  ImageProvider,
  VideoProvider,
  SpeechProvider,
} from "./providers";

export type {
  CreateGenerationJobInput,
  GenerationJobView,
  ArtifactRef,
  RetryMode,
  GenerationJobService,
  WorkflowCompiler,
  WorkflowPackageSource,
  WorkflowSecurityPolicy,
  CompiledWorkflowPackage,
  ArtifactCommitter,
  ArtifactCommitInput,
  CommittedArtifact,
  Actor,
} from "./services";