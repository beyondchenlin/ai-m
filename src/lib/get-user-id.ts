import {
  decodeTrustedProxySecret,
  verifyTrustedProxyRequest,
} from "@/lib/security/trusted-proxy-auth";

const USER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

type IdentityMode = "trusted-proxy" | "single-user" | "legacy-browser";

function normalizeUserId(value: string | null | undefined): string {
  const normalized = value?.trim() ?? "";
  return USER_ID_PATTERN.test(normalized) ? normalized : "";
}

function readCookie(request: Request, name: string): string {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return ""; }
  }
  return "";
}

function identityMode(): IdentityMode | null {
  const configured = process.env.AI_M_USER_IDENTITY_MODE?.trim();
  if (configured === "trusted-proxy" || configured === "single-user" || configured === "legacy-browser") {
    return configured;
  }
  return process.env.NODE_ENV === "production" ? null : "legacy-browser";
}

export function validateIdentityConfiguration(): void {
  if (process.env.NODE_ENV !== "production") return;
  const mode = identityMode();
  if (!mode || mode === "legacy-browser") {
    throw new Error("Production requires AI_M_USER_IDENTITY_MODE=single-user or trusted-proxy");
  }
  if (mode === "single-user" && !normalizeUserId(process.env.AI_M_SINGLE_USER_ID)) {
    throw new Error("AI_M_SINGLE_USER_ID is required and invalid");
  }
  if (mode === "trusted-proxy") {
    try {
      decodeTrustedProxySecret(process.env.AI_M_TRUSTED_USER_HEADER_SECRET);
    } catch {
      throw new Error("AI_M_TRUSTED_USER_HEADER_SECRET must be base64url for at least 32 high-entropy decoded bytes");
    }
  }
}

/**
 * Resolve the application principal without trusting a browser-supplied identity
 * in production.  Multi-user deployments must use a trusted reverse proxy;
 * isolated installations may select one configured single-user principal.
 */
export async function getUserIdFromRequest(request: Request): Promise<string> {
  const mode = identityMode();
  if (mode === "trusted-proxy") {
    return verifyTrustedProxyRequest(request).catch(() => "");
  }
  if (mode === "single-user") return normalizeUserId(process.env.AI_M_SINGLE_USER_ID);
  if (mode === "legacy-browser") {
    const allowed = process.env.NODE_ENV !== "production"
      || process.env.AI_M_ALLOW_LEGACY_USER_HEADER === "true";
    if (!allowed) return "";
    return normalizeUserId(request.headers.get("x-user-id"))
      || normalizeUserId(readCookie(request, "ai_comic_uid"));
  }
  return "";
}
