/**
 * v2.0 生成配置查询 API
 *
 * 手册 §17.1：用户选择生成配置，不选择裸模型
 * GET /api/generation/profiles - 获取可用的生成配置列表
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  generationProfileRevisions,
  generationProfileStates,
} from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { isEnabled, FF } from "@/lib/feature-flags";
import type { Capability } from "@/lib/generation/naming";

/** GET /api/generation/profiles?capability=image - 获取可用的生成配置 */
export async function GET(req: NextRequest) {
  if (!isEnabled(FF.V2_GENERATION_PROFILES)) {
    return NextResponse.json(
      { error: "v2.0 generation profiles is not enabled" },
      { status: 403 }
    );
  }

  const userId = getUserIdFromRequest(req);
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const capability = searchParams.get("capability") as Capability | null;

  try {
    // 查询已启用的生成配置
    const query = db
      .select({
        id: generationProfileRevisions.id,
        profileKey: generationProfileRevisions.profileKey,
        displayName: generationProfileRevisions.displayName,
        capability: generationProfileRevisions.capability,
        adapterKind: generationProfileRevisions.adapterKind,
        configJson: generationProfileRevisions.configJson,
        enabled: generationProfileStates.enabled,
        visibility: generationProfileStates.visibility,
      })
      .from(generationProfileRevisions)
      .innerJoin(
        generationProfileStates,
        eq(
          generationProfileRevisions.id,
          generationProfileStates.generationProfileRevisionId
        )
      );

    // 按能力过滤
    const whereConditions = [eq(generationProfileStates.enabled, 1)];
    if (capability) {
      whereConditions.push(
        eq(generationProfileRevisions.capability, capability)
      );
    }

    const profiles = await query.where(and(...whereConditions));

    // 转换为前端友好的格式
    const result = profiles.map((p) => ({
      id: p.id,
      profileKey: p.profileKey,
      displayName: p.displayName,
      capability: p.capability,
      adapterKind: p.adapterKind,
      isLocal: p.adapterKind === "zimage" || p.adapterKind === "local-speech",
      config: p.configJson,
    }));

    return NextResponse.json({ profiles: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Generation Profiles API] Get error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
