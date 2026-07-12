/**
 * 磁盘清理机制
 *
 * 手册 §15.6：磁盘高水位
 * 定期扫描并清理过期或孤立的工件，防止磁盘空间耗尽
 */

import { readdir, stat, unlink, rmdir } from 'fs/promises';
import { join } from 'path';
import { db } from '@/lib/db';
import { generationArtifacts, generationAttempts } from '@/lib/db/schema';
import { and, lt, eq, isNull } from 'drizzle-orm';

/** 清理配置 */
export interface CleanupConfig {
  /** 磁盘使用率阈值（0-1） */
  diskUsageThreshold: number;
  /** 最大保留天数 */
  maxRetentionDays: number;
  /** 清理批次大小 */
  batchSize: number;
  /** 清理间隔（毫秒） */
  cleanupIntervalMs: number;
}

/** 默认清理配置 */
export const DEFAULT_CLEANUP_CONFIG: CleanupConfig = {
  diskUsageThreshold: 0.85, // 85%
  maxRetentionDays: 30,
  batchSize: 100,
  cleanupIntervalMs: 60 * 60 * 1000, // 1小时
};

/** 清理统计 */
export interface CleanupStats {
  /** 扫描的文件数 */
  scannedFiles: number;
  /** 删除的文件数 */
  deletedFiles: number;
  /** 释放的空间（字节） */
  freedBytes: number;
  /** 清理时间（毫秒） */
  durationMs: number;
}

/**
 * 清理过期的工件
 *
 * 根据数据库记录和文件修改时间，删除过期或孤立的工件
 *
 * @param artifactsRoot 工件根目录
 * @param config 清理配置
 * @returns 清理统计
 */
export async function cleanupExpiredArtifacts(
  artifactsRoot: string,
  config: Partial<CleanupConfig> = {},
): Promise<CleanupStats> {
  const cfg = { ...DEFAULT_CLEANUP_CONFIG, ...config };
  const startTime = Date.now();

  const stats: CleanupStats = {
    scannedFiles: 0,
    deletedFiles: 0,
    freedBytes: 0,
    durationMs: 0,
  };

  try {
    // 查找过期的数据库记录
    const cutoffMs = Date.now() - cfg.maxRetentionDays * 24 * 60 * 60 * 1000;

    const expiredArtifacts = await db
      .select({
        id: generationArtifacts.id,
        storageKey: generationArtifacts.storageKey,
        sizeBytes: generationArtifacts.sizeBytes,
      })
      .from(generationArtifacts)
      .where(
        and(
          lt(generationArtifacts.createdAtMs, cutoffMs),
          eq(generationArtifacts.status, 'COMMITTED'),
        ),
      )
      .limit(cfg.batchSize);

    stats.scannedFiles = expiredArtifacts.length;

    // 删除文件
    for (const artifact of expiredArtifacts) {
      const filePath = join(artifactsRoot, artifact.storageKey);

      try {
        const fileStat = await stat(filePath);
        await unlink(filePath);
        stats.freedBytes += fileStat.size;
        stats.deletedFiles++;

        // 更新数据库状态
        await db
          .update(generationArtifacts)
          .set({
            status: 'DELETED',
            updatedAtMs: Date.now(),
          })
          .where(eq(generationArtifacts.id, artifact.id));
      } catch (err) {
        // 文件不存在或删除失败，继续处理下一个
        console.warn(`Failed to delete artifact ${artifact.id}:`, err);
      }
    }

    // 清理空目录
    await cleanupEmptyDirectories(artifactsRoot);

    stats.durationMs = Date.now() - startTime;
  } catch (err) {
    console.error('Cleanup failed:', err);
    stats.durationMs = Date.now() - startTime;
  }

  return stats;
}

/**
 * 清理孤立的工件文件
 *
 * 扫描文件系统，删除数据库中不存在的文件
 *
 * @param artifactsRoot 工件根目录
 * @param config 清理配置
 * @returns 清理统计
 */
