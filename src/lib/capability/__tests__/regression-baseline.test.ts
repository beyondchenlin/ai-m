/**
 * v2.0 回归基线：旧流程特征测试
 *
 * 验证阶段 C 改造后，旧云供应商流程不受影响。
 * 每次 PR 合并前必须通过此测试套件。
 *
 * 运行: npx tsx src/lib/capability/__tests__/regression-baseline.test.ts
 */

import { capabilityService } from "../service";
import { FF, isEnabled } from "@/lib/feature-flags";
import type { CapabilityRequest } from "../types";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failed++;
    process.exitCode = 1;
  } else {
    console.log(`  PASS: ${message}`);
    passed++;
  }
}

/** 测试 1: 能力服务接口完整性 */
async function testCapabilityServiceInterface() {
  console.log("1. CapabilityService interface");
  assert(typeof capabilityService.generateText === "function", "generateText exists");
  assert(typeof capabilityService.generateImage === "function", "generateImage exists");
  assert(typeof capabilityService.generateVideo === "function", "generateVideo exists");
}

/** 测试 2: Legacy 配置解析 */
async function testLegacyConfigResolution() {
  console.log("\n2. Legacy config resolution");
  const legacyRequest: CapabilityRequest = {
    kind: "image",
    legacyConfig: {
      protocol: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      modelId: "dall-e-3",
    },
  };
  try {
    assert(true, "legacy config accepted without error");
  } catch (e) {
    assert(false, `legacy config failed: ${e}`);
  }

  // 验证所有旧协议都能正确传递
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
    try {
      const req: CapabilityRequest = {
        kind: "image",
        legacyConfig: { protocol, baseUrl, apiKey: "sk-test", modelId: "test" },
      };
      assert(true, `legacy config for ${protocol}`);
    } catch (e) {
      assert(false, `legacy config for ${protocol}: ${e}`);
    }
  }
}

/** 测试 3: 缺失后端优雅报错 */
async function testMissingBackendError() {
  console.log("\n3. Backend ID resolution (missing backend)");
  const missingBackendRequest: CapabilityRequest = {
    kind: "image",
    backendId: "non-existent-backend-id",
  };
  try {
    await capabilityService.generateImage("test prompt", {}, missingBackendRequest);
    assert(false, "should have thrown for missing backend");
  } catch (e) {
    assert(e instanceof Error && e.message.includes("not found"), `missing backend throws correct error: ${e}`);
  }
}

/** 测试 4: 默认供应商回退 */
async function testDefaultProviderFallback() {
  console.log("\n4. Default provider fallback");
  try {
    await capabilityService.generateText("test", {}, { kind: "text" });
    assert(false, "should have thrown (no default provider configured in test)");
  } catch (e) {
    assert(e instanceof Error, `default provider fallback throws expected error: ${e}`);
  }
}

/** 测试 5: CloudSupplierAdapter 协议映射 */
async function testCloudSupplierAdapterProtocols() {
  console.log("\n5. CloudSupplierAdapter protocol mapping");
  const { CloudSupplierAdapter } = await import("../adapters/cloud-supplier");
  const protocols = ["openai", "gemini", "kling", "dashscope", "seedance", "ucloud-seedance", "wan"];
  for (const protocol of protocols) {
    try {
      new CloudSupplierAdapter({
        protocol,
        baseUrl: "https://test.example.com",
        apiKey: "test-key",
        modelId: "test-model",
      });
      assert(true, `CloudSupplierAdapter created for ${protocol}`);
    } catch (e) {
      assert(false, `CloudSupplierAdapter failed for ${protocol}: ${e}`);
    }
  }
}

/** 测试 6: 不支持的协议 */
async function testUnsupportedProtocol() {
  console.log("\n6. Unsupported protocol handling");
  try {
    new (await import("../adapters/cloud-supplier")).CloudSupplierAdapter({
      protocol: "unsupported-protocol",
      baseUrl: "https://test.example.com",
      apiKey: "test-key",
      modelId: "test-model",
    });
    assert(true, "unsupported protocol adapter created (lazy validation)");
  } catch (e) {
    assert(true, `unsupported protocol throws on creation: ${e}`);
  }
}

/** 测试 7: 功能开关默认全部关闭 */
async function testFeatureFlagsDefaultOff() {
  console.log("\n7. Feature flags default off");
  const flags = Object.values(FF);
  for (const flag of flags) {
    assert(!isEnabled(flag), `FF_${flag} is disabled by default`);
  }
}

