import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { keyReferences } from "@/lib/db/schema";
import { setupTestDb } from "@/lib/test-helpers/db";
import { POST as createKey } from "@/app/api/admin/keys/route";
import { encryptSecret } from "../secrets";
import { resolveBackendAuthHeaders } from "../backend-auth";

const ORIGINAL_ENV = { ...process.env };
const INJECTED_SECRET = "do-not-echo\r\nX-Injected: yes";
const UNSAFE_CASES = (["bearer", "header-token"] as const).flatMap((keyType) => [
  { keyType, caseName: "control characters", secret: INJECTED_SECRET },
  { keyType, caseName: "a non-ByteString character", secret: "do-not-echo-\u0100" },
]);

describe("backend authentication header values", () => {
  let ctx: ReturnType<typeof setupTestDb>;

  beforeAll(() => {
    process.env.AI_M_SECRET_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.AI_M_ADMIN_TOKEN = "a".repeat(64);
    process.env.FF_V2_BACKEND_CONFIG = "1";
    ctx = setupTestDb();
  });

  afterEach(async () => {
    await db.delete(keyReferences);
  });

  afterAll(() => {
    ctx.cleanup();
    process.env = { ...ORIGINAL_ENV };
  });

  it.each(UNSAFE_CASES)(
    "rejects $caseName in a decrypted $keyType value without echoing it",
    async ({ keyType, secret }) => {
      const now = Date.now();
      await db.insert(keyReferences).values({
        id: `legacy-${keyType}`,
        label: "legacy unsafe key",
        keyType,
        secretValue: encryptSecret(secret),
        createdAtMs: now,
        updatedAtMs: now,
      });

      const authConfig = keyType === "header-token"
        ? { keyRefId: `legacy-${keyType}`, headerName: "X-Backend-Token" }
        : { keyRefId: `legacy-${keyType}` };
      let error: Error | undefined;
      try {
        await resolveBackendAuthHeaders(keyType, authConfig);
      } catch (caught) {
        error = caught as Error;
      }

      expect(error?.message).toMatch(/header value/i);
      expect(error?.message).not.toContain("do-not-echo");
    },
  );

  it.each(UNSAFE_CASES)(
    "rejects $caseName in a $keyType value at key creation without storing or echoing it",
    async ({ keyType, secret }) => {
      const request = new NextRequest("http://localhost/api/admin/keys", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.AI_M_ADMIN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ label: "unsafe", keyType, secretValue: secret }),
      });

      const response = await createKey(request);
      const body = await response.text();
      expect(response.status).toBe(400);
      expect(body).not.toContain("do-not-echo");
      expect(await db.select().from(keyReferences)).toHaveLength(0);
    },
  );
});
