import { RequestValidationError } from "./request-validation";

function configuredOrigins(): Set<string> {
  const origins = new Set<string>();
  const configured = [process.env.AI_M_PUBLIC_ORIGIN ?? "", ...(process.env.AI_M_ALLOWED_ORIGINS ?? "").split(",")];
  for (const raw of configured) {
    const value = raw.trim();
    if (!value) continue;
    try { origins.add(new URL(value).origin); } catch { /* Invalid entries never grant access. */ }
  }
  return origins;
}

function requestOrigins(request: Request): Set<string> {
  const trusted = configuredOrigins();
  // Development servers need their dynamic localhost port. Production must
  // never derive trust from attacker-controlled Host or request URL headers.
  if (process.env.NODE_ENV !== "production") {
    try { trusted.add(new URL(request.url).origin); } catch { /* Invalid URLs grant nothing. */ }
  }
  return trusted;
}

export function validateRequestOriginConfiguration(): void {
  if (process.env.NODE_ENV !== "production") return;
  const raw = process.env.AI_M_PUBLIC_ORIGIN?.trim();
  if (!raw) throw new Error("AI_M_PUBLIC_ORIGIN is required in production");
  try {
    const url = new URL(raw);
    if (url.origin !== raw.replace(/\/$/, "") || url.protocol !== "https:") {
      throw new Error("AI_M_PUBLIC_ORIGIN must be one canonical HTTPS origin");
    }
  } catch (error) {
    throw new Error("AI_M_PUBLIC_ORIGIN must be one canonical HTTPS origin", { cause: error });
  }
}

function assertHeaderOrigin(headerName: "origin" | "referer", raw: string, trusted: Set<string>): void {
  if (raw === "null") throw new RequestValidationError("Cross-origin request is not allowed", 403);
  let origin: string;
  try { origin = new URL(raw).origin; } catch { throw new RequestValidationError(`${headerName} header is invalid`, 403); }
  if (!trusted.has(origin)) throw new RequestValidationError("Cross-origin request is not allowed", 403);
}

/**
 * Browser CSRF/media-embedding guard for the single-user deployment mode.
 * Non-browser clients without Fetch Metadata or Origin headers remain usable.
 */
export function assertTrustedRequestOrigin(request: Request): void {
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite === "cross-site") throw new RequestValidationError("Cross-site request is not allowed", 403);
  const trusted = requestOrigins(request);
  const origin = request.headers.get("origin");
  if (origin) {
    assertHeaderOrigin("origin", origin, trusted);
    return;
  }
  const referer = request.headers.get("referer");
  if (referer) assertHeaderOrigin("referer", referer, trusted);
}
