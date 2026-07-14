/**
 * 安全媒体归档模块
 *
 * 手册 §15：媒体输入输出与原子归档
 * 提供内容检测、原子提交、磁盘清理等安全机制
 */

// 原有流式提交
export {
  streamCommitArtifact,
  commitArtifactFromBuffer,
  validateMagicBytes,
  checkArtifactAccess,
  cleanupStagingDir,
  recoverStagingArtifacts,
  parseLegacyArtifactRecoveryBeforeMs,
  getArtifactRoot,
  resolveArtifactStoragePath,
  isArtifactStorageKeySafe,
  ContentType,
  ContenType,
} from "./commit";
export type { ArtifactStreamInput, ArtifactCommitResult } from "./commit";

// PR-06 新增：内容检测
export {
  detectMimeType,
  validateMimeType,
  computeStreamHash,
  detectImageDimensions,
  detectAudioDuration,
} from "./content-detection";

// PR-06 新增：磁盘清理
export {
  cleanupExpiredArtifacts,
  cleanupOrphanedArtifacts,
  checkDiskUsage,
  startPeriodicCleanup,
  DEFAULT_CLEANUP_CONFIG,
} from "./disk-cleanup";
export type { CleanupConfig, CleanupStats } from "./disk-cleanup";
