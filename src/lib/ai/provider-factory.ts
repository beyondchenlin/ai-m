import { OpenAIProvider } from "./providers/openai";
import { GeminiProvider } from "./providers/gemini";
import { SeedanceProvider } from "./providers/seedance";
import { VeoProvider } from "./providers/veo";
import { KlingImageProvider } from "./providers/kling-image";
import { KlingVideoProvider } from "./providers/kling-video";
import { WanVideoProvider } from "./providers/wan-video";
import { UCloudSeedanceProvider } from "./providers/ucloud-seedance";
import { DashScopeImageProvider } from "./providers/dashscope-image";
import { getAIProvider, getVideoProvider } from "./index";
import { db } from "@/lib/db";
import { executionBackends, keyReferences } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { normalizeDashScopeBaseUrl } from "./dashscope-url";
import type { AIProvider, VideoProvider } from "./types";

interface ProviderConfig {
  protocol: string;
  baseUrl: string;
  apiKey: string;
  secretKey?: string;
  modelId: string;
}

export interface ModelConfigPayload {
  text?: ProviderConfig | null;
  image?: ProviderConfig | null;
  video?: ProviderConfig | null;
  /** v2.0: 执行后端 ID，优先于此字段解析 */
  backendId?: string;
}

/** adapter_kind → 旧 protocol 映射 */
const ADAPTER_TO_PROTOCOL: Record<string, string> = {
  "openai-http": "openai",
  "gemini-http": "gemini",
  "seedance-http": "seedance",
  "ucloud-seedance-http": "ucloud-seedance",
  "kling-http": "kling",
  "wan-http": "wan",
  "dashscope-http": "dashscope",
  "comfyui-http": "dashscope",
};

/** 从 keyRefIds 解析密钥 */
async function resolveKeys(keyRefIds: string[]): Promise<{ apiKey: string; secretKey?: string }> {
  if (keyRefIds.length === 0) return { apiKey: "" };

  const refs = await db
    .select()
    .from(keyReferences)
    .where(
      keyRefIds.length === 1
        ? eq(keyReferences.id, keyRefIds[0])
        : undefined
    );

  // 简单场景：第一个 bearer key 作为 apiKey，第一个 basic 作为 secretKey
  const bearerKey = refs.find((r) => r.keyType === "bearer");
  const basicKey = refs.find((r) => r.keyType === "basic");

  return {
    apiKey: bearerKey?.secretValue ?? "",
    secretKey: basicKey?.secretValue,
  };
}

/** 从服务端执行后端解析 ProviderConfig */
export async function resolveBackendConfig(backendId: string): Promise<ProviderConfig> {
  const [backend] = await db
    .select()
    .from(executionBackends)
    .where(eq(executionBackends.id, backendId));

  if (!backend) {
    throw new Error(`Execution backend not found: ${backendId}`);
  }

  const protocol = ADAPTER_TO_PROTOCOL[backend.adapterKind] ?? "openai";
  const authConfig = backend.authConfigJson as { keyRefIds?: string[] };
  const keys = await resolveKeys(authConfig.keyRefIds ?? []);

  let baseUrl = backend.baseUrl;
  if (backend.adapterKind === "dashscope-http") {
    baseUrl = normalizeDashScopeBaseUrl(baseUrl);
  }

  return {
    protocol,
    baseUrl,
    apiKey: keys.apiKey,
    secretKey: keys.secretKey,
    modelId: "",
  };
}

export function createAIProvider(config: ProviderConfig, uploadDir?: string): AIProvider {
  switch (config.protocol) {
    case "openai":
      return new OpenAIProvider({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
    case "gemini":
      return new GeminiProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
    case "kling":
      return new KlingImageProvider({
        apiKey: config.apiKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
    case "dashscope":
      return new DashScopeImageProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
    default:
      throw new Error(`Unsupported AI protocol: ${config.protocol}`);
  }
}

export function createVideoProvider(config: ProviderConfig, uploadDir?: string): VideoProvider {
  switch (config.protocol) {
    case "seedance":
      return new SeedanceProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
    case "gemini":
      return new VeoProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
    case "kling":
      return new KlingVideoProvider({
        apiKey: config.apiKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
    case "wan":
      return new WanVideoProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
    case "ucloud-seedance":
      return new UCloudSeedanceProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.modelId,
        ...(uploadDir && { uploadDir }),
      });
    default:
      throw new Error(`Unsupported video protocol: ${config.protocol}`);
  }
}

export async function resolveAIProvider(modelConfig?: ModelConfigPayload): Promise<AIProvider> {
  // v2.0: 优先使用服务端后端
  if (modelConfig?.backendId) {
    const config = await resolveBackendConfig(modelConfig.backendId);
    return createAIProvider(config);
  }
  // 旧流程：浏览器配置
  if (modelConfig?.text) {
    return createAIProvider(modelConfig.text);
  }
  return getAIProvider();
}

export async function resolveImageProvider(modelConfig?: ModelConfigPayload, uploadDir?: string): Promise<AIProvider> {
  // v2.0: 优先使用服务端后端
  if (modelConfig?.backendId) {
    const config = await resolveBackendConfig(modelConfig.backendId);
    return createAIProvider(config, uploadDir);
  }
  // 旧流程：浏览器配置
  if (modelConfig?.image) {
    return createAIProvider(modelConfig.image, uploadDir);
  }
  return getAIProvider(uploadDir);
}

export async function resolveVideoProvider(modelConfig?: ModelConfigPayload, uploadDir?: string): Promise<VideoProvider> {
  // v2.0: 优先使用服务端后端
  if (modelConfig?.backendId) {
    const config = await resolveBackendConfig(modelConfig.backendId);
    return createVideoProvider(config, uploadDir);
  }
  // 旧流程：浏览器配置
  if (modelConfig?.video) {
    return createVideoProvider(modelConfig.video, uploadDir);
  }
  return getVideoProvider(uploadDir);
}
