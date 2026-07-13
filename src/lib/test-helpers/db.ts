/**
 * PR-11 测试数据库隔离 helper
 *
 * 通过重置 globalThis 上的 sqlite/drizzleDb 单例，
 * 让每个测试文件获得独立的 SQLite 文件。
 */

import { randomUUID } from "crypto";
import { tmpdir } from "os";
import path from "path";
import { rmSync } from "fs";
import { runMigrations } from "@/lib/db";

export interface TestDbContext {
  dbPath: string;
  cleanup: () => void;
}

/**
 * 创建独立测试数据库并运行迁移。
 * 应在测试文件的 beforeAll 中调用，afterAll 中调用 cleanup。
 */
export function setupTestDb(): TestDbContext {
  const dbPath = path.join(tmpdir(), `ai-m-test-${randomUUID()}.db`);
  process.env.DATABASE_URL = `file:${dbPath}`;

  // 重置全局单例，强制下一次 db 访问创建新连接
  const g = globalThis as unknown as { sqlite?: unknown; drizzleDb?: unknown };
  delete g.sqlite;
  delete g.drizzleDb;

  runMigrations();

  return {
    dbPath,
    cleanup: () => {
      try {
        // 关闭 better-sqlite3 连接，防止 Windows 下文件被占用无法删除
        const sqlite = (g.sqlite as { close?: () => void } | undefined);
        sqlite?.close?.();
      } catch {
        // ignore
      }
      try {
        rmSync(dbPath, { force: true });
        rmSync(`${dbPath}-shm`, { force: true });
        rmSync(`${dbPath}-wal`, { force: true });
      } catch {
        // ignore
      }
    },
  };
}
