import type { NextConfig } from "next";
import path from "node:path";
import createNextIntlPlugin from "next-intl/plugin";
import packageJson from "./package.json";
import { resolveBuildMetadata } from "./src/lib/build-metadata";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");
const buildMetadata = resolveBuildMetadata({
  packageVersion: packageJson.version,
  commit: process.env.AI_M_BUILD_COMMIT,
  buildTime: process.env.AI_M_BUILD_TIME,
});

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  env: {
    AI_M_INTERNAL_EMBEDDED_VERSION: buildMetadata.version,
    AI_M_INTERNAL_EMBEDDED_COMMIT: buildMetadata.commit ?? "",
    AI_M_INTERNAL_EMBEDDED_BUILD_TIME: buildMetadata.buildTime ?? "",
  },
  turbopack: {
    root: path.resolve(process.cwd()),
  },
};

export default withNextIntl(nextConfig);
