/** Authorized, range-aware artifact streaming endpoint. */
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  generationArtifacts,
  generationAttempts,
  generationJobs,
  projects,
} from "@/lib/db/schema";
import { FF, isEnabled } from "@/lib/feature-flags";
import { resolveArtifactStoragePath } from "@/lib/generation/archiving";
import { getUserIdFromRequest } from "@/lib/get-user-id";

interface ByteRange {
  start: number;
  end: number;
}

function parseRange(header: string | null, size: number): ByteRange | null {
  if (!header) return null;
  if (header.includes(",")) throw new Error("multiple_ranges_not_supported");
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) throw new Error("invalid_range");
  const [, startText, endText] = match;
  if (!startText && !endText) throw new Error("invalid_range");

  let start: number;
  let end: number;
  if (!startText) {
    const suffixLength = Number.parseInt(endText, 10);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw new Error("invalid_range");
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number.parseInt(startText, 10);
    end = endText ? Number.parseInt(endText, 10) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
    throw new Error("range_not_satisfiable");
  }
  return { start, end: Math.min(end, size - 1) };
}

/** GET /api/generation/artifacts/{id} */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isEnabled(FF.V2_MEDIA_ARCHIVING)) {
    return NextResponse.json({ error: "Media archiving is not enabled" }, { status: 403 });
  }
  const userId = await getUserIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) {
    return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
  }

  try {
    const [authorized] = await db.select({ artifact: generationArtifacts })
      .from(generationArtifacts)
      .innerJoin(generationAttempts, eq(generationAttempts.id, generationArtifacts.attemptId))
      .innerJoin(generationJobs, eq(generationJobs.id, generationAttempts.jobId))
      .innerJoin(projects, eq(projects.id, generationJobs.projectId))
      .where(and(eq(generationArtifacts.id, id), eq(projects.userId, userId)))
      .limit(1);
    if (!authorized) return NextResponse.json({ error: "Artifact not found" }, { status: 404 });

    const artifact = authorized.artifact;
    if (artifact.status !== "COMMITTED") {
      return NextResponse.json({ error: "Artifact is not available" }, { status: 410 });
    }

    const filePath = resolveArtifactStoragePath(artifact.storageKey);
    const fileStat = await lstat(filePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size !== artifact.sizeBytes) {
      console.error("[generation/artifacts] committed artifact failed storage consistency check", {
        artifactId: artifact.id,
        expectedSize: artifact.sizeBytes,
        actualSize: fileStat.size,
      });
      return NextResponse.json({ error: "Artifact storage is inconsistent" }, { status: 409 });
    }

    let range: ByteRange | null;
    try {
      range = parseRange(req.headers.get("range"), fileStat.size);
    } catch {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${fileStat.size}`, "Accept-Ranges": "bytes" },
      });
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? fileStat.size - 1;
    const length = end - start + 1;
    const nodeStream = createReadStream(filePath, { start, end });
    const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    const headers = new Headers({
      "Content-Type": artifact.mimeType,
      "Content-Length": String(length),
      "Accept-Ranges": "bytes",
      "Cache-Control": artifact.visibility === "private-original"
        ? "private, no-store"
        : "private, max-age=3600",
      ETag: `"sha256-${artifact.sha256}"`,
      "X-Content-Type-Options": "nosniff",
    });
    if (range) headers.set("Content-Range", `bytes ${start}-${end}/${fileStat.size}`);
    return new Response(body, { status: range ? 206 : 200, headers });
  } catch (error) {
    console.error("[generation/artifacts] download failed", {
      artifactId: id,
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ error: "Artifact download failed" }, { status: 500 });
  }
}
