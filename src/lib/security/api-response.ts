import { NextResponse } from "next/server";
import { AdminAuthenticationError } from "./admin-auth";
import { RequestValidationError } from "./request-validation";
import { SecretConfigurationError } from "./secrets";

export function controlPlaneErrorResponse(error: unknown): NextResponse {
  if (error instanceof AdminAuthenticationError
      || error instanceof RequestValidationError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof SecretConfigurationError) {
    return NextResponse.json({ error: error.message }, { status: 503 });
  }
  console.error("[control-plane] request failed", error);
  return NextResponse.json({ error: "Control-plane request failed" }, { status: 500 });
}