export async function cleanupOrphanedArtifacts(
  artifactsRoot: string,
  config: Partial<CleanupConfig> = {},
): Promise<CleanupStats> {
  const cfg = { ...DEFAULT_CLEANUP_CONFIG, ...config };
  const startTime = Date.now();

  const stats: CleanupStats = {
    scannedFiles: 0,
    deletedFiles: 0,
    freedBytes: 0,
    durationMs: 0,
  };

  try {
    // 递归扫描所有文件
    const files = await scanDirectory(artifactsRoot);
    stats.scannedFiles = files.length;

    for (const filePath of files) {
      const relativePath = filePath.slice(artifactsRoot.length + 1).replace(/\\/g, '/');

      // 检查数据库中是否存在
      const [artifact] = await db
        .select({ id: generationArtifacts.id })
        .from(generationArtifacts)
        .where(eq(generationArtifacts.storageKey, relativePath))
        .limit(1);

      if (!artifact) {
        // 孤立文件，删除
        try {
          const fileStat = await stat(filePath);
          await unlink(filePath);
          stats.freedBytes += fileStat.size;
          stats.deletedFiles++;
        } catch (err) {
          console.warn(`Failed to delete orphaned file ${filePath}:`, err);
        }
      }
    }

    // 清理空目录
    await cleanupEmptyDirectories(artifactsRoot);

    stats.durationMs = Date.now() - startTime;
  } catch (err) {
    console.error('Orphan cleanup failed:', err);
    stats.durationMs = Date.now() - startTime;
  }

  return stats;
}

/**
 * 递归扫描目录
 */
async function scanDirectory(dir: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        const subFiles = await scanDirectory(fullPath);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  } catch (err) {
    console.warn(`Failed to scan directory ${dir}:`, err);
  }

  return files;
}

/**
 * 清理空目录
 */
async function cleanupEmptyDirectories(root: string): Promise<void> {
  try {
    const entries = await readdir(root, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = join(root, entry.name);

        // 递归处理子目录
        await cleanupEmptyDirectories(fullPath);

        // 检查是否为空
        const subEntries = await readdir(fullPath);
        if (subEntries.length === 0) {
          try {
            await rmdir(fullPath);
          } catch (err) {
            // 忽略删除错误（可能已被删除）
          }
        }
      }
    }
  } catch (err) {
    // 忽略根目录扫描错误
  }
}

/**
 * 检查磁盘使用率
 *
 * @param path 检查路径
 * @returns 磁盘使用率（0-1），失败返回 null
 */
export async function checkDiskUsage(path: string): Promise<number | null> {
  try {
    // Node.js 没有内置的磁盘使用率检查，这里使用简化实现
    // 实际生产环境应该使用系统命令或第三方库
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    // Windows: 使用 wmic
    if (process.platform === 'win32') {
      const { stdout } = await execAsync('wmic logicaldisk get size,freespace,caption');
      const lines = stdout.trim().split('\n').slice(1);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          const free = parseInt(parts[0], 10);
          const total = parseInt(parts[2], 10);
          if (!isNaN(free) && !isNaN(total) && total > 0) {
            return 1 - free / total;
          }
        }
      }
    }

    // Linux/macOS: 使用 df
    if (process.platform === 'linux' || process.platform === 'darwin') {
      const { stdout } = await execAsync(`df -k "${path}" | tail -1`);
      const parts = stdout.trim().split(/\s+/);
      if (parts.length >= 5) {
        const total = parseInt(parts[1], 10);
        const used = parseInt(parts[2], 10);
        if (!isNaN(total) && !isNaN(used) && total > 0) {
          return used / total;
        }
      }
    }

    return null;
  } catch (err) {
    console.warn('Failed to check disk usage:', err);
    return null;
  }
}

/**
 * 启动定期清理任务
 *
 * @param artifactsRoot 工件根目录
 * @param config 清理配置
 * @returns 清理定时器 ID
 */
export function startPeriodicCleanup(
  artifactsRoot: string,
  config: Partial<CleanupConfig> = {},
): ReturnType<typeof setInterval> {
  const cfg = { ...DEFAULT_CLEANUP_CONFIG, ...config };

  const cleanupTask = async () => {
    try {
      // 检查磁盘使用率
      const usage = await checkDiskUsage(artifactsRoot);
      if (usage !== null && usage < cfg.diskUsageThreshold) {
        // 磁盘使用率正常，跳过清理
        return;
      }

      console.log('Starting periodic cleanup...');

      // 清理过期工件
      const expiredStats = await cleanupExpiredArtifacts(artifactsRoot, cfg);
      console.log('Expired cleanup:', expiredStats);

      // 清理孤立工件
      const orphanStats = await cleanupOrphanedArtifacts(artifactsRoot, cfg);
      console.log('Orphan cleanup:', orphanStats);
    } catch (err) {
      console.error('Periodic cleanup failed:', err);
    }
  };

  // 立即执行一次
  cleanupTask();

  // 定期执行
  return setInterval(cleanupTask, cfg.cleanupIntervalMs);
}
