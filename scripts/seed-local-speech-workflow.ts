/**
 * PR-09: 本地声音工作流种子数据
 * 
 * 创建本地声音生成所需的工作流包和生成配置
 */

import { db } from "@/lib/db";
import { workflowPackages, generationProfiles } from "@/lib/db/schema";
import { genId } from "@/lib/utils/id";
import { hash } from "@/lib/utils/hash";

async function seedLocalSpeechWorkflow() {
  console.log("🌱 开始创建本地声音工作流种子数据...\n");

  const workflowId = genId();
  const profileId = genId();
  const now = new Date();

  // 1. 创建工作流包
  const workflowData = {
    id: workflowId,
    workflowId: "local-speech-v1",
    version: "1.0.0",
    capability: "audio",
    adapterKind: "local-speech",
    state: "installed",
    validationReport: {
      structureValid: true,
      staticPolicyValid: true,
      environmentValid: true,
      validatedAt: now.toISOString(),
    },
    compiledBindings: {
      text: "text",
      voiceProfileId: "voice_profile_id",
      speed: "speed",
    },
    packageLock: {
      workflowSha256: "placeholder",
      environmentLock: "local-comfyui-v1",
      nodeVersions: {
        "LoadText": "1.0.0",
        "TTSModel": "1.0.0",
        "SaveAudio": "1.0.0",
      },
    },
    packagePath: "workflows/local-speech-v1/1.0.0",
    workflowSha256: "placeholder",
    environmentLockDigest: "placeholder",
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(workflowPackages).values(workflowData);
  console.log(`✅ 工作流包已创建: ${workflowId}`);
  console.log(`   - workflowId: local-speech-v1`);
  console.log(`   - capability: audio`);
  console.log(`   - adapterKind: local-speech\n`);

  // 2. 创建生成配置
  const profileData = {
    id: profileId,
    profileKey: "local-speech-default",
    revisionNo: 1,
    revisionDigest: "placeholder",
    displayName: "本地声音生成（默认）",
    capability: "audio",
    adapterKind: "local-speech",
    executionBackendId: null,
    workflowPackageId: workflowId,
    configJson: {
      defaultParameters: {
        speed: 1.0,
        sampleRate: 22050,
        audioFormat: "wav",
      },
      timeouts: {
        maxExecutionTimeMs: 120000, // 2分钟
        pollingIntervalMs: 1000,
      },
      limits: {
        maxTextLength: 5000,
        maxAudioDurationMs: 60000, // 1分钟
        allowedSampleRates: [16000, 22050, 44100],
      },
      features: {
        supportsVoiceCloning: true,
        supportsMultiLanguage: true,
        supportsSpeedControl: true,
      },
    },
    enabled: false,
    visibility: "admin",
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(generationProfiles).values(profileData);
  console.log(`✅ 生成配置已创建: ${profileId}`);
  console.log(`   - profileKey: local-speech-default`);
  console.log(`   - displayName: 本地声音生成（默认）`);
  console.log(`   - capability: audio`);
  console.log(`   - enabled: false (待晋级)\n`);

  console.log("📌 下一步:");
  console.log("   运行晋级脚本: npm run promote:local-speech\n");

  return { workflowId, profileId };
}

seedLocalSpeechWorkflow()
  .then(({ workflowId, profileId }) => {
    console.log("✅ 种子数据创建完成");
    console.log(`   工作流ID: ${workflowId}`);
    console.log(`   配置ID: ${profileId}`);
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ 种子数据创建失败:", error);
    process.exit(1);
  });
