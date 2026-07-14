import { readEmbeddedBuildMetadata } from "@/lib/build-metadata";

import { SettingsPageClient } from "./settings-page-client";

export default function SettingsPage() {
  return <SettingsPageClient metadata={readEmbeddedBuildMetadata()} />;
}
