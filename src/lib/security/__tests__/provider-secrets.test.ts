import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { keyReferences } from "@/lib/db/schema";
import { setupTestDb } from "@/lib/test-helpers/db";
import { encryptSecret } from "../secrets";
import { resolveLegacyProviderSecrets } from "../provider-secrets";

const ORIGINAL_ENV = { ...process.env };

describe("PR-12 legacy cloud secret compatibility", () => {
  let ctx: ReturnType<typeof setupTestDb>;

  beforeAll(() => {
    process.env.AI_M_SECRET_MASTER_KEY = Buffer.alloc(32, 8).toString("base64");
    ctx = setupTestDb();
  });

  afterEach(async () => {
    await db.delete(keyReferences);
  });

  afterAll(() => {
    ctx.cleanup();
    process.env = { ...ORIGINAL_ENV };
  });

  it("resolves only the exact encrypted key references in caller order", async () => {
    const now = Date.now();
    await db.insert(keyReferences).values([
      { id: "api-key", label: "api", keyType: "bearer", secretValue: encryptSecret("api-secret"), createdAtMs: now, updatedAtMs: now },
      { id: "secondary-key", label: "secondary", keyType: "basic", secretValue: encryptSecret("secondary-secret"), createdAtMs: now, updatedAtMs: now },
      { id: "unrelated", label: "unrelated", keyType: "bearer", secretValue: encryptSecret("must-not-leak"), createdAtMs: now, updatedAtMs: now },
    ]);
    await expect(resolveLegacyProviderSecrets({ keyRefIds: ["api-key", "secondary-key"] })).resolves.toEqual({
      apiKey: "api-secret",
      secretKey: "secondary-secret",
    });
  });

  it("supports the v2 single key reference shape and rejects missing references", async () => {
    const now = Date.now();
    await db.insert(keyReferences).values({
      id: "single", label: "single", keyType: "bearer", secretValue: encryptSecret("secret"), createdAtMs: now, updatedAtMs: now,
    });
    await expect(resolveLegacyProviderSecrets({ keyRefId: "single" })).resolves.toEqual({ apiKey: "secret" });
    await expect(resolveLegacyProviderSecrets({ keyRefIds: ["single", "missing"] })).rejects.toThrow(/do not exist/i);
  });
});
