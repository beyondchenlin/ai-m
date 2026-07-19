import type { NextRequest } from "next/server";
import { decodeStrongServiceToken, strongServiceTokenEqual } from "./service-token";

export interface AdminPrincipal {
  id: string;
  roles: readonly ["admin"];
}

export class AdminAuthenticationError extends Error {
  readonly status = 401;
  constructor(message = "Administrator authentication required") {
    super(message);
    this.name = "AdminAuthenticationError";
  }
}

function isInsecureLocalAdminAllowed(): boolean {
  return process.env.NODE_ENV !== "production"
    && process.env.AI_M_ALLOW_INSECURE_LOCAL_ADMIN === "true";
}

function hasStrongAdminToken(token: string): boolean {
  return decodeStrongServiceToken(token) !== null;
}

export function validateAdminConfiguration(): void {
  if (process.env.NODE_ENV !== "production") return;
  const token = process.env.AI_M_ADMIN_TOKEN?.trim() ?? "";
  if (!hasStrongAdminToken(token)) {
    throw new Error("AI_M_ADMIN_TOKEN must encode at least 32 random bytes (hex or base64url)");
  }
}

/**
 * Authenticate the control-plane request. Feature flags are not authorization.
 * Insecure bypass is deliberately limited to non-production and requires an
 * explicit opt-in environment variable.
 */
export function requireAdmin(request: NextRequest): AdminPrincipal {
  const configured = process.env.AI_M_ADMIN_TOKEN?.trim();
  if (!configured) {
    if (isInsecureLocalAdminAllowed()) {
      return { id: "local-development-admin", roles: ["admin"] };
    }
    throw new AdminAuthenticationError("AI_M_ADMIN_TOKEN is not configured");
  }
  if (process.env.NODE_ENV === "production" && !hasStrongAdminToken(configured)) {
    throw new AdminAuthenticationError("AI_M_ADMIN_TOKEN is not securely configured");
  }

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : request.headers.get("x-ai-m-admin-token")?.trim() ?? "";

  if (!token || !strongServiceTokenEqual(token, configured)) {
    throw new AdminAuthenticationError();
  }

  return { id: "control-plane-admin", roles: ["admin"] };
}
