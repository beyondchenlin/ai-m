import { NextResponse } from "next/server";
import { assertProjectOwnership } from "@/lib/assert-project-ownership";
import { FF, isEnabled } from "@/lib/feature-flags";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import {
  importVoiceReferenceStream,
  MAX_VOICE_REFERENCE_BYTES,
  SourceAssetError,
} from "@/lib/generation/source-assets";
import { assertTrustedRequestOrigin, RequestValidationError } from "@/lib/security";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isEnabled(FF.V2_LOCAL_SPEECH)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { id: projectId } = await params;
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
  if (!request.body) return NextResponse.json({ error: "Audio body is required" }, { status: 400 });

  const lengthHeader = request.headers.get("content-length");
  let declaredSize: number | undefined;
  if (lengthHeader) {
    declaredSize = Number(lengthHeader);
    if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0) {
      return NextResponse.json({ error: "Invalid Content-Length" }, { status: 400 });
    }
    if (declaredSize > MAX_VOICE_REFERENCE_BYTES) {
      return NextResponse.json({ error: "Reference audio exceeds 50 MB" }, { status: 413 });
    }
  }

  const filenameHeader = request.headers.get("x-ai-m-filename") ?? "voice-reference";
  let originalName = filenameHeader;
  try {
    originalName = decodeURIComponent(filenameHeader);
  } catch {
    return NextResponse.json({ error: "Filename header is invalid" }, { status: 400 });
  }
  if (originalName.length > 240) return NextResponse.json({ error: "Filename is too long" }, { status: 400 });

  try {
    const asset = await importVoiceReferenceStream({
      projectId,
      userId,
      stream: request.body,
      originalName,
      declaredSize,
      signal: request.signal,
    });
    return NextResponse.json({ asset }, { status: 201 });
  } catch (error) {
    if (error instanceof SourceAssetError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("[source-assets/audio] upload failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ error: "Reference audio upload failed" }, { status: 500 });
  }
}
