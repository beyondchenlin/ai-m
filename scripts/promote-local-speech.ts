/**
 * 本地声音工作流晋级脚本
 *
 * 将声音工作流晋级到生产可用状态：
 * - 工作流包：installed → validating → reviewed → active
 * - 生成配置：draft → published，禁用 → 启用，可见性 admin → workspace
 *
 * 运行方式：npm run promote:local-speech
 */

import { db } from "@/lib/db";
import {
  workflowPackageRevisions,
  workflowPackageStates,
  generationProfileRevisions,
  generationProfileStates,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";

async function promoteLocalSpeechWorkflow() {
  console.log("🚀 Starting local speech workflow promotion...\n");

  const now = Date.now();

  // 1. 查找声音工作流包
  console.log("📦 Finding speech workflow package...");
  const [workflow] = await db
    .select()
    .from(workflowPackageRevisions)
    .where(eq(workflowPackageRevisions.workflowId, "local-speech-indextts2"))
    .limit(1);

  if (!workflow) {
    throw new Error("Speech workflow package not found. Run seed:local-speech first");
  }

  console.log(`  ✓ Found workflow: ${workflow.workflowId} v${workflow.version}`);
  console.log(`    Digest: ${workflow.digest}\n`);

  // 2. 晋级工作流包状态
  console.log("📈 Promoting workflow package state...");
  const [workflowState] = await db
    .select()
    .from(workflowPackageStates)
    .where(eq(workflowPackageStates.workflowPackageDigest, workflow.digest));

  if (!workflowState) {
    throw new Error("Speech workflow package state not found");
  }

  console.log(`  Current state: ${workflowState.state}`);

  // 晋级路径：installed → validating → reviewed → active
  const promotionPath = ["installed", "validating", "reviewed", "active"];
  const currentIndex = promotionPath.indexOf(workflowState.state);

  if (currentIndex === -1) {
    throw new Error(`Invalid workflow state: ${workflowState.state}`);
  }

  if (currentIndex === promotionPath.length - 1) {
    console.log("  ✓ Workflow already at active state\n");
  } else {
    for (let i = currentIndex + 1; i < promotionPath.length; i++) {
      const nextState = promotionPath[i];
      console.log(`  → Promoting to: ${nextState}`);

      await db
        .update(workflowPackageStates)
        .set({
          state: nextState,
          validationReportJson: {
            ...((workflowState.validationReportJson as Record<string, unknown>) || {}),
            promotedAt: new Date(now).toISOString(),
            promotedBy: "system",
          },
          reviewedBy: nextState === "reviewed" ? "system" : workflowState.reviewedBy,
          reviewedAtMs: nextState === "reviewed" ? now : workflowState.reviewedAtMs,
          updatedAtMs: now,
        })
        .where(eq(workflowPackageStates.workflowPackageDigest, workflow.digest));

      console.log(`    ✓ State updated to: ${nextState}`);
    }
    console.log("  ✓ Speech workflow package promoted to active\n");
  }

  // 3. 查找声音生成配置
  console.log("⚙️  Finding speech generation profile...");
  const [profile] = await db
    .select()
    .from(generationProfileRevisions)
    .where(eq(generationProfileRevisions.adapterKind, "local-speech"))
    .limit(1);

  if (!profile) {
    throw new Error("Speech generation profile not found");
  }

  console.log(`  ✓ Found profile: ${(profile.configJson as any).displayName}`);
  console.log(`    ID: ${profile.id}\n`);

  // 4. 晋级生成配置状态
  console.log("🔓 Enabling speech generation profile...");
  const [profileState] = await db
    .select()
    .from(generationProfileStates)
    .where(eq(generationProfileStates.generationProfileRevisionId, profile.id));

  if (!profileState) {
    throw new Error("Speech generation profile state not found");
  }

  console.log(`  Current state: ${profileState.state}, enabled: ${profileState.enabled}`);

  if (profileState.enabled && profileState.visibility === "workspace") {
    console.log("  ✓ Profile already enabled and visible\n");
  } else {
    await db
      .update(generationProfileStates)
      .set({
        state: "published",
        enabled: 1,
        visibility: "workspace",
        updatedAtMs: now,
      })
      .where(eq(generationProfileStates.generationProfileRevisionId, profile.id));

    console.log("  ✓ Profile enabled and visible to workspace\n");
  }

  console.log("✅ Local speech workflow promotion completed successfully!\n");
  console.log("📌 Summary:");
  console.log(`   Workflow: ${workflow.workflowId} v${workflow.version} → active`);
  console.log(`   Profile: ${(profile.configJson as any).displayName} → enabled (workspace)`);
  console.log(`   Features: Voice cloning, Multi-language, Long text support`);
  console.log("\n🎉 Users can now select speech profile in the model picker!\n");
}

promoteLocalSpeechWorkflow()
  .then(() => {
    console.log("🎉 Local speech promotion script completed");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Promotion script failed:", err);
    process.exit(1);
  });
