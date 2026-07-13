/**
 * PR-10: 视觉主体晋级脚本
 * 
 * 将测试项目中的视觉主体晋级到生产环境：
 * - 复制视觉主体及其版本历史
 * - 保留所有身份锚点、可变槽位、禁止特征和多角度参考
 * - 更新项目关联
 */

import { db } from "@/lib/db";
import { visualSubjects, visualSubjectVersions, projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { id as genId } from "@/lib/id";

async function promoteVisualSubjects() {
  console.log("🚀 Starting visual subjects promotion...\n");

  // 查找测试项目
  const [testProject] = await db
    .select()
    .from(projects)
    .where(eq(projects.title, "视觉主体测试项目"))
    .limit(1);

  if (!testProject) {
    console.log("❌ Test project not found. Run seed-visual-subjects.ts first.");
    process.exit(1);
  }

  console.log(`✓ Found test project: ${testProject.id}\n`);

  // 查找目标生产项目
  const [prodProject] = await db
    .select()
    .from(projects)
    .where(eq(projects.title, "生产项目"))
    .limit(1);

  if (!prodProject) {
    console.log("❌ Production project not found.");
    process.exit(1);
  }

  console.log(`✓ Found production project: ${prodProject.id}\n`);

  // 查询测试项目的所有视觉主体
  const testSubjects = await db
    .select()
    .from(visualSubjects)
    .where(eq(visualSubjects.projectId, testProject.id));

  console.log(`📦 Found ${testSubjects.length} visual subjects to promote\n`);

  let promotedCount = 0;

  for (const subject of testSubjects) {
    console.log(`Promoting: ${subject.name} (${subject.type})`);

    // 检查是否已存在同名视觉主体
    const [existing] = await db
      .select()
      .from(visualSubjects)
      .where(eq(visualSubjects.name, subject.name))
      .limit(1);

    if (existing) {
      console.log(`  ⚠️  Already exists in production, skipping\n`);
      continue;
    }

    // 创建新的视觉主体 ID
    const newSubjectId = genId();

    // 复制视觉主体到生产项目
    await db.insert(visualSubjects).values({
      id: newSubjectId,
      name: subject.name,
      type: subject.type,
      description: subject.description,
      projectId: prodProject.id,
      userId: subject.userId,
      characterId: subject.characterId,
      identityAnchorsJson: subject.identityAnchorsJson,
      variableSlotsJson: subject.variableSlotsJson,
      forbiddenFeaturesJson: subject.forbiddenFeaturesJson,
      multiAngleReferencesJson: subject.multiAngleReferencesJson,
      currentVersion: subject.currentVersion,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    console.log(`  ✓ Created new visual subject: ${newSubjectId}`);

    // 复制版本历史
    const versions = await db
      .select()
      .from(visualSubjectVersions)
      .where(eq(visualSubjectVersions.visualSubjectId, subject.id));

    for (const version of versions) {
      await db.insert(visualSubjectVersions).values({
        id: genId(),
        visualSubjectId: newSubjectId,
        version: version.version,
        snapshotJson: version.snapshotJson,
        createdBy: version.createdBy,
        createdAt: version.createdAt,
      });
    }

    console.log(`  ✓ Copied ${versions.length} version(s)\n`);
    promotedCount++;
  }

  console.log("✅ Visual subjects promotion completed successfully!\n");
  console.log("📌 Summary:");
  console.log(`   Source project: ${testProject.id}`);
  console.log(`   Target project: ${prodProject.id}`);
  console.log(`   Promoted subjects: ${promotedCount}`);
  console.log(`   Skipped (already exists): ${testSubjects.length - promotedCount}`);
  console.log("\n🎉 Visual subjects are now available in production!\n");
}

promoteVisualSubjects()
  .then(() => {
    console.log("🎉 Promotion script completed");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Promotion script failed:", err);
    process.exit(1);
  });