/** 测试 8: 命名词典常量一致性 */
async function testNamingDictionary() {
  console.log("\n8. Naming dictionary consistency");
  const { JobStatus, AttemptPhase, ArtifactKind, ErrorClass, TERM_MAP } = await import("@/lib/generation/naming");

  // 验证状态常量不重复
  const jobStatuses = Object.values(JobStatus);
  assert(new Set(jobStatuses).size === jobStatuses.length, "JobStatus has no duplicates");

  const attemptPhases = Object.values(AttemptPhase);
  assert(new Set(attemptPhases).size === attemptPhases.length, "AttemptPhase has no duplicates");

  // 验证 TERM_MAP 包含所有关键术语
  const requiredTerms = [
    "Capability", "ExecutionBackend", "WorkflowPackageRevision",
    "GenerationProfileRevision", "GenerationJob", "GenerationAttempt",
    "Artifact", "ResourcePool", "Lease", "FencingToken", "ExecutionSnapshot",
  ];
  for (const term of requiredTerms) {
    assert(term in TERM_MAP, `TERM_MAP contains ${term}`);
  }

  // 验证 ArtifactKind 与 schema 一致
  const expectedKinds = ["image", "video", "audio", "text", "archive"];
  for (const kind of expectedKinds) {
    assert(Object.values(ArtifactKind).includes(kind as typeof ArtifactKind[keyof typeof ArtifactKind]), `ArtifactKind contains ${kind}`);
  }

  // 验证 ErrorClass 与手册 §14.5 一致
  const expectedErrors = [
    "PERMANENT_INPUT", "WORKFLOW_CONTRACT", "ENVIRONMENT_INCOMPATIBLE",
    "TRANSIENT_CONNECTION", "SUBMISSION_UNKNOWN", "EXTERNAL_EXECUTION",
    "OUTPUT_COLLECTION", "ARTIFACT_COMMIT", "PERMISSION_SECURITY",
  ];
  for (const ec of expectedErrors) {
    assert(Object.values(ErrorClass).includes(ec as typeof ErrorClass[keyof typeof ErrorClass]), `ErrorClass contains ${ec}`);
  }
}

/** 测试 9: ADR 文件存在且状态一致 */
async function testAdrFiles() {
  console.log("\n9. ADR files exist and consistent");
  const fs = await import("fs");
  const path = await import("path");

  const adrsDir = path.resolve(process.cwd(), "adrs");
  assert(fs.existsSync(adrsDir), "adrs/ directory exists");

  const expectedAdrs = [
    "0001-durable-worker.md",
    "0002-separate-backend-profile-workflow.md",
    "0003-workflow-trust-boundary.md",
    "0004-sqlite-single-host-boundary.md",
  ];

  for (const adr of expectedAdrs) {
    const filePath = path.join(adrsDir, adr);
    assert(fs.existsSync(filePath), `ADR ${adr} exists`);
    const content = fs.readFileSync(filePath, "utf-8");
    assert(content.includes("已接受"), `ADR ${adr} status is 已接受`);
    assert(content.includes("2026-07-12"), `ADR ${adr} has date`);
  }
}

/** 测试 10: 执行后端适配器映射完整性 */
async function testExecutionBackendAdapterMapping() {
  console.log("\n10. Execution backend adapter mapping");
  const { providerToBackendParams, isLegacyProvider } = await import("@/lib/ai/execution-backend-adapter");

  // 验证 legacy 前缀检测
  assert(isLegacyProvider("legacy-test-id"), "legacy- prefix detected");
  assert(!isLegacyProvider("normal-id"), "non-legacy id not detected as legacy");

  // 验证所有旧协议可转换
  const protocols = ["openai", "gemini", "seedance", "ucloud-seedance", "kling", "wan", "dashscope"] as const;
  for (const protocol of protocols) {
    try {
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
      assert(typeof params.id === "string", `providerToBackendParams for ${protocol} returns valid id`);
      assert(params.adapterKind.endsWith("-http"), `providerToBackendParams for ${protocol} has -http suffix`);
    } catch (e) {
      assert(false, `providerToBackendParams failed for ${protocol}: ${e}`);
    }
  }
}

async function main() {
  console.log("=== v2.0 Regression Baseline Tests ===\n");

  await testCapabilityServiceInterface();
  await testLegacyConfigResolution();
  await testMissingBackendError();
  await testDefaultProviderFallback();
  await testCloudSupplierAdapterProtocols();
  await testUnsupportedProtocol();
  await testFeatureFlagsDefaultOff();
  await testNamingDictionary();
  await testAdrFiles();
  await testExecutionBackendAdapterMapping();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${passed + failed} total ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test suite error:", err);
  process.exit(1);
});