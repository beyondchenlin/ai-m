import { NextRequest, NextResponse } from "next/server";
import { getUserIdFromRequest } from "@/lib/get-user-id";
import { getSelectableProfiles } from "@/lib/generation/profiles/service";
import type { Capability } from "@/lib/generation/naming";
import {
  readJsonBodyLimited,
  assertPlainObject,
  rejectUnknownKeys,
  readRequiredString,
  readOptionalString,
  RequestValidationError,
  UpstreamResponseError,
  assertTrustedRequestOrigin,
} from "@/lib/security";
import { resolveModelDiscoveryTarget, ModelDiscoveryPolicyError, type ModelDiscoveryTarget } from "@/lib/security/model-discovery-policy";
import { requestPinnedJson } from "@/lib/security/pinned-json-request";

interface ModelItem {
  id: string;
  name: string;
}

const CAPABILITIES = new Set<Capability>(["text", "image", "video", "speech", "utility"]);
const PROTOCOL_CAPABILITIES: Record<string, readonly Capability[]> = {
  openai: ["text", "image"],
  gemini: ["text", "image", "video"],
  seedance: ["video"],
  "ucloud-seedance": ["video"],
  kling: ["image", "video"],
  wan: ["video"],
  dashscope: ["image"],
  comfyui: ["image", "video", "speech", "utility"],
};

function assertProtocolCapability(protocol: string, capability?: Capability): void {
  const allowed = PROTOCOL_CAPABILITIES[protocol];
  if (!allowed) throw new RequestValidationError("Unsupported protocol");
  if (capability && !allowed.includes(capability)) {
    throw new RequestValidationError("Protocol does not support the requested capability");
  }
}

async function buildModelsTarget(protocol: string, baseUrl: string): Promise<ModelDiscoveryTarget> {
  const target = await resolveModelDiscoveryTarget({ protocol, baseUrl });
  target.url.pathname = target.url.pathname.replace(/\/+$/, "");
  target.url.pathname = target.url.pathname.endsWith("/v1")
    ? `${target.url.pathname}/models`
    : `${target.url.pathname}/v1/models`;
  target.url.search = "";
  return target;
}

