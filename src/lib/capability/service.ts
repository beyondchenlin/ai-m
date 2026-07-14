/**
 * v2.0 能力服务 — 统一入口
 *
 * 阶段 C：旧云供应商通过 CloudSupplierAdapter 进入此服务，
 * 新 ComfyUI 后端通过 executionBackend 解析。
 * 阶段 D 将切换为独立工作进程。
 */

import { db } from "@/lib/db";
import { executionBackends } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { resolveLegacyProviderSecrets } from "@/lib/security/provider-secrets";
import { normalizeDashScopeBaseUrl } from "@/lib/ai/dashscope-url";
import { getAIProvider, getVideoProvider } from "@/lib/ai";
import { CloudSupplierAdapter } from "./adapters/cloud-supplier";
import type { ICapabilityService, CapabilityRequest } from "./types";
import type { TextOptions, ImageOptions, VideoGenerateParams, VideoGenerateResult } from "@/lib/ai/types";

/** adapter_kind → 旧 protocol 映射 */
const ADAPTER_TO_PROTOCOL: Record<string, string> = {
  "openai-http": "openai",
  "gemini-http": "gemini",
  "seedance-http": "seedance",
  "ucloud-seedance-http": "ucloud-seedance",
  "kling-http": "kling",
  "wan-http": "wan",
  "dashscope-http": "dashscope",
};

/** 从 CapabilityRequest 解析适配器配置 */
async function resolveAdapterConfig(request: CapabilityRequest) {
  // v2.0: 服务端执行后端
  if (request.backendId) {
    const [backend] = await db
      .select()
      .from(executionBackends)
      .where(eq(executionBackends.id, request.backendId));

    if (!backend) {
      throw new Error(`Execution backend not found: ${request.backendId}`);
    }

    const protocol = ADAPTER_TO_PROTOCOL[backend.adapterKind];
    if (!protocol) throw new Error(`Backend adapter is not supported by the legacy cloud facade: ${backend.adapterKind}`);
    if (!backend.enabled) throw new Error(`Execution backend is disabled: ${backend.id}`);
    const keys = await resolveLegacyProviderSecrets(backend.authConfigJson);

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
      uploadDir: request.uploadDir,
    };
  }

  // 旧流程：浏览器配置
  if (request.legacyConfig) {
    return {
      protocol: request.legacyConfig.protocol,
      baseUrl: request.legacyConfig.baseUrl,
      apiKey: request.legacyConfig.apiKey,
      secretKey: request.legacyConfig.secretKey,
      modelId: request.legacyConfig.modelId,
      uploadDir: request.uploadDir,
    };
  }

  return null;
}

export const capabilityService: ICapabilityService = {
  async generateText(prompt, options, request) {
    if (request) {
      const config = await resolveAdapterConfig(request);
      if (config) {
        const adapter = new CloudSupplierAdapter(config);
        return adapter.generateText(prompt, options);
      }
    }
    return getAIProvider().generateText(prompt, options);
  },

  async generateImage(prompt, options, request) {
    if (request) {
      const config = await resolveAdapterConfig(request);
      if (config) {
        const adapter = new CloudSupplierAdapter(config);
        return adapter.generateImage(prompt, options);
      }
    }
    return getAIProvider(request?.uploadDir).generateImage(prompt, options);
  },

  async generateVideo(params, request) {
    if (request) {
      const config = await resolveAdapterConfig(request);
      if (config) {
        const adapter = new CloudSupplierAdapter(config);
        return adapter.generateVideo(params);
      }
    }
    return getVideoProvider(request?.uploadDir).generateVideo(params);
  },
};