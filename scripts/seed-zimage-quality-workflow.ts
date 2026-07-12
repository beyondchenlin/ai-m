/**
 * Z-Image 质量工作流种子数据脚本
 *
 * 为本地造相质量生成创建初始数据：
 * - 工作流包修订版（Z-Image 质量生成工作流）
 * - 生成配置修订版（用户可选的本地图片质量生成方案）
 *
 * 与快速预览的区别：
 * - 更高质量工作流（更多步骤、更精细参数）
 * - 更长超时（300秒 vs 60秒）
 * - 更严格环境锁
 * - 支持参考图注入
 *
 * 运行方式：npm run seed:zimage-quality
 */

import { db } from "@/lib/db";
import {
  workflowPackageRevisions,
  workflowPackageStates,
  generationProfileRevisions,
  generationProfileStates,
  executionBackends,
} from "@/lib/db/schema";
import { id as genId } from "@/lib/id";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";

/** 生成 SHA256 摘要 */
function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function seedZImageQualityWorkflow() {
  console.log("🌱 Starting Z-Image quality workflow seed...\n");

  const now = Date.now();

  // 1. 查找执行后端（复用快速预览的后端）
  console.log("🖥️  Finding execution backend...");
  const [backend] = await db
    .select()
    .from(executionBackends)
    .where(eq(executionBackends.adapterKind, "zimage"))
    .limit(1);

  if (!backend) {
    throw new Error("Execution backend not found. Run seed:zimage first");
  }

  console.log(`  ✓ Found backend: ${backend.displayName}`);
  console.log(`    ID: ${backend.id}\n`);

  // 2. 创建质量工作流包修订版
  console.log("📝 Creating quality workflow package revision...");
  const workflowApi = {
    nodes: {
      "1": { class_type: "ZImageLoader", inputs: { zimage_model: "Z-Image-Pro" } },
      "2": {
        class_type: "ZImagePositive",
        inputs: {
          text: "{{prompt}}",
          width: "{{width}}",
          height: "{{height}}",
          reference_images: "{{referenceImages}}",
          reference_strength: "{{referenceStrength}}",
        },
      },
      "3": { class_type: "ZImageNegative", inputs: { text: "{{negativePrompt}}" } },
      "4": {
        class_type: "ZImageSampler",
        inputs: {
          seed: "{{seed}}",
          steps: 25,
          cfg: 7.5,
          sampler_name: "dpm++_2m",
          scheduler: "karras",
          denoise: 1.0,
          model: ["1", 0],
          positive: ["2", 0],
          negative: ["3", 0],
        },
      },
      "5": { class_type: "ZImageDecoder", inputs: { samples: ["4", 0] } },
      "6": { class_type: "SaveImage", inputs: { images: ["5", 0], filename_prefix: "ai-m-zimage-quality" } },
    },
    outputs: { "6": { class_type: "SaveImage", node_id: "6" } },
  };

  const workflowJson = JSON.stringify(workflowApi);
  const workflowSha = sha256(workflowJson);
  const workflowDigest = sha256(`${workflowSha}:${now}`);

  const manifest = {
    workflowId: "zimage-quality-production",
    version: "1.0.0",
    capability: "image",
    displayName: "Z-Image 质量生成",
    description: "高质量、支持参考图的造相文生图工作流，适合最终素材",
    author: "system",
    createdAt: new Date(now).toISOString(),
    features: {
      supportsReferenceImages: true,
      maxReferenceImageCount: 3,
      supportsNegativePrompt: true,
      highQuality: true,
    },
  };

  const compiledBindings = {
    "{{prompt}}": { node: "2", field: "text" },
    "{{negativePrompt}}": { node: "3", field: "text" },
    "{{width}}": { node: "2", field: "width" },
    "{{height}}": { node: "2", field: "height" },
    "{{seed}}": { node: "4", field: "seed" },
    "{{referenceImages}}": { node: "2", field: "reference_images" },
    "{{referenceStrength}}": { node: "2", field: "reference_strength" },
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
  console.log(`    Version: ${manifest.version}`);
  console.log(`    Supports reference images: ${manifest.features.supportsReferenceImages}\n`);

  // 3. 创建工作流包状态（初始为 installed）
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

  // 4. 创建生成配置修订版
  console.log("⚙️  Creating quality generation profile revision...");
  const profileRevisionId = genId();
  const profileRevisionDigest = sha256(`${profileRevisionId}:${now}`);

  const configJson = {
    displayName: "Z-Image 质量生成",
    description: "高质量、支持参考图的本地图片生成配置，适合最终素材",
    defaultParameters: {
      steps: 25,
      cfg: 7.5,
      sampler: "dpm++_2m",
      scheduler: "karras",
      width: 1024,
      height: 1024,
      referenceStrength: 0.7,
    },
    timeouts: {
      maxExecutionTimeMs: 300_000, // 5分钟
      pollingIntervalMs: 3000,
    },
    limits: {
      maxBatchSize: 1,
      allowedAspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
      maxReferenceImages: 3,
    },
    features: {
      supportsNegativePrompt: true,
      supportsReferenceImages: true,
      highQuality: true,
    },
  };

  await db.insert(generationProfileRevisions).values({
    id: profileRevisionId,
    profileKey: "zimage-quality-production",
    revisionNo: 1,
    revisionDigest: profileRevisionDigest,
    displayName: configJson.displayName,
    capability: "image",
    adapterKind: "zimage",
    executionBackendId: backend.id,
    workflowPackageDigest: workflowDigest,
    configJson,
    createdBy: "system",
    createdAtMs: now,
  });

  console.log(`  ✓ Generation profile revision created: ${profileRevisionId}`);
  console.log(`    Profile key: ${configJson.displayName}`);
  console.log(`    Max execution time: ${configJson.timeouts.maxExecutionTimeMs}ms`);
  console.log(`    Supports reference images: ${configJson.features.supportsReferenceImages}\n`);

  // 5. 创建生成配置状态（初始禁用）
  console.log("🔒 Creating generation profile state...");
  await db.insert(generationProfileStates).values({
    generationProfileRevisionId: profileRevisionId,
    enabled: 0,
    visibility: "admin",
    updatedAtMs: now,
  });
  console.log(`  ✓ Generation profile state: disabled (admin only)\n`);

  console.log("✅ Quality workflow seed data created successfully!\n");
  console.log("📌 Next steps:");
  console.log("   1. Run promotion script: npm run promote:zimage-quality");
  console.log("   2. This will activate the workflow and enable the profile\n");
}

seedZImageQualityWorkflow()
  .then(() => {
    console.log("🎉 Seed script completed");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Seed script failed:", err);
    process.exit(1);
  });
