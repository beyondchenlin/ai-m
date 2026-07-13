import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "path";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: "node",
    env: {
      NODE_ENV: "test",
      FF_V2_BACKEND_CONFIG: "1",
      FF_V2_GENERATION_PROFILES: "1",
      FF_V2_DURABLE_EXECUTION: "1",
      FF_V2_WORKFLOW_SUPPLY_CHAIN: "1",
      FF_V2_COMFYUI_TRANSPORT: "1",
      FF_V2_MEDIA_ARCHIVING: "1",
      FF_V2_LOCAL_IMAGE: "1",
      FF_V2_LOCAL_SPEECH: "1",
    },
    setupFiles: [path.resolve(__dirname, "src/lib/test-helpers/vitest-setup.ts")],
  },
});
