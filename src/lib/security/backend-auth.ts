import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { keyReferences } from "@/lib/db/schema";
import { decryptSecret } from "./secrets";
import { RequestValidationError, assertPlainObject, rejectUnknownKeys, readRequiredString } from "./request-validation";

export type BackendAuthType = "none" | "bearer" | "header-token" | "basic" | "mtls";

export interface BackendAuthConfig {
  keyRefId?: string;
  headerName?: string;
}

const FORBIDDEN_HEADERS = new Set([
  "host", "content-length", "connection", "transfer-encoding", "upgrade", "cookie", "set-cookie",
]);

export function validateBackendAuthConfig(authType: BackendAuthType, raw: unknown): BackendAuthConfig {
  assertPlainObject(raw, "authConfigJson");
  if (authType === "none") {
    rejectUnknownKeys(raw, []);
    return {};
  }
  if (authType === "mtls") {
    throw new RequestValidationError("mtls is not supported by the current ComfyUI transport; use a trusted gateway");
  }
  const allowed = authType === "header-token" ? ["keyRefId", "headerName"] : ["keyRefId"];
  rejectUnknownKeys(raw, allowed);
  const keyRefId = readRequiredString(raw, "keyRefId", { maxLength: 120, pattern: /^[A-Za-z0-9._:-]+$/ });
  if (authType !== "header-token") return { keyRefId };
  const headerName = readRequiredString(raw, "headerName", { maxLength: 80, pattern: /^[A-Za-z0-9-]+$/ });
  if (FORBIDDEN_HEADERS.has(headerName.toLowerCase())) throw new RequestValidationError("headerName is not allowed");
  return { keyRefId, headerName };
}

export async function resolveBackendAuthHeaders(
  authType: BackendAuthType,
  raw: unknown,
): Promise<Record<string, string>> {
  const config = validateBackendAuthConfig(authType, raw);
  if (authType === "none") return {};
  const [key] = await db.select().from(keyReferences).where(eq(keyReferences.id, config.keyRefId!));
  if (!key) throw new Error("Backend key reference does not exist");
  if (key.keyType !== authType) throw new Error("Backend key reference type does not match authType");
  const secret = decryptSecret(key.secretValue);
  if (authType === "bearer") return { Authorization: `Bearer ${secret}` };
  if (authType === "basic") return { Authorization: `Basic ${Buffer.from(secret, "utf8").toString("base64")}` };
  if (authType === "header-token") return { [config.headerName!]: secret };
  throw new Error("Unsupported backend authentication type");
}
