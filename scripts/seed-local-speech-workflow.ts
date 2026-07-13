/**
 * 本地声音工作流种子数据脚本
 *
 * 为本地声音能力创建初始数据：
 * - 资源池（GPU 资源，复用已有或新建）
 * - 执行后端（ComfyUI 声音服务）
 * - 工作流包修订版（IndexTTS2 声音克隆工作流）
 * - 生成配置修订版（用户可选的本地声音生成方案）
 *
 * 运行方式：npm run seed:local-speech
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
import { eq } from "drizzle-orm";

/** 生成 SHA256 摘要 */
function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function seedLocalSpeechWorkflow() {
  console.log("🌱 Starting local speech workflow seed...\n");

  const now = Date.now();

  // 1. 查找或创建资源池
  console.log("📦 Finding or creating resource pool...");
  let [existingPool] = await db.select().from(resourcePools).limit(1);
  
  let resourcePoolId: string;
  if (existingPool) {
    resourcePoolId = existingPool.id;
    console.log(`  ✓ Using existing resource pool: ${resourcePoolId}\n`);
  } else {
    resourcePoolId = genId();
    await db.insert(resourcePools).values({
      id: resourcePoolId,
      displayName: "本地 GPU 资源池",
      capacity: 1,
      policyJson: {
        maxConcurrentJobs: 1,
        maxExecutionTimeMs: 600_000, // 声音生成长任务
        gpuMemoryGb: 8,
      },
      createdAtMs: now,
      updatedAtMs: now,
    });
    console.log(`  ✓ Resource pool created: ${resourcePoolId}\n`);
  }

  // 2. 查找或创建执行后端
  console.log("🖥️  Finding or creating execution backend...");
  const [existingBackend] = await db
    .select()
    .from(executionBackends)
    .where(eq(executionBackends.adapterKind, "local-speech"))
    .limit(1);

  let backendId: string;
  if (existingBackend) {
    backendId = existingBackend.id;
    console.log(`  ✓ Using existing backend: ${backendId}\n`);
  } else {
    backendId = genId();
    const baseUrl = process.env.COMFYUI_BASE_URL || "http://localhost:8188";
    await db.insert(executionBackends).values({
      id: backendId,
      displayName: "本地 ComfyUI 声音服务",
      adapterKind: "local-speech",
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
        supportsVoiceCloning: true,
        supportsMultiLanguage: true,
        supportedLanguages: ["zh-CN", "en-US", "ja-JP"],
        maxTextLength: 5000,
        supportedAudioFormats: ["wav", "mp3", "ogg"],
        sampleRates: [16000, 22050, 44100],
        nodeClasses: ["IndexTTS2Loader", "IndexTTS2Synthesizer", "SaveAudio"],
      },
      environmentFingerprint: "local-comfyui-speech-v1",
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
  }

  // 3. 创建工作流包修订版（如果不存在）
  console.log("📝 Creating workflow package revision...");
  const [existingWorkflow] = await db
    .select()
    .from(workflowPackageRevisions)
    .where(eq(workflowPackageRevisions.workflowId, "local-speech-indextts2"))
    .limit(1);

  let workflowDigest: string;
  let manifest: { workflowId: string; version: string };
  if (existingWorkflow) {
    manifest = { workflowId: existingWorkflow.workflowId, version: existingWorkflow.version };
    workflowDigest = existingWorkflow.digest;
    console.log(`  ✓ Workflow package revision already exists: ${workflowDigest}`);
    console.log(`    Workflow ID: ${existingWorkflow.workflowId}`);
    console.log(`    Version: ${existingWorkflow.version}\n`);
  } else {
    const workflowApi = {
      nodes: {
        "1": { 
          class_type: "IndexTTS2Loader", 
          inputs: { 
            model_name: "IndexTTS2-Base",
            voice_profile_path: "{{voiceProfilePath}}",
          } 
        },
        "2": { 
          class_type: "IndexTTS2Synthesizer", 
          inputs: { 
            text: "{{text}}",
            speed: "{{speed}}",
            model: ["1", 0],
          } 
        },
        "3": { 
          class_type: "SaveAudio", 
          inputs: { 
            audio: ["2", 0], 
            filename_prefix: "ai-m-speech",
            format: "wav",
          } 
        },
      },
      outputs: { "3": { class_type: "SaveAudio", node_id: "3" } },
    };

    const workflowJson = JSON.stringify(workflowApi);
    const workflowSha = sha256(workflowJson);
    workflowDigest = sha256(`${workflowSha}:${now}`);

    const manifest = {
      workflowId: "local-speech-indextts2",
      version: "1.0.0",
      capability: "audio",
      displayName: "IndexTTS2 声音克隆",
      description: "基于 IndexTTS2 的本地声音克隆与合成工作流",
      author: "system",
      createdAt: new Date(now).toISOString(),
    };

    const compiledBindings = {
      "{{text}}": { node: "2", field: "text" },
      "{{speed}}": { node: "2", field: "speed" },
      "{{voiceProfilePath}}": { node: "1", field: "voice_profile_path" },
    };

    const packageLock = {
      workflowSha256: workflowSha,
      environmentLock: "local-comfyui-speech-v1",
      nodeVersions: {
        IndexTTS2Loader: "1.0.0",
        IndexTTS2Synthesizer: "1.0.0",
        SaveAudio: "1.0.0",
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
      environmentLockDigest: sha256("local-comfyui-speech-v1"),
      createdAtMs: now,
    });

    console.log(`  ✓ Workflow package revision created: ${workflowDigest}`);
    console.log(`    Workflow ID: ${manifest.workflowId}`);
    console.log(`    Version: ${manifest.version}\n`);
  }

  // 4. 创建工作流包状态（初始为 installed，如果不存在）
  console.log("📋 Creating workflow package state...");
  const [existingWorkflowState] = await db
    .select()
    .from(workflowPackageStates)
    .where(eq(workflowPackageStates.workflowPackageDigest, workflowDigest))
    .limit(1);

  if (existingWorkflowState) {
    console.log(`  ✓ Workflow package state already exists: ${existingWorkflowState.state}\n`);
  } else {
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
  }

  // 5. 创建生成配置修订版（如果不存在）
  console.log("⚙️  Creating generation profile revision...");
  const [existingProfile] = await db
    .select()
    .from(generationProfileRevisions)
    .where(eq(generationProfileRevisions.adapterKind, "local-speech"))
    .limit(1);

  let profileRevisionId: string;
  let profileRevisionDigest: string;
  let configJson: Record<string, unknown>;

  if (existingProfile) {
    profileRevisionId = existingProfile.id;
    profileRevisionDigest = existingProfile.revisionDigest;
    configJson = existingProfile.configJson as Record<string, unknown>;
    console.log(`  ✓ Generation profile revision already exists: ${profileRevisionId}`);
    console.log(`    Digest: ${profileRevisionDigest}\n`);
  } else {
    profileRevisionId = genId();
    profileRevisionDigest = sha256(`${profileRevisionId}:${now}`);

    configJson = {
      displayName: "IndexTTS2 声音克隆",
      description: "基于 IndexTTS2 的本地声音克隆生成配置",
      defaultParameters: {
        speed: 1.0,
        outputFormat: "wav",
        sampleRate: 22050,
      },
      allowedOverrides: ["speed", "outputFormat"],
      timeoutMs: 600_000,
      maxRetries: 2,
      securityPolicyVersion: "1.0.0",
      outputLimits: {
        maxDurationSeconds: 60,
        maxFileSizeBytes: 50 * 1024 * 1024,
      },
    };

    await db.insert(generationProfileRevisions).values({
      id: profileRevisionId,
      profileKey: "local-speech-indextts2",
      revisionNo: 1,
      revisionDigest: profileRevisionDigest,
      displayName: "IndexTTS2 声音克隆",
      capability: "speech",
      adapterKind: "local-speech",
      executionBackendId: backendId,
      workflowPackageDigest: workflowDigest,
      configJson,
      createdBy: "system",
      createdAtMs: now,
    });

    console.log(`  ✓ Generation profile revision created: ${profileRevisionId}`);
    console.log(`    Digest: ${profileRevisionDigest}\n`);
  }

  // 6. 创建生成配置状态（初始为禁用，如果不存在）
  console.log("🔒 Creating generation profile state...");
  const [existingProfileState] = await db
    .select()
    .from(generationProfileStates)
    .where(eq(generationProfileStates.generationProfileRevisionId, profileRevisionId))
    .limit(1);

  if (existingProfileState) {
    console.log(`  ✓ Generation profile state already exists: enabled=${existingProfileState.enabled}\n`);
  } else {
    await db.insert(generationProfileStates).values({
      generationProfileRevisionId: profileRevisionId,
      state: "draft",
      enabled: 0,
      visibility: "admin",
      updatedAtMs: now,
    });
    console.log(`  ✓ Generation profile state: draft (disabled)\n`);
  }

  // 7. 设置为全局默认音频配置（可选）
  console.log("🎯 Setting as default audio profile...");
  const [existingPointer] = await db
    .select()
    .from(defaultGenerationProfilePointers)
    .where(eq(defaultGenerationProfilePointers.capability, "audio"))
    .limit(1);

  if (!existingPointer) {
    await db.insert(defaultGenerationProfilePointers).values({
      scopeType: "global",
      scopeId: "default",
      capability: "audio",
      generationProfileRevisionId: profileRevisionId,
      createdAtMs: now,
      updatedAtMs: now,
    });
    console.log(`  ✓ Set as global default audio profile\n`);
  } else {
    console.log(`  ⚠ Default audio profile already exists, skipping\n`);
  }

  console.log("✅ Local speech workflow seed completed successfully!\n");
  console.log("📌 Summary:");
  console.log(`   Resource Pool: ${resourcePoolId}`);
  console.log(`   Backend: ${backendId} (local-speech)`);
  console.log(`   Workflow: ${manifest.workflowId} v${manifest.version}`);
  console.log(`   Profile: ${configJson.displayName} (${profileRevisionId})`);
  console.log(`   State: draft (disabled)`);
  console.log(`   Features: Voice cloning, Multi-language, Long text support`);
  console.log("\n🎉 Run 'npm run promote:local-speech' to activate the workflow!\n");
}

seedLocalSpeechWorkflow()
  .then(() => {
    console.log("🎉 Local speech seed script completed");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Seed script failed:", err);
    process.exit(1);
  });
