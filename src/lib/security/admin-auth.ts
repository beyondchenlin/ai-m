import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

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

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isInsecureLocalAdminAllowed(): boolean {
  return process.env.NODE_ENV !== "production"
    && process.env.AI_M_ALLOW_INSECURE_LOCAL_ADMIN === "true";
}

function hasStrongAdminToken(token: string): boolean {
  if (/^[0-9a-f]{64,}$/i.test(token)) return true;
  if (!/^[A-Za-z0-9_-]{43,}$/.test(token)) return false;
  try { return Buffer.from(token, "base64url").byteLength >= 32; } catch { return false; }
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

  if (!token || !constantTimeEqual(token, configured)) {
    throw new AdminAuthenticationError();
  }

  return { id: "control-plane-admin", roles: ["admin"] };
}
