import { beforeAll, expect } from "vitest";

/**
 * PR-11 vitest 全局 setup
 *
 * 每个测试文件通过 setupTestDb() 获得独立的 SQLite 实例，
 * 这里只负责保证全局环境变量已被 vitest config 注入。
 */

beforeAll(() => {
  // 确保功能开关在测试进程中已启用
  expect(process.env.FF_V2_DURABLE_EXECUTION).toBe("1");
  expect(process.env.FF_V2_COMFYUI_TRANSPORT).toBe("1");
  expect(process.env.FF_V2_MEDIA_ARCHIVING).toBe("1");
  expect(process.env.FF_V2_WORKFLOW_SUPPLY_CHAIN).toBe("1");
});
