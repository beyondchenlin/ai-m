import { strongServiceTokenEqual } from "./service-token";

export const LOCAL_CLIENT_TOKEN_HEADER = "x-ai-m-local-client-token";

/**
 * Authenticate non-browser automation for an explicitly configured single-user
 * installation. Loopback binding is a deployment concern; the token prevents a
 * network client from gaining trust merely by omitting browser headers.
 */
export function isAuthenticatedLocalClientRequest(request: Request): boolean {
  if (process.env.AI_M_USER_IDENTITY_MODE !== "single-user") return false;
  return strongServiceTokenEqual(
    request.headers.get(LOCAL_CLIENT_TOKEN_HEADER) ?? undefined,
    process.env.AI_M_LOCAL_CLIENT_TOKEN,
  );
}
