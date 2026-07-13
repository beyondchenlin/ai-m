/**
 * PR-08: 视觉主体种子数据脚本
 * 
 * 创建示例视觉主体，用于测试和演示：
 * - 人类角色（带身份锚点、可变槽位、禁止特征）
 * - 卡通角色（简化版本）
 * - 动物角色（带多角度参考）
 */

import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { createVisualSubject } from "@/lib/generation/visual-subjects";
import { id as genId } from "@/lib/id";
import { getSqlite } from "@/lib/db";

async function seedVisualSubjects() {
  console.log("🌱 Starting visual subjects seed...\n");

  // 手动创建表（如果不存在）
  console.log("📋 Ensuring visual_subjects tables exist...");
  const sqlite = getSqlite();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS visual_subjects (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      character_id TEXT,
      identity_anchors_json TEXT NOT NULL,
      variable_slots_json TEXT NOT NULL,
      forbidden_features_json TEXT NOT NULL,
      multi_angle_references_json TEXT NOT NULL,
      current_version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS visual_subject_versions (
      id TEXT PRIMARY KEY NOT NULL,
      visual_subject_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (visual_subject_id) REFERENCES visual_subjects(id) ON DELETE CASCADE
    );
  `);
  console.log("  ✓ Tables ready\n");

  // 查找或创建测试项目
  console.log("📦 Finding test project...");
  let [testProject] = await db
    .select()
    .from(projects)
    .where(eq(projects.title, "视觉主体测试项目"))
    .limit(1);

  let projectId: string;
  if (testProject) {
    projectId = testProject.id;
    console.log(`  ✓ Using existing project: ${projectId}\n`);
  } else {
    projectId = genId();
    await db.insert(projects).values({
      id: projectId,
      userId: "test-user-pr08",
      title: "视觉主体测试项目",
      idea: "用于测试视觉主体功能的项目",
      description: "PR-08 视觉主体预留功能测试",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log(`  ✓ Created test project: ${projectId}\n`);
  }

  // 创建人类角色示例
  console.log("👤 Creating human visual subject...");
  const humanSubject = await createVisualSubject({
    name: "主角 - 李明",
    type: "human",
    description: "故事的主角，一个年轻的程序员",
    projectId,
    userId: "test-user-pr08",
    identityAnchors: [
      {
        name: "脸部特征",
        description: "方脸，浓眉，单眼皮，高鼻梁",
        referenceArtifactIds: [],
        weight: 1.0,
        required: true,
      },
      {
        name: "体型特征",
        description: "身高 175cm，中等体型，偏瘦",
        referenceArtifactIds: [],
        weight: 0.8,
        required: true,
      },
      {
        name: "发型特征",
        description: "黑色短发，略微凌乱",
        referenceArtifactIds: [],
        weight: 0.9,
        required: true,
      },
    ],
    variableSlots: [
      {
        name: "服装",
        type: "clothing",
        defaultValue: "蓝色格子衬衫",
        options: ["蓝色格子衬衫", "黑色 T 恤", "白色衬衫", "西装"],
        currentValue: "蓝色格子衬衫",
      },
      {
        name: "表情",
        type: "expression",
        defaultValue: "平静",
        options: ["平静", "微笑", "严肃", "惊讶", "思考"],
        currentValue: "平静",
      },
      {
        name: "姿势",
        type: "pose",
        defaultValue: "站立",
        options: ["站立", "坐姿", "行走", "跑步"],
        currentValue: "站立",
      },
    ],
    forbiddenFeatures: [
      {
        description: "不能戴眼镜",
        severity: "high",
        enabled: true,
      },
      {
        description: "不能有胡子",
        severity: "medium",
        enabled: true,
      },
      {
        description: "不能有纹身",
        severity: "low",
        enabled: false,
      },
    ],
    multiAngleReferences: [],
  });
  console.log(`  ✓ Human subject created: ${humanSubject.id}`);
  console.log(`    Identity anchors: ${humanSubject.identityAnchors.length}`);
  console.log(`    Variable slots: ${humanSubject.variableSlots.length}`);
  console.log(`    Forbidden features: ${humanSubject.forbiddenFeatures.length}\n`);

  // 创建卡通角色示例
  console.log("🎨 Creating cartoon visual subject...");
  const cartoonSubject = await createVisualSubject({
    name: "吉祥物 - 小 AI",
    type: "cartoon",
    description: "项目的卡通吉祥物，一个可爱的机器人形象",
    projectId,
    userId: "test-user-pr08",
    identityAnchors: [
      {
        name: "整体造型",
        description: "圆润的蓝色机器人，大眼睛，天线",
        referenceArtifactIds: [],
        weight: 1.0,
        required: true,
      },
    ],
    variableSlots: [
      {
        name: "颜色",
        type: "custom",
        defaultValue: "蓝色",
        options: ["蓝色", "红色", "绿色", "金色"],
        currentValue: "蓝色",
      },
      {
        name: "表情",
        type: "expression",
        defaultValue: "开心",
        options: ["开心", "思考", "惊讶", "困倦"],
        currentValue: "开心",
      },
    ],
    forbiddenFeatures: [
      {
        description: "不能有尖锐的边缘",
        severity: "high",
        enabled: true,
      },
    ],
    multiAngleReferences: [],
  });
  console.log(`  ✓ Cartoon subject created: ${cartoonSubject.id}`);
  console.log(`    Identity anchors: ${cartoonSubject.identityAnchors.length}`);
  console.log(`    Variable slots: ${cartoonSubject.variableSlots.length}\n`);

  // 创建动物角色示例
  console.log("🐱 Creating animal visual subject...");
  const animalSubject = await createVisualSubject({
    name: "宠物 - 小花猫",
    type: "animal",
    description: "故事中的宠物猫，一只橘色条纹猫",
    projectId,
    userId: "test-user-pr08",
    identityAnchors: [
      {
        name: "毛色花纹",
        description: "橘色底色，深橙色条纹，白色胸口",
        referenceArtifactIds: [],
        weight: 1.0,
        required: true,
      },
      {
        name: "眼睛颜色",
        description: "绿色眼睛",
        referenceArtifactIds: [],
        weight: 0.9,
        required: true,
      },
    ],
    variableSlots: [
      {
        name: "姿势",
        type: "pose",
        defaultValue: "坐姿",
        options: ["坐姿", "趴下", "站立", "跳跃"],
        currentValue: "坐姿",
      },
    ],
    forbiddenFeatures: [
      {
        description: "不能有项圈",
        severity: "medium",
        enabled: false,
      },
    ],
    multiAngleReferences: [],
  });
  console.log(`  ✓ Animal subject created: ${animalSubject.id}`);
  console.log(`    Identity anchors: ${animalSubject.identityAnchors.length}`);
  console.log(`    Variable slots: ${animalSubject.variableSlots.length}\n`);

  // 测试更新视觉主体（创建新版本）
  console.log("🔄 Testing version update...");
  const { updateVisualSubject } = await import("@/lib/generation/visual-subjects");
  const updatedSubject = await updateVisualSubject(
    humanSubject.id,
    {
      variableSlots: [
        {
          name: "服装",
          type: "clothing",
          defaultValue: "蓝色格子衬衫",
          options: ["蓝色格子衬衫", "黑色 T 恤", "白色衬衫", "西装", "卫衣"],
          currentValue: "卫衣",
        },
        {
          name: "表情",
          type: "expression",
          defaultValue: "平静",
          options: ["平静", "微笑", "严肃", "惊讶", "思考"],
          currentValue: "微笑",
        },
      ],
    },
    "test-user-pr08"
  );
  console.log(`  ✓ Subject updated to version ${updatedSubject?.currentVersion}`);
  console.log(`    Updated slots: ${updatedSubject?.variableSlots.length}\n`);

  // 测试生成负面提示词
  console.log("🚫 Testing negative prompt generation...");
  const { generateNegativePrompt } = await import("@/lib/generation/visual-subjects");
  const negativePrompt = generateNegativePrompt(humanSubject);
  console.log(`  ✓ Negative prompt: "${negativePrompt}"\n`);

  // 测试生成参考图配置
  console.log("📸 Testing reference config generation...");
  const { generateReferenceConfig } = await import("@/lib/generation/visual-subjects");
  const refConfig = generateReferenceConfig(humanSubject);
  console.log(`  ✓ Reference config:`);
  console.log(`    Primary reference: ${refConfig.primaryReferenceId || "none"}`);
  console.log(`    Total references: ${refConfig.allReferenceIds.length}`);
  console.log(`    Anchor weights: ${Object.keys(refConfig.anchorWeights).length}\n`);

  console.log("✅ Visual subjects seed completed successfully!\n");
  console.log("📌 Summary:");
  console.log(`   Project: ${projectId}`);
  console.log(`   Human subject: ${humanSubject.id}`);
  console.log(`   Cartoon subject: ${cartoonSubject.id}`);
  console.log(`   Animal subject: ${animalSubject.id}`);
  console.log(`   Total subjects: 3`);
  console.log("\n🎉 Visual subject infrastructure is ready for PR-08!\n");
}

seedVisualSubjects()
  .then(() => {
    console.log("🎉 Seed script completed");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Seed script failed:", err);
    process.exit(1);
  });
