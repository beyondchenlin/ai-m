/**
 * Z-Image 工作流种子数据脚本
 *
 * 为本地造相快速闭环创建初始数据：
 * - 资源池（GPU 资源）
 * - 执行后端（ComfyUI 服务）
 * - 工作流包修订版（Z-Image 快速预览工作流）
 * - 生成配置修订版（用户可选的本地图片生成方案）
 *
 * 运行方式：npm run seed:zimage
 */

import { db } from "@/lib/db";
import {
  resourcePools,
  executionBackends,
  workflowPackageRevisions,
  workflowPackageStates,
  generationProfileRevisions,
  generationProfileStates,
  defaultGenerationProfilePointers,
} from "@/lib/db/schema";
import { id as genId } from "@/lib/id";
import { createHash } from "crypto";

/** 生成 SHA256 摘要 */
function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function seedZImageWorkflow() {
  console.log("🌱 Starting Z-Image workflow seed...\n");

  const now = Date.now();

  // 1. 创建资源池
  console.log("📦 Creating resource pool...");
  const resourcePoolId = genId();
  await db.insert(resourcePools).values({
    id: resourcePoolId,
    displayName: "本地 GPU 资源池",
    capacity: 1,
    policyJson: {
      maxConcurrentJobs: 1,
      maxExecutionTimeMs: 300_000,
      gpuMemoryGb: 8,
    },
    createdAtMs: now,
    updatedAtMs: now,
  });
  console.log(`  ✓ Resource pool created: ${resourcePoolId}\n`);

  // 2. 创建执行后端
  console.log("🖥️  Creating execution backend...");
  const backendId = genId();
  const baseUrl = process.env.COMFYUI_BASE_URL || "http://localhost:8188";
  await db.insert(executionBackends).values({
    id: backendId,
    displayName: "本地 ComfyUI 服务",
    adapterKind: "zimage",
    baseUrl,
    topology: "same-host",
    sharingMode: "shared",
    authType: "none",
    authConfigJson: {},
    tlsConfigJson: {},
    networkPolicyJson: {
      allowedHosts: ["localhost", "127.0.0.1"],
      allowedPorts: [8188],
      rejectRedirects: true,
    },
    resourcePoolId: resourcePoolId,
    capabilitiesJson: {
      supportsNegativePrompt: true,
      supportsReferenceImages: false,
      maxReferenceImageCount: 0,
      supportsBatch: false,
      allowedAspectRatios: ["1:1", "16:9", "9:16"],
      maxOutputCount: 1,
      nodeClasses: ["ZImageLoader", "ZImagePositive", "ZImageNegative", "ZImageSampler", "ZImageDecoder", "SaveImage"],
    },
    environmentFingerprint: "local-comfyui-v1",
    featureSnapshotJson: {
      externalIdStrategy: "server-assigned",
      supportsCancellation: true,
      supportsProgressTracking: true,
    },
    validatedAtMs: now,
    enabled: 1,
    createdAtMs: now,
    updatedAtMs: now,
  });
  console.log(`  ✓ Execution backend created: ${backendId}`);
  console.log(`    Base URL: ${baseUrl}\n`);

  // 3. 创建工作流包修订版
  console.log("📝 Creating workflow package revision...");
  const workflowApi = {
    nodes: {
      "1": { class_type: "ZImageLoader", inputs: { zimage_model: "Z-Image-Turbo" } },
      "2": { class_type: "ZImagePositive", inputs: { text: "{{prompt}}", width: "{{width}}", height: "{{height}}" } },
      "3": { class_type: "ZImageNegative", inputs: { text: "{{negativePrompt}}" } },
      "4": {
        class_type: "ZImageSampler",
        inputs: {
          seed: "{{seed}}",
          steps: 8,
          cfg: 2.0,
          sampler_name: "euler",
          scheduler: "normal",
          denoise: 1.0,
          model: ["1", 0],
          positive: ["2", 0],
          negative: ["3", 0],
        },
      },
      "5": { class_type: "ZImageDecoder", inputs: { samples: ["4", 0] } },
      "6": { class_type: "SaveImage", inputs: { images: ["5", 0], filename_prefix: "ai-m-zimage" } },
    },
    outputs: { "6": { class_type: "SaveImage", node_id: "6" } },
  };

  const workflowJson = JSON.stringify(workflowApi);
  const workflowSha = sha256(workflowJson);
  const workflowDigest = sha256(`${workflowSha}:${now}`);

  const manifest = {
    workflowId: "zimage-fast-preview",
    version: "1.0.0",
    capability: "image",
    displayName: "Z-Image 快速预览",
    description: "低步骤、快速迭代的造相文生图工作流",
    author: "system",
    createdAt: new Date(now).toISOString(),
  };

  const compiledBindings = {
    "{{prompt}}": { node: "2", field: "text" },
    "{{negativePrompt}}": { node: "3", field: "text" },
    "{{width}}": { node: "2", field: "width" },
    "{{height}}": { node: "2", field: "height" },
    "{{seed}}": { node: "4", field: "seed" },
  };

  const packageLock = {
    workflowSha256: workflowSha,
    environmentLock: "local-comfyui-v1",
    nodeVersions: {
      ZImageLoader: "1.0.0",
      ZImagePositive: "1.0.0",
      ZImageNegative: "1.0.0",
      ZImageSampler: "1.0.0",
      ZImageDecoder: "1.0.0",
      SaveImage: "1.0.0",
    },
  };

  await db.insert(workflowPackageRevisions).values({
    digest: workflowDigest,
    workflowId: manifest.workflowId,
    version: manifest.version,
    capability: manifest.capability,
    manifestJson: manifest,
    compiledBindingsJson: compiledBindings,
    packageLockJson: packageLock,
    packagePath: `workflows/${manifest.workflowId}/${manifest.version}`,
    workflowSha256: workflowSha,
    environmentLockDigest: sha256("local-comfyui-v1"),
    createdAtMs: now,
  });

  console.log(`  ✓ Workflow package revision created: ${workflowDigest}`);
  console.log(`    Workflow ID: ${manifest.workflowId}`);
  console.log(`    Version: ${manifest.version}\n`);

  // 4. 创建工作流包状态（初始为 installed）
  console.log("📋 Creating workflow package state...");
  await db.insert(workflowPackageStates).values({
    workflowPackageDigest: workflowDigest,
    state: "installed",
    validationReportJson: {
      structureValid: true,
      staticPolicyValid: true,
      environmentValid: true,
      validatedAt: new Date(now).toISOString(),
    },
    updatedAtMs: now,
  });
  console.log(`  ✓ Workflow package state: installed\n`);

  // 5. 创建生成配置修订版
  console.log("⚙️  Creating generation profile revision...");
  const profileRevisionId = genId();
  const profileRevisionDigest = sha256(`${profileRevisionId}:${now}`);

  const configJson = {
    displayName: "Z-Image 快速预览",
    description: "低步骤、快速迭代的本地图片生成配置",
    defaultParameters: {
      steps: 8,
      cfg: 2.0,
      sampler: "euler",
      scheduler: "normal",
      width: 1024,
      height: 1024,
    },
    timeouts: {
      maxExecutionTimeMs: 60_000,
      pollingIntervalMs: 2000,
    },
    limits: {
      maxBatchSize: 1,
      allowedAspectRatios: ["1:1", "16:9", "9:16"],
    },
  };

  await db.insert(generationProfileRevisions).values({
    id: profileRevisionId,
    profileKey: "zimage-fast-preview",
    revisionNo: 1,
    revisionDigest: profileRevisionDigest,
    displayName: configJson.displayName,
    capability: "image",
    adapterKind: "zimage",
    executionBackendId: backendId,
    workflowPackageDigest: workflowDigest,
    configJson,
    createdBy: "system",
    createdAtMs: now,
  });

  console.log(`  ✓ Generation profile revision created: ${profileRevisionId}`);
  console.log(`    Profile key: ${configJson.displayName}\n`);

  // 6. 创建生成配置状态（初始禁用）
  console.log("🔒 Creating generation profile state...");
  await db.insert(generationProfileStates).values({
    generationProfileRevisionId: profileRevisionId,
    enabled: 0,
    visibility: "admin",
    updatedAtMs: now,
  });
  console.log(`  ✓ Generation profile state: disabled (admin only)\n`);

  console.log("✅ Seed data created successfully!\n");
  console.log("📌 Next steps:");
  console.log("   1. Run promotion script: npm run promote:zimage");
  console.log("   2. This will activate the workflow and enable the profile\n");
}

seedZImageWorkflow()
  .then(() => {
    console.log("🎉 Seed script completed");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Seed script failed:", err);
    process.exit(1);
  });
