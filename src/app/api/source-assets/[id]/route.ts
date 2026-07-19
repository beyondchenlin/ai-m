import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import {
  deleteOwnedSourceAsset,
  getOwnedSourceAsset,
  SourceAssetError,
  verifyOwnedSourceAssetFile,
} from "@/lib/generation/source-assets";
import { assertTrustedRequestOrigin, RequestValidationError } from "@/lib/security";

export const runtime = "nodejs";

function parseSingleRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) throw new SourceAssetError("Invalid Range header", "INVALID_RANGE", 400);
  const startText = match[1];
  const endText = match[2];
  if (!startText && !endText) throw new SourceAssetError("Invalid Range header", "INVALID_RANGE", 400);

  let start: number;
  let end: number;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new SourceAssetError("Invalid Range header", "INVALID_RANGE", 400);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    throw new SourceAssetError("Requested range is not satisfiable", "RANGE_NOT_SATISFIABLE", 400);
  }
  return { start, end: Math.min(end, size - 1) };
}

async function resolveOwnedAsset(request: Request, id: string) {
  try {
    assertTrustedRequestOrigin(request);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return { response: NextResponse.json({ error: error.message }, { status: error.status }) } as const;
    }
    throw error;
  }
  const userId = await getUserIdFromRequest(request);
  if (!userId) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const asset = await getOwnedSourceAsset(id, userId);
  if (!asset) return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) } as const;
  try {
    const filePath = await verifyOwnedSourceAssetFile(asset);
    return { userId, asset, filePath } as const;
  } catch {
    return { response: NextResponse.json({ error: "Source asset is unavailable" }, { status: 410 }) } as const;
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const resolved = await resolveOwnedAsset(request, id);
  if ("response" in resolved) return resolved.response;
  const { asset, filePath } = resolved;
  const etag = `"sha256-${asset.sha256}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, no-store" } });
  }

  let range: { start: number; end: number } | null;
  try {
    range = parseSingleRange(request.headers.get("range"), asset.sizeBytes);
  } catch (error) {
    if (error instanceof SourceAssetError) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${asset.sizeBytes}`, "Accept-Ranges": "bytes" },
      });
    }
    throw error;
  }

  const extension = asset.mimeType === "audio/mpeg" ? "mp3" : "wav";
  const headers: Record<string, string> = {
    "Content-Type": asset.mimeType,
    "Content-Disposition": `inline; filename="voice-reference-${asset.id}.${extension}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    ETag: etag,
  };

  if (range) {
    const length = range.end - range.start + 1;
    headers["Content-Length"] = String(length);
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${asset.sizeBytes}`;
    const body = Readable.toWeb(createReadStream(filePath, { start: range.start, end: range.end })) as ReadableStream<Uint8Array>;
    return new Response(body, { status: 206, headers });
  }

  headers["Content-Length"] = String(asset.sizeBytes);
  const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
  return new Response(body, { headers });
}

export async function HEAD(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const resolved = await resolveOwnedAsset(request, id);
  if ("response" in resolved) return resolved.response;
  const { asset } = resolved;
  return new Response(null, {
    headers: {
      "Content-Type": asset.mimeType,
      "Content-Length": String(asset.sizeBytes),
      "Accept-Ranges": "bytes",
      ETag: `"sha256-${asset.sha256}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertTrustedRequestOrigin(request);
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
  const userId = await getUserIdFromRequest(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const deleted = await deleteOwnedSourceAsset(id, userId, { requireUnreferenced: true });
    if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof SourceAssetError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "Source asset deletion failed" }, { status: 500 });
  }
}
