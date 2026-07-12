/**
 * Z-Image 质量工作流晋级脚本
 *
 * 将质量工作流晋级到生产可用状态：
 * - 工作流包：installed → validating → reviewed → active
 * - 生成配置：禁用 → 启用，可见性 admin → workspace
 *
 * 运行方式：npm run promote:zimage-quality
 */

import { db } from "@/lib/db";
import {
  workflowPackageRevisions,
  workflowPackageStates,
  generationProfileRevisions,
  generationProfileStates,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";

async function promoteZImageQualityWorkflow() {
  console.log("🚀 Starting Z-Image quality workflow promotion...\n");

  const now = Date.now();

  // 1. 查找质量工作流包
  console.log("📦 Finding quality workflow package...");
  const [workflow] = await db
    .select()
    .from(workflowPackageRevisions)
    .where(eq(workflowPackageRevisions.workflowId, "zimage-quality-production"))
    .limit(1);

  if (!workflow) {
    throw new Error("Quality workflow package not found. Run seed:zimage-quality first");
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
    throw new Error("Quality workflow package state not found");
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
    console.log("  ✓ Quality workflow package promoted to active\n");
  }

  // 3. 查找质量生成配置
  console.log("⚙️  Finding quality generation profile...");
  const [profile] = await db
    .select()
    .from(generationProfileRevisions)
    .where(eq(generationProfileRevisions.profileKey, "zimage-quality-production"))
    .limit(1);

  if (!profile) {
    throw new Error("Quality generation profile not found. Run seed:zimage-quality first");
  }

  console.log(`  ✓ Found profile: ${profile.displayName}`);
  console.log(`    ID: ${profile.id}\n`);

  // 4. 启用生成配置
  console.log("🔓 Enabling quality generation profile...");
  const [profileState] = await db
    .select()
    .from(generationProfileStates)
    .where(eq(generationProfileStates.generationProfileRevisionId, profile.id));

  if (!profileState) {
    throw new Error("Quality generation profile state not found");
  }

  if (profileState.enabled === 1) {
    console.log("  ✓ Profile already enabled\n");
  } else {
    await db
      .update(generationProfileStates)
      .set({
        enabled: 1,
        visibility: "workspace",
        updatedAtMs: now,
      })
      .where(eq(generationProfileStates.generationProfileRevisionId, profile.id));

    console.log("  ✓ Quality profile enabled (visibility: workspace)\n");
  }

  console.log("✅ Quality workflow promotion completed successfully!\n");
  console.log("📌 Summary:");
  console.log(`   Workflow: ${workflow.workflowId} v${workflow.version} → active`);
  console.log(`   Profile: ${profile.displayName} → enabled (workspace)`);
  console.log(`   Features: Reference images, High quality, Negative prompt\n`);
  console.log("🎉 Users can now select quality profile in the model picker!\n");
}

promoteZImageQualityWorkflow()
  .then(() => {
    console.log("🎉 Quality promotion script completed");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Quality promotion script failed:", err);
    process.exit(1);
  });
