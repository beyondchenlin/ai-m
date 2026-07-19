import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  createGenerationJob: vi.fn(),
}));

vi.mock("@/lib/feature-flags", () => ({
  isEnabled: () => true,
  isEnabledForProject: () => true,
  FF: { V2_DURABLE_EXECUTION: "V2_DURABLE_EXECUTION" },
}));

vi.mock("@/lib/get-user-id", () => ({
  getUserIdFromRequest: vi.fn(async () => "route-user"),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => [{ id: "route-project", userId: "route-user" }],
      }),
    }),
  },
}));

vi.mock("@/lib/generation/jobs/service", () => {
  class GenerationJobServiceError extends Error {
    constructor(
      message: string,
      readonly status: 400 | 404 | 409 | 413,
      readonly code: string,
    ) {
      super(message);
    }
  }
  return {
    createGenerationJob: mocks.createGenerationJob,
    listGenerationJobs: vi.fn(),
    GenerationJobServiceError,
  };
});

import { GenerationJobServiceError } from "@/lib/generation/jobs/service";
import { POST } from "../route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/generation/jobs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/generation/jobs validation mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects route-shape errors before calling the generation service", async () => {
    const response = await POST(request({
      capability: "image",
      profileRevisionId: "profile",
      projectId: "route-project",
      request: { prompt: "hello" },
      unexpected: true,
    }));
    expect(response.status).toBe(400);
    expect(mocks.createGenerationJob).not.toHaveBeenCalled();
  });

  it.each([
    [400, "workflow_input_unknown"],
    [413, "workflow_input_too_deep"],
  ] as const)("preserves service status %s and stable code", async (status, code) => {
    mocks.createGenerationJob.mockRejectedValueOnce(
      new GenerationJobServiceError("Workflow input rejected", status, code),
    );
    const response = await POST(request({
      capability: "image",
      profileRevisionId: "profile",
      projectId: "route-project",
      request: { prompt: "hello" },
    }));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      error: "Workflow input rejected",
      code,
    });
  });
});
