/** User-selectable generation profile list. */
import { NextRequest, NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { isEnabled, FF } from "@/lib/feature-flags";
import type { Capability } from "@/lib/generation/naming";
import { getSelectableProfiles } from "@/lib/generation/profiles/service";

export async function GET(req: NextRequest) {
  if (!isEnabled(FF.V2_GENERATION_PROFILES)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const userId = getUserIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const capabilityParam = new URL(req.url).searchParams.get("capability");
  const allowedCapabilities: Capability[] = ["text", "image", "video", "speech", "utility"];
  if (capabilityParam && !allowedCapabilities.includes(capabilityParam as Capability)) {
    return NextResponse.json({ error: "Invalid capability" }, { status: 400 });
  }

  try {
    const profiles = await getSelectableProfiles(capabilityParam as Capability | undefined);
    return NextResponse.json({
      profiles: profiles.map((profile) => ({
        id: profile.id,
        profileKey: profile.profileKey,
        displayName: profile.displayName,
        capability: profile.capability,
        adapterKind: profile.adapterKind,
        isLocal: profile.adapterKind === "comfyui",
      })),
    });
  } catch (error) {
    console.error("[generation/profiles] failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ error: "Generation profiles could not be loaded" }, { status: 500 });
  }
}
