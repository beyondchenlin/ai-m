import type { NextRequest } from "next/server";
import { requireAdmin } from "./admin-auth";
import { RequestValidationError } from "./request-validation";
import {
  assertTrustedRequestOrigin,
  validateRequestOriginConfiguration,
} from "./request-origin";
import { isAuthenticatedLocalClientRequest } from "./local-client-auth";
import { hasCompleteTrustedProxyProofHeaders } from "./trusted-proxy-auth";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type MutationRequestClass =
  | "not-mutation"
  | "browser"
  | "admin-service"
  | "trusted-proxy-service"
  | "local-client-service";

function hasCookie(request: Request): boolean {
  return Boolean(request.headers.get("cookie")?.trim());
}

function isAdminServiceRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith("/api/admin/")) return false;
  const hasServiceCredential = Boolean(
    request.headers.get("authorization")?.trim()
      || request.headers.get("x-ai-m-admin-token")?.trim(),
  );
  if (!hasServiceCredential) return false;
  requireAdmin(request as NextRequest);
  return true;
}

function isTrustedProxyServiceRequest(request: Request): boolean {
  return process.env.AI_M_USER_IDENTITY_MODE === "trusted-proxy"
    && hasCompleteTrustedProxyProofHeaders(request);
}

/** Central browser/service classification for every mutating API request. */
export function assertMutationRequest(request: Request): MutationRequestClass {
  if (!MUTATION_METHODS.has(request.method.toUpperCase())) return "not-mutation";

  // Cookie presence always selects the browser boundary; it can never be used
  // together with a bearer-like header to downgrade CSRF checks.
  if (!hasCookie(request)) {
    if (isAdminServiceRequest(request)) return "admin-service";
    if (isTrustedProxyServiceRequest(request)) return "trusted-proxy-service";
    if (isAuthenticatedLocalClientRequest(request)) return "local-client-service";
  }

  validateRequestOriginConfiguration();
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  if (!origin && !referer) {
    throw new RequestValidationError("Browser mutation origin evidence is required", 403);
  }
  if (origin) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch {
      throw new RequestValidationError("origin header is invalid", 403);
    }
    if (origin !== parsed.origin) {
      throw new RequestValidationError("origin header must be canonical", 403);
    }
  }
  assertTrustedRequestOrigin(request);
  return "browser";
}
