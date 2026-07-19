import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSqlite } from "@/lib/db";
import { setupTestDb, type TestDbContext } from "@/lib/test-helpers/db";
import {
  AuditAction,
  AuditTargetType,
  sanitizeForLog,
  writeAuditEvent,
} from "../audit";

let context: TestDbContext;

beforeAll(() => {
  context = setupTestDb();
});

afterAll(() => context.cleanup());

describe("audit field allowlists", () => {
  it("projects backend auth metadata through an explicit allowlist", () => {
    expect(sanitizeForLog({
      keyRefId: "safe-reference",
      headerName: "X-Backend-Token",
      secretValue: "must-not-appear",
      futureUnknownField: "must-not-appear",
      nested: { token: "must-not-appear" },
    })).toEqual({
      keyRefId: "safe-reference",
      headerName: "X-Backend-Token",
    });
  });

  it("drops unknown, nested and secret-like audit details before persistence", async () => {
    await writeAuditEvent({
      actorId: "reviewer",
      action: AuditAction.BACKEND_UPDATED,
      targetType: AuditTargetType.BACKEND,
      targetId: "backend",
      detailsSafe: {
        changedFields: ["displayName"],
        invalidatedValidation: true,
        secretValue: "must-not-appear",
        nested: { token: "must-not-appear" },
        futureUnknownField: "must-not-appear",
      },
    });
    const row = getSqlite().prepare<[], { details: string }>(
      "SELECT details_safe_json AS details FROM audit_events",
    ).get();
    expect(JSON.parse(row!.details)).toEqual({
      changedFields: ["displayName"],
      invalidatedValidation: true,
    });
  });
});
