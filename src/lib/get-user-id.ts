import { createHmac, timingSafeEqual } from "node:crypto";

const USER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const seenProxyNonces = new Map<string, number>();

type IdentityMode = "trusted-proxy" | "single-user" | "legacy-browser";

function normalizeUserId(value: string | null | undefined): string {
  const normalized = value?.trim() ?? "";
  return USER_ID_PATTERN.test(normalized) ? normalized : "";
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  const a = Buffer.from(left.toLowerCase(), "hex");
  const b = Buffer.from(right.toLowerCase(), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
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

function fromTrustedProxy(request: Request): string {
  const secret = process.env.AI_M_TRUSTED_USER_HEADER_SECRET?.trim();
  if (!secret || secret.length < 32) return "";
  const userId = normalizeUserId(request.headers.get("x-ai-m-authenticated-user"));
  const timestampText = request.headers.get("x-ai-m-user-timestamp")?.trim() ?? "";
  const signature = request.headers.get("x-ai-m-user-signature")?.trim() ?? "";
  const nonce = request.headers.get("x-ai-m-user-nonce")?.trim() ?? "";
  const timestamp = Number(timestampText);
  const now = Date.now();
  for (const [key, expiry] of seenProxyNonces) if (expiry <= now) seenProxyNonces.delete(key);
  if (!userId || !NONCE_PATTERN.test(nonce) || !Number.isSafeInteger(timestamp)
      || Math.abs(now - timestamp) > 60 * 1000 || seenProxyNonces.has(nonce)) return "";
  const url = new URL(request.url);
  const canonical = `${timestampText}.${userId}.${request.method.toUpperCase()}.${url.pathname}.${nonce}`;
  const expected = createHmac("sha256", secret).update(canonical).digest("hex");
  if (!constantTimeHexEqual(signature, expected)) return "";
  seenProxyNonces.set(nonce, now + 60 * 1000);
  return userId;
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
  if (mode === "trusted-proxy" && (process.env.AI_M_TRUSTED_USER_HEADER_SECRET?.trim().length ?? 0) < 32) {
    throw new Error("AI_M_TRUSTED_USER_HEADER_SECRET must contain at least 32 characters");
  }
}

/**
 * Resolve the application principal without trusting a browser-supplied identity
 * in production.  Multi-user deployments must use a trusted reverse proxy;
 * isolated installations may select one configured single-user principal.
 */
export function getUserIdFromRequest(request: Request): string {
  const mode = identityMode();
  if (mode === "trusted-proxy") return fromTrustedProxy(request);
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
