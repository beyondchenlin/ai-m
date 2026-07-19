/** Durable generation-job API. Long-running inference is executed only by the worker. */
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import type { CreateGenerationJobInput } from "@/lib/generation/contracts";
import { createGenerationJob, GenerationJobServiceError, listGenerationJobs } from "@/lib/generation/jobs/service";
import { FF, isEnabled } from "@/lib/feature-flags";
import {
  assertPlainObject,
  readEnum,
  readOptionalString,
  readRecord,
  readRequiredString,
  rejectUnknownKeys,

  readJsonBodyLimited,
  RequestValidationError,
  assertTrustedRequestOrigin,
} from "@/lib/security";

const CAPABILITIES = ["text", "image", "video", "speech", "utility"] as const;

function badRequest(error: unknown): NextResponse {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Invalid request" },
    { status: 400 },
  );
}

async function requireOwnedProject(projectId: string, userId: string) {
  const [project] = await db.select().from(projects).where(and(
    eq(projects.id, projectId),
    eq(projects.userId, userId),
  ));
  if (!project) return { error: NextResponse.json({ error: "Project not found" }, { status: 404 }) };
  return { project };
}

export async function POST(req: NextRequest) {
  if (!isEnabled(FF.V2_DURABLE_EXECUTION)) {
    return NextResponse.json({ error: "v2.0 durable execution is not enabled" }, { status: 403 });
  }
  const userId = await getUserIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    assertTrustedRequestOrigin(req);
    if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new RequestValidationError("Content-Type must be application/json");
    }
    const body: unknown = await readJsonBodyLimited(req);
    assertPlainObject(body);
    rejectUnknownKeys(body, [
      "capability",
      "profileRevisionId",
      "projectId",
      "request",
      "businessContext",
      "idempotencyKey",
    ]);

    const capability = readEnum(body, "capability", CAPABILITIES);
    const profileRevisionId = readRequiredString(body, "profileRevisionId", { maxLength: 160 });
    const projectId = readRequiredString(body, "projectId", { maxLength: 160 });
    const request = readRecord(body, "request");
    if (!request) throw new Error("request is required");

    const businessContext = readRecord(body, "businessContext");
    if (businessContext) rejectUnknownKeys(businessContext, ["kind", "id"]);

    const bodyKey = readOptionalString(body, "idempotencyKey", { maxLength: 160 });
    const headerKey = req.headers.get("idempotency-key")?.trim() || undefined;
    if (headerKey && headerKey.length > 160) throw new Error("idempotency-key is too long");
    if (bodyKey && headerKey && bodyKey !== headerKey) throw new Error("Conflicting idempotency keys");

    const ownership = await requireOwnedProject(projectId, userId);
    if (ownership.error) return ownership.error;

    const input: CreateGenerationJobInput = {
      capability,
      profileRevisionId,
      projectId,
      request: request as unknown as CreateGenerationJobInput["request"],
      idempotencyKey: bodyKey || headerKey,
      businessContext: businessContext
        ? {
            kind: readRequiredString(businessContext, "kind", { maxLength: 80 }),
            id: readRequiredString(businessContext, "id", { maxLength: 160 }),
          }
        : undefined,
    };

    const job = await createGenerationJob(input, { userId, roles: ["user"] });
    return NextResponse.json({ job }, { status: 201 });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof GenerationJobServiceError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    if (error instanceof SyntaxError || (error instanceof Error && /required|unknown|invalid|too long|conflicting/i.test(error.message))) {
      return badRequest(error);
    }
    const message = error instanceof Error ? error.message : "Generation job creation failed";
    console.error("[generation/jobs] create failed", { message });
    return NextResponse.json({ error: "Generation job creation failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  if (!isEnabled(FF.V2_DURABLE_EXECUTION)) {
    return NextResponse.json({ error: "v2.0 durable execution is not enabled" }, { status: 403 });
  }
  const userId = await getUserIdFromRequest(req);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get("projectId")?.trim();
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });

  const requestedLimit = Number.parseInt(searchParams.get("limit") ?? "20", 10);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 20;
  const ownership = await requireOwnedProject(projectId, userId);
  if (ownership.error) return ownership.error;

  const jobs = await listGenerationJobs(projectId, { userId, roles: ["user"] }, limit);
  return NextResponse.json({ jobs });
}
