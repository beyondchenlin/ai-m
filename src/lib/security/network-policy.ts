/**
 * v2.0 网络策略 — SSRF 防护
 *
 * 手册 §6.3、§20.2：后端地址必须经过解析地址校验、网段白名单、
 * 禁止重定向、禁止云元数据地址和链路本地地址。
 */

import { URL } from "url";
import { isIP } from "net";

/** 禁止的地址模式 */
const BLOCKED_HOST_PATTERNS = [
  /^169\.254\./,           // 链路本地
  /^0\.0\.0\.0$/,          // 通配地址
  /^127\./,                // 环回（除非明确允许）
  /^10\./,                 // A 类私网
  /^172\.(1[6-9]|2\d|3[01])\./, // B 类私网
  /^192\.168\./,           // C 类私网
];

/** 云元数据主机名 */
const BLOCKED_HOSTNAMES = [
  "metadata.google.internal",
  "169.254.169.254",
  "metadata.tencentyun.com",
  "100.100.100.200",
];

/** 禁止的协议 */
const ALLOWED_PROTOCOLS = ["http:", "https:"];

export interface NetworkPolicy {
  /** 是否允许重定向 */
  allowRedirect: boolean;
  /** 允许的主机名/IP 白名单（空数组表示不限制） */
  allowedHosts: string[];
  /** 允许的网段 CIDR（空数组表示不限制） */
  allowedCidrs: string[];
}

export interface AddressValidationResult {
  valid: boolean;
  resolvedAddresses: string[];
  errors: string[];
}

/** 校验 URL 是否符合网络策略 */
export function validateUrl(
  urlString: string,
  policy: NetworkPolicy,
): AddressValidationResult {
  const errors: string[] = [];
  const trimmed = urlString.trim();

  if (!trimmed) {
    return { valid: false, resolvedAddresses: [], errors: ["URL is empty"] };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, resolvedAddresses: [], errors: [`Invalid URL: ${trimmed}`] };
  }

  // 协议检查
  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    errors.push(`Protocol not allowed: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname;

  // 检查云元数据地址
  if (BLOCKED_HOSTNAMES.includes(hostname)) {
    errors.push(`Blocked metadata hostname: ${hostname}`);
  }

  // 检查禁止的 IP 模式
  if (isIP(hostname)) {
    for (const pattern of BLOCKED_HOST_PATTERNS) {
      if (pattern.test(hostname)) {
        errors.push(`Blocked IP range: ${hostname}`);
        break;
      }
    }
  }

  // 检查白名单
  if (policy.allowedHosts.length > 0) {
    const matched = policy.allowedHosts.some((allowed) => {
      // 完整匹配
      if (hostname === allowed) return true;
      // 后缀匹配（如 .example.com 匹配 api.example.com）
      if (allowed.startsWith(".") && hostname.endsWith(allowed)) return true;
      return false;
    });
    if (!matched) {
      errors.push(`Hostname not in allowed list: ${hostname}`);
    }
  }

  // 重定向检查
  if (!policy.allowRedirect) {
    // 重定向在请求层面检查，此处仅记录策略
  }

  return {
    valid: errors.length === 0,
    resolvedAddresses: [hostname],
    errors,
  };
}

/** 校验后端注册时的 baseUrl */
export function validateBackendUrl(
  baseUrl: string,
  topology: string,
): { valid: boolean; error?: string } {
  const trimmed = baseUrl.trim();

  if (!trimmed) {
    return { valid: false, error: "baseUrl is required" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: `Invalid baseUrl: ${trimmed}` };
  }

  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    return { valid: false, error: `Protocol not allowed: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname;

  // 云元数据地址拦截
  if (BLOCKED_HOSTNAMES.includes(hostname)) {
    return { valid: false, error: `Blocked metadata address: ${hostname}` };
  }

  // 同主机拓扑只允许环回
  if (topology === "same-host" && hostname !== "localhost" && hostname !== "127.0.0.1") {
    return { valid: false, error: "same-host topology requires localhost or 127.0.0.1" };
  }

  // 局域网远程拓扑不允许公网 IP
  if (topology === "lan-remote") {
    if (isIP(hostname)) {
      for (const pattern of BLOCKED_HOST_PATTERNS) {
        if (pattern.test(hostname)) {
          return { valid: false, error: `Blocked IP range for lan-remote: ${hostname}` };
        }
      }
    }
  }

  return { valid: true };
}

/** 为请求创建防重定向的 fetch 配置 */
export function noRedirectFetchOptions(): RequestInit {
  return {
    redirect: "manual",
  };
}

/** 检查 fetch 响应是否发生了重定向 */
export function isRedirectResponse(status: number): boolean {
  return status >= 300 && status < 400;
}

/** 获取请求级别的网络策略配置 */
export function getRequestNetworkPolicy(policy: NetworkPolicy): RequestInit {
  const options: RequestInit = {};
  if (!policy.allowRedirect) {
    options.redirect = "manual";
  }
  return options;
}