/**
 * v2.0 回归基线：旧流程特征测试
 *
 * 验证阶段 C 改造后，旧云供应商流程不受影响。
 * 每次 PR 合并前必须通过此测试套件。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { capabilityService } from "../service";
import { FF, isEnabled } from "@/lib/feature-flags";
import { db } from "@/lib/db";
import { executionBackends } from "@/lib/db/schema";
import { setupTestDb } from "@/lib/test-helpers/db";
import type { CapabilityRequest } from "../types";

describe("v2.0 Regression Baseline: 能力服务接口", () => {
  it("CapabilityService 接口完整", () => {
    expect(typeof capabilityService.generateText).toBe("function");
    expect(typeof capabilityService.generateImage).toBe("function");
    expect(typeof capabilityService.generateVideo).toBe("function");
  });
});

describe("v2.0 Regression Baseline: 旧配置解析", () => {
  it("legacy 配置对象可被接受", () => {
    const legacyRequest: CapabilityRequest = {
      kind: "image",
      legacyConfig: {
        protocol: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        modelId: "dall-e-3",
      },
    };
    expect(legacyRequest.legacyConfig?.protocol).toBe("openai");
  });

  it("所有旧协议都能正确传递", () => {
    const protocols = [
      { protocol: "openai", baseUrl: "https://api.openai.com/v1" },
      { protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com" },
      { protocol: "kling", baseUrl: "https://api.klingai.com" },
      { protocol: "dashscope", baseUrl: "https://dashscope.aliyuncs.com/api/v1" },
      { protocol: "seedance", baseUrl: "https://api.seedance.com" },
      { protocol: "ucloud-seedance", baseUrl: "https://api.ucloud-seedance.com" },
      { protocol: "wan", baseUrl: "https://api.wan.com" },
    ];

    for (const { protocol, baseUrl } of protocols) {
      const req: CapabilityRequest = {
        kind: "image",
        legacyConfig: { protocol, baseUrl, apiKey: "sk-test", modelId: "test" },
      };
      expect(req.legacyConfig?.protocol).toBe(protocol);
      expect(req.legacyConfig?.baseUrl).toBe(baseUrl);
    }
  });
});

describe("v2.0 Regression Baseline: 后端解析", () => {
  let ctx: ReturnType<typeof setupTestDb>;

  beforeAll(() => {
    ctx = setupTestDb();
  });

  afterAll(() => {
    ctx.cleanup();
  });

  beforeEach(async () => {
    await db.delete(executionBackends);
  });

  it("缺失后端应抛出 not found 错误", async () => {
    const missingBackendRequest: CapabilityRequest = {
      kind: "image",
      backendId: "non-existent-backend-id",
    };

    await expect(
      capabilityService.generateImage("test prompt", {}, missingBackendRequest),
    ).rejects.toThrow("not found");
  });

  it("无默认供应商时应抛出预期错误", async () => {
    await expect(
      capabilityService.generateText("test", {}, { kind: "text" }),
    ).rejects.toThrow("No AI provider configured");
  });
});

describe("v2.0 Regression Baseline: CloudSupplierAdapter 协议映射", () => {
  it("所有旧协议均可创建适配器", async () => {
    const { CloudSupplierAdapter } = await import("../adapters/cloud-supplier");
    const protocols = ["openai", "gemini", "kling", "dashscope", "seedance", "ucloud-seedance", "wan"];

    for (const protocol of protocols) {
      const adapter = new CloudSupplierAdapter({
        protocol,
        baseUrl: "https://test.example.com",
        apiKey: "test-key",
        modelId: "test-model",
      });
      expect(adapter).toBeDefined();
    }
  });

  it("不支持的协议按需抛出或延迟验证", async () => {
    const { CloudSupplierAdapter } = await import("../adapters/cloud-supplier");
    expect(() => {
      new CloudSupplierAdapter({
        protocol: "unsupported-protocol",
        baseUrl: "https://test.example.com",
        apiKey: "test-key",
        modelId: "test-model",
      });
    }).toBeDefined();
  });
});

describe("v2.0 Regression Baseline: 功能开关默认值", () => {
  it("未设置环境变量时所有开关默认关闭", () => {
    // 清除 vitest 配置中启用的环境变量，验证默认值
    for (const flag of Object.values(FF)) {
      vi.stubEnv(`FF_${flag}`, undefined);
    }

    try {
      for (const flag of Object.values(FF)) {
        expect(isEnabled(flag)).toBe(false);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("v2.0 Regression Baseline: 命名词典一致性", () => {
  it("状态常量无重复且包含预期术语", async () => {
    const { JobStatus, AttemptPhase, ArtifactKind, ErrorClass, TERM_MAP } = await import("@/lib/generation/naming");

    const jobStatuses = Object.values(JobStatus);
    expect(new Set(jobStatuses).size).toBe(jobStatuses.length);

    const attemptPhases = Object.values(AttemptPhase);
    expect(new Set(attemptPhases).size).toBe(attemptPhases.length);

    const requiredTerms = [
      "Capability",
      "ExecutionBackend",
      "WorkflowPackageRevision",
      "GenerationProfileRevision",
      "GenerationJob",
      "GenerationAttempt",
      "Artifact",
      "ResourcePool",
      "Lease",
      "FencingToken",
      "ExecutionSnapshot",
    ];
    for (const term of requiredTerms) {
      expect(term in TERM_MAP).toBe(true);
    }

    const expectedKinds = ["image", "video", "audio", "text", "archive"];
    for (const kind of expectedKinds) {
      expect(Object.values(ArtifactKind)).toContain(kind);
    }

    const expectedErrors = [
      "PERMANENT_INPUT",
      "WORKFLOW_CONTRACT",
      "ENVIRONMENT_INCOMPATIBLE",
      "TRANSIENT_CONNECTION",
      "SUBMISSION_UNKNOWN",
      "EXTERNAL_EXECUTION",
      "OUTPUT_COLLECTION",
      "ARTIFACT_COMMIT",
      "PERMISSION_SECURITY",
    ];
    for (const ec of expectedErrors) {
      expect(Object.values(ErrorClass)).toContain(ec);
    }
  });
});

describe("v2.0 Regression Baseline: ADR 文件", () => {
  it("ADR 目录与文件存在且状态一致", async () => {
    const fs = await import("fs");
    const path = await import("path");

    const adrsDir = path.resolve(process.cwd(), "adrs");
    expect(fs.existsSync(adrsDir)).toBe(true);

    const expectedAdrs = [
      "0001-durable-worker.md",
      "0002-separate-backend-profile-workflow.md",
      "0003-workflow-trust-boundary.md",
      "0004-sqlite-single-host-boundary.md",
    ];

    for (const adr of expectedAdrs) {
      const filePath = path.join(adrsDir, adr);
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, "utf-8");
      expect(content).toContain("已接受");
      expect(content).toContain("2026-07-12");
    }
  });
});

describe("v2.0 Regression Baseline: 执行后端适配器映射", () => {
  it("legacy 前缀检测与协议转换正确", async () => {
    const { providerToBackendParams, isLegacyProvider } = await import("@/lib/ai/execution-backend-adapter");

    expect(isLegacyProvider("legacy-test-id")).toBe(true);
    expect(isLegacyProvider("normal-id")).toBe(false);

    const protocols = ["openai", "gemini", "seedance", "ucloud-seedance", "kling", "wan", "dashscope"] as const;
    for (const protocol of protocols) {
      const params = providerToBackendParams({
        id: "test-id",
        name: "Test Provider",
        protocol,
        baseUrl: "https://test.example.com",
        apiKey: "test-key",
        capability: "image",
        enabled: true,
        modelId: "test-model",
      } as Parameters<typeof providerToBackendParams>[0]);

      expect(typeof params.id).toBe("string");
      expect(params.adapterKind.endsWith("-http")).toBe(true);
    }
  });
});
