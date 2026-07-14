export const SPEECH_ENGINES = ["indextts2", "omnivoice"] as const;
export type SpeechEngine = typeof SPEECH_ENGINES[number];

export function isSpeechEngine(value: unknown): value is SpeechEngine {
  return typeof value === "string" && (SPEECH_ENGINES as readonly string[]).includes(value.toLowerCase());
}

export function assertSpeechProfileCompatibility(
  profile: {
    adapterKind: string;
    executionBackendId: string | null;
    workflowPackageDigest: string | null;
    configJson: Record<string, unknown>;
  },
  voiceProvider: string,
): SpeechEngine {
  if (profile.adapterKind !== "comfyui" || !profile.executionBackendId || !profile.workflowPackageDigest) {
    throw new Error("Speech generation profile is not a complete ComfyUI workflow profile");
  }
  const configured = typeof profile.configJson.speechEngine === "string"
    ? profile.configJson.speechEngine.toLowerCase()
    : null;
  if (!isSpeechEngine(configured)) {
    throw new Error("Speech generation profile does not declare a supported speech engine");
  }
  if (!isSpeechEngine(voiceProvider) || configured !== voiceProvider.toLowerCase()) {
    throw new Error(`Voice profile requires ${voiceProvider}, but the selected speech profile uses ${configured}`);
  }
  return configured;
}
