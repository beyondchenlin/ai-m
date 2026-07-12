// DashScope / 阿里云百炼 MaaS 的 baseUrl 规范化工具
//
// 背景说明
//   标准 DashScope 公网入口：https://dashscope.aliyuncs.com/api/v1
//   VPC 内网入口示例：       https://llm-xxx.cn-beijing.maas.aliyuncs.com/api/v1
//   新加坡地域入口：         https://dashscope-intl.aliyuncs.com/api/v1
//
//   阿里云百炼有两套 API 体系，路径不同：
//     - DashScope 原生 API（图像/视频生成等）：走 /api/v1/services/...
//     - OpenAI 兼容模式（文本对话等）：       走 /compatible-mode/v1/chat/completions
//   本项目 dashscope-image / wan-video provider 使用的是 DashScope 原生 API，
//   因此 baseUrl 必须以 /api/v1 结尾，不能是 /compatible-mode/v1。
//
//   用户在设置界面可能填了以下格式，导致请求失败：
//     - 缺协议头（只填裸域名）               → fetch 抛 "Failed to parse URL"
//     - 缺 /api/v1 路径段                     → 服务端返回 404
//     - 填了 /compatible-mode/v1（OpenAI 兼容模式入口）→ 走错 API 体系，404
//
//   此函数统一做兼容处理，让用户无论填哪种格式都能正确工作。

export const DEFAULT_DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";

/**
 * 规范化 DashScope 风格的 baseUrl：
 * 1. 自动补全 https:// 协议（用户可能只填了域名）
 * 2. 剥离 /compatible-mode/vN 路径段（OpenAI 兼容模式入口不适用于原生 API）
 * 3. 自动补全 /api/v1 路径段（DashScope / MaaS 原生 API 均需要此前缀）
 *
 * 兼容以下输入：
 *   - "" / undefined                                          → 默认公网入口
 *   - "   "                                                   → 默认公网入口（纯空白视为未填）
 *   - "llm-xxx.cn-beijing.maas.aliyuncs.com"                  → 补全协议 + /api/v1
 *   - "https://llm-xxx.cn-beijing.maas.aliyuncs.com"          → 补全 /api/v1
 *   - "https://llm-xxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
 *                                                             → 剥离兼容模式 + 补全 /api/v1
 *   - "https://dashscope.aliyuncs.com/api/v1"                 → 原样保留
 *   - "https://dashscope.aliyuncs.com/api/v1/"                → 去掉末尾斜杠
 *   - "https://dashscope.aliyuncs.com/api/v2"                 → 原样保留（兼容未来版本）
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

  // 剥离 OpenAI 兼容模式路径段（/compatible-mode/vN）
  // 阿里云百炼 VPC 内网域名同时暴露 /compatible-mode/v1 和 /api/v1 两套入口，
  // 用户可能从兼容模式文档复制了地址，但 dashscope-image/wan-video 走原生 API，
  // 必须用 /api/v1。剥离后由后续逻辑补全 /api/v1。
  normalized = normalized.replace(/\/compatible-mode\/v\d+$/i, "");

  // 补全 /api/vN 路径段（仅当缺少时；正则兼容 v1/v2/... 未来版本）
  if (!/\/api\/v\d+$/i.test(normalized)) {
    normalized = `${normalized}/api/v1`;
  }

  return normalized;
}
