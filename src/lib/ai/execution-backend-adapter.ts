/**
 * v2.0 兼容适配器：旧浏览器模型配置 → 新执行后端
 *
 * 阶段 A：只提供转换函数，不切换旧流程。
 * 阶段 B 开始双读，阶段 D 切换新任务到新后端。
 */

import type { Provider, Protocol, Capability } from "@/stores/model-store";

/** 旧 Protocol → 新 adapter_kind 映射 */
const PROTOCOL_TO_ADAPTER: Record<Protocol, string> = {
  openai: "openai-http",
  gemini: "gemini-http",
  seedance: "seedance-http",
  "ucloud-seedance": "ucloud-seedance-http",
  kling: "kling-http",
  wan: "wan-http",
  dashscope: "dashscope-http",
};

/** 旧 Capability → 新 capability 映射 */
const CAPABILITY_MAP: Record<Capability, string> = {
  text: "text",
  image: "image",
  video: "video",
};

/** 根据协议推断拓扑 */
function inferTopology(protocol: Protocol): string {
  switch (protocol) {
    case "dashscope":
    case "wan":
      return "lan-remote";
    case "seedance":
    case "ucloud-seedance":
    case "kling":
      return "lan-remote";
    default:
      return "lan-remote";
  }
}

/** 根据协议推断共享模式 */
function inferSharingMode(protocol: Protocol): string {
  if (protocol === "dashscope" || protocol === "wan") {
    return "shared";
  }
  return "shared";
}

/** 将旧 Provider 转换为新 ExecutionBackend 插入参数 */
export function providerToBackendParams(provider: Provider) {
  const now = Date.now();
  return {
    id: `legacy-${provider.id}`,
    displayName: provider.name,
    adapterKind: PROTOCOL_TO_ADAPTER[provider.protocol] ?? "openai-http",
    baseUrl: provider.baseUrl || "",
    topology: inferTopology(provider.protocol),
    sharingMode: inferSharingMode(provider.protocol),
    authType: provider.apiKey ? "bearer" : "none",
    authConfigJson: {
      keys: provider.apiKey
        ? [{ type: "bearer", keyRef: `legacy-${provider.id}-key` }]
        : [],
    },
    tlsConfigJson: {},
    networkPolicyJson: {
      allowRedirect: false,
      allowedHosts: [],
    },
    resourcePoolId: "default",
    capabilitiesJson: {
      capabilities: [CAPABILITY_MAP[provider.capability]],
    },
    enabled: 1,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

/** 检查旧 Provider 是否已迁移 */
export function isLegacyProvider(backendId: string): boolean {
  return backendId.startsWith("legacy-");
}