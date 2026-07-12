// DashScope / 阿里云百炼 MaaS 的 baseUrl 规范化工具
//
// 背景说明
//   标准 DashScope 公网入口：https://dashscope.aliyuncs.com/api/v1
//   VPC 内网入口示例：       https://llm-xxx.cn-beijing.maas.aliyuncs.com/api/v1
//   新加坡地域入口：         https://dashscope-intl.aliyuncs.com/api/v1
//
//   所有入口的 API 路径结构一致，均需 /api/v1 前缀。
//   但用户在设置界面可能只填了裸域名（如 llm-xxx.cn-beijing.maas.aliyuncs.com），
//   既缺 https:// 协议头又缺 /api/v1 路径段，导致：
//     - 缺协议头 → fetch 抛 "Failed to parse URL"
//     - 缺 /api/v1 → 服务端返回 404
//
//   此函数统一做兼容处理，让用户无论填哪种格式都能正确工作。

export const DEFAULT_DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";

/**
 * 规范化 DashScope 风格的 baseUrl：
 * 1. 自动补全 https:// 协议（用户可能只填了域名）
 * 2. 自动补全 /api/v1 路径段（DashScope / MaaS API 均需要此前缀）
 *
 * 兼容以下输入：
 *   - "" / undefined                         → 默认公网入口
 *   - "   "                                  → 默认公网入口（纯空白视为未填）
 *   - "llm-xxx.cn-beijing.maas.aliyuncs.com" → 补全协议 + /api/v1
 *   - "https://llm-xxx.cn-beijing.maas.aliyuncs.com" → 补全 /api/v1
 *   - "https://dashscope.aliyuncs.com/api/v1" → 原样保留
 *   - "https://dashscope.aliyuncs.com/api/v1/" → 去掉末尾斜杠
 *   - "https://dashscope.aliyuncs.com/api/v2" → 原样保留（兼容未来版本）
 */
export function normalizeDashScopeBaseUrl(url: string | undefined): string {
  if (!url) return DEFAULT_DASHSCOPE_BASE_URL;

  let normalized = url.trim();
  if (!normalized) return DEFAULT_DASHSCOPE_BASE_URL;

  // 补全协议（用户可能只填了裸域名）
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  // 去掉末尾斜杠，避免拼接出双斜杠
  normalized = normalized.replace(/\/+$/, "");

  // 补全 /api/vN 路径段（仅当缺少时；正则兼容 v1/v2/... 未来版本）
  if (!/\/api\/v\d+$/i.test(normalized)) {
    normalized = `${normalized}/api/v1`;
  }

  return normalized;
}