async function fetchModels(protocol: string, baseUrl: string, apiKey: string): Promise<ModelItem[]> {
  const response = await requestPinnedJson(await buildModelsTarget(protocol, baseUrl), {
    headers: { Authorization: `Bearer ${apiKey}` },
    maxBytes: 1024 * 1024,
    timeoutMs: 15_000,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new UpstreamResponseError(`Model listing failed with HTTP ${response.status}`);
  }
  const data = response.body as { data?: Array<{ id?: unknown }> };
  if (!Array.isArray(data.data)) throw new UpstreamResponseError("Unexpected response format: missing data array");
  return data.data
    .filter((item): item is { id: string } => typeof item.id === "string" && item.id.length > 0 && item.id.length <= 512)
    .map((item) => ({ id: item.id, name: item.id }));
}

async function fetchGeminiModels(baseUrl: string, apiKey: string): Promise<ModelItem[]> {
  const target = await resolveModelDiscoveryTarget({ protocol: "gemini", baseUrl });
  const basePath = target.url.pathname.replace(/\/+$/, "");
  target.url.pathname = basePath.endsWith("/v1beta") || basePath.endsWith("/v1")
    ? `${basePath}/models`
    : `${basePath}/v1beta/models`;
  target.url.search = "";
  const response = await requestPinnedJson(target, {
    headers: { "x-goog-api-key": apiKey },
    maxBytes: 1024 * 1024,
    timeoutMs: 15_000,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new UpstreamResponseError(`Gemini model listing failed with HTTP ${response.status}`);
  }
  const data = response.body as {
    models?: Array<{ name?: unknown; displayName?: unknown }>;
  };
  if (!Array.isArray(data.models)) throw new UpstreamResponseError("Unexpected Gemini response format: missing models array");
  return data.models.flatMap((model) => {
    if (typeof model.name !== "string" || model.name.length > 512) return [];
    const id = model.name.replace(/^models\//, "");
    return [{ id, name: typeof model.displayName === "string" && model.displayName.length <= 512 ? model.displayName : id }];
  });
}

function staticModels(protocol: string): ModelItem[] | null {
  if (protocol === "kling") return [
    { id: "kling-v1", name: "Kling v1" },
    { id: "kling-v1-5", name: "Kling v1.5" },
    { id: "kling-v1-6", name: "Kling v1.6" },
    { id: "kling-v2", name: "Kling v2" },
    { id: "kling-v2-new", name: "Kling v2 New" },
    { id: "kling-v2-1", name: "Kling v2.1" },
    { id: "kling-v2-master", name: "Kling v2 Master" },
    { id: "kling-v2-1-master", name: "Kling v2.1 Master" },
    { id: "kling-v2-5-turbo", name: "Kling v2.5 Turbo" },
  ];
  if (protocol === "ucloud-seedance") return [
    { id: "doubao-seedance-1-5-pro-251215", name: "Seedance 1.5 Pro（UCloud）" },
    { id: "doubao-seedance-2-0-260128", name: "Seedance 2.0（UCloud）" },
  ];
  if (protocol === "wan") return [
    { id: "wan2.7-t2v", name: "Wan 2.7 文生视频" },
    { id: "wan2.7-r2v", name: "Wan 2.7 参考生视频" },
    { id: "wan2.6-t2v", name: "Wan 2.6 文生视频" },
    { id: "wan2.6-i2v-flash", name: "Wan 2.6 图生视频 Flash" },
    { id: "wan2.6-i2v", name: "Wan 2.6 图生视频" },
    { id: "wan2.6-r2v", name: "Wan 2.6 参考生视频" },
    { id: "wan2.6-r2v-flash", name: "Wan 2.6 参考生视频 Flash" },
  ];
  if (protocol === "dashscope") return [
    { id: "wan2.7-image-pro", name: "Wan 2.7 Image Pro（4K）" },
    { id: "wan2.7-image", name: "Wan 2.7 Image" },
    { id: "qwen-image-2.0-pro", name: "Qwen Image 2.0 Pro" },
    { id: "qwen-image-2.0", name: "Qwen Image 2.0" },
    { id: "qwen-image-max", name: "Qwen Image Max" },
    { id: "qwen-image-plus", name: "Qwen Image Plus" },
    { id: "z-image-turbo", name: "Z-Image Turbo" },
  ];
  return null;
}

export async function POST(request: NextRequest) {
  const userId = getUserIdFromRequest(request);
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    assertTrustedRequestOrigin(request);
    const body: unknown = await readJsonBodyLimited(request);
    assertPlainObject(body);
    rejectUnknownKeys(body, ["protocol", "capability", "baseUrl", "apiKey"]);
    const protocol = readRequiredString(body, "protocol", { maxLength: 80 });
    const capabilityText = readOptionalString(body, "capability", { maxLength: 40 });
    const capability = capabilityText && CAPABILITIES.has(capabilityText as Capability)
      ? capabilityText as Capability
      : undefined;
    if (capabilityText && !capability) throw new RequestValidationError("Capability is invalid");
    assertProtocolCapability(protocol, capability);

    const baseUrl = readOptionalString(body, "baseUrl", { maxLength: 2_048 }) ?? "";
    const apiKey = readOptionalString(body, "apiKey", { maxLength: 8_192 }) ?? "";

    if (protocol === "comfyui") {
      if (!capability) throw new RequestValidationError("A valid capability is required for server-managed workflows");
      const profiles = (await getSelectableProfiles(capability))
        .filter((profile) => profile.adapterKind === "comfyui")
        .map((profile) => ({ id: profile.id, name: profile.displayName }));
      return NextResponse.json({ models: profiles });
    }

    const predefined = staticModels(protocol);
    if (predefined) return NextResponse.json({ models: predefined });
    if (!baseUrl) throw new RequestValidationError("Base URL is required");
    if (!apiKey) throw new RequestValidationError("API Key is required");

    const models = protocol === "gemini"
      ? await fetchGeminiModels(baseUrl, apiKey)
      : await fetchModels(protocol, baseUrl, apiKey);
    return NextResponse.json({ models });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ModelDiscoveryPolicyError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof UpstreamResponseError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error("[models/list] failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ error: "Model listing failed" }, { status: 502 });
  }
}
