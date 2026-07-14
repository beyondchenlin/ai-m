import { NextResponse } from "next/server";
import { FF, isEnabled } from "@/lib/feature-flags";
import { assertProjectOwnership } from "@/lib/assert-project-ownership";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { deleteVoiceProfile, getVoiceProfile, VoiceProfileError } from "@/lib/generation/voice-profiles";
import { assertTrustedRequestOrigin, RequestValidationError } from "@/lib/security";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; profileId: string }> },
) {
  if (!isEnabled(FF.V2_LOCAL_SPEECH)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { id: projectId, profileId } = await params;
  if (!(await assertProjectOwnership(request, projectId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    assertTrustedRequestOrigin(request);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
  const userId = getUserIdFromRequest(request);
  const profile = await getVoiceProfile(profileId, userId);
  if (!profile || profile.projectId !== projectId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    await deleteVoiceProfile(profileId, userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof VoiceProfileError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("[voice-profiles] deletion failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ error: "Voice profile deletion failed" }, { status: 500 });
  }
}
