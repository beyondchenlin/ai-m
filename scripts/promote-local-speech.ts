/**
 * 声音工作流晋级脚本
 * 
 * 将种子数据创建的配置晋级到生产可用状态：
 * - 工作流包：installed → validating → reviewed → active
 * - 生成配置：禁用 → 启用，可见性 admin → workspace
 * - 设为全局默认音频生成配置
 */

import { db } from "@/lib/db";
import {
  workflowPackageRevisions,
  workflowPackageStates,
  generationProfileRevisions,
  generationProfileStates,
  defaultGenerationProfilePointers,
} from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

async function promoteLocalSpeechWorkflow() {
  console.log("🚀 Starting local speech workflow promotion...\n");

  const now = Date.now();

  // 1. 查找声音工作流包
  console.log("📦 Finding local speech workflow package...");
  const [workflow] = await db
    .select()
    .from(workflowPackageRevisions)
    .where(eq(workflowPackageRevisions.workflowId, "local-speech-v1"))
    .limit(1);

  if (!workflow) {
    throw new Error("Local speech workflow package not found. Run seed:local-speech first");
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
    throw new Error("Workflow package state not found");
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
    console.log("  ✓ Workflow package promoted to active\n");
  }

  // 3. 查找声音生成配置
  console.log("⚙️  Finding local speech generation profile...");
  const [profile] = await db
    .select()
    .from(generationProfileRevisions)
    .where(eq(generationProfileRevisions.profileKey, "local-speech-default"))
    .limit(1);

  if (!profile) {
    throw new Error("Local speech generation profile not found. Run seed:local-speech first");
  }

  console.log(`  ✓ Found profile: ${profile.displayName}`);
  console.log(`    ID: ${profile.id}\n`);

  // 4. 启用生成配置
  console.log("🔓 Enabling generation profile...");
  const [profileState] = await db
    .select()
    .from(generationProfileStates)
    .where(eq(generationProfileStates.generationProfileRevisionId, profile.id));

  if (!profileState) {
    throw new Error("Generation profile state not found");
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

    console.log("  ✓ Profile enabled (visibility: workspace)\n");
  }

  // 5. 设为全局默认音频生成配置
  console.log("🎯 Setting as default audio generation profile...");
  const [existingPointer] = await db
    .select()
    .from(defaultGenerationProfilePointers)
    .where(
      and(
        eq(defaultGenerationProfilePointers.scopeType, "global"),
        eq(defaultGenerationProfilePointers.scopeId, "default"),
        eq(defaultGenerationProfilePointers.capability, "audio")
      )
    );

  if (existingPointer) {
    if (existingPointer.generationProfileRevisionId === profile.id) {
      console.log("  ✓ Profile already set as default\n");
    } else {
      await db
        .update(defaultGenerationProfilePointers)
        .set({
          generationProfileRevisionId: profile.id,
          updatedBy: "system",
          updatedAtMs: now,
        })
        .where(
          and(
            eq(defaultGenerationProfilePointers.scopeType, "global"),
            eq(defaultGenerationProfilePointers.scopeId, "default"),
            eq(defaultGenerationProfilePointers.capability, "audio")
          )
        );

      console.log("  ✓ Default pointer updated\n");
    }
  } else {
    await db.insert(defaultGenerationProfilePointers).values({
      scopeType: "global",
      scopeId: "default",
      capability: "audio",
      generationProfileRevisionId: profile.id,
      updatedBy: "system",
      updatedAtMs: now,
    });

    console.log("  ✓ Default pointer created\n");
  }

  console.log("✅ Local speech workflow promotion completed successfully!\n");
  console.log("📌 Summary:");
  console.log(`   Workflow: ${workflow.workflowId} v${workflow.version} → active`);
  console.log(`   Profile: ${profile.displayName} → enabled (workspace)`);
  console.log(`   Default: global audio generation → ${profile.displayName}\n`);
  console.log("🎉 Users can now select this profile for audio generation!\n");
}

promoteLocalSpeechWorkflow()
  .then(() => {
    console.log("🎉 Promotion script completed");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Promotion script failed:", err);
    process.exit(1);
  });
