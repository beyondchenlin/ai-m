import { runMigrations } from "@/lib/db";
import { initializeProviders } from "@/lib/ai/setup";
import { registerPipelineHandlers } from "@/lib/pipeline";
import { startWorker } from "@/lib/task-queue";
import { validateIdentityConfiguration } from "@/lib/get-user-id";
import { validateAdminConfiguration } from "@/lib/security/admin-auth";
import { validateRequestOriginConfiguration } from "@/lib/security/request-origin";

let bootstrapped = false;

export function bootstrap() {
  if (bootstrapped) return;
  validateIdentityConfiguration();
  validateAdminConfiguration();
  validateRequestOriginConfiguration();
  bootstrapped = true;

  console.log("[Bootstrap] Running database migrations...");
  runMigrations();

  console.log("[Bootstrap] Initializing AI providers...");
  initializeProviders();

  console.log("[Bootstrap] Registering pipeline handlers...");
  registerPipelineHandlers();

  console.log("[Bootstrap] Starting task worker...");
  startWorker();

  console.log("[Bootstrap] Ready.");
}
