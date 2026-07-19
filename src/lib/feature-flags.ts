/**
 * v2.0 功能开关机制
 *
 * 所有新功能通过开关控制，支持服务端控制、小范围灰度、回滚不删数据。
 * 开关默认关闭，确保未完成功能不影响生产。
 *
 * 使用方式：
 *   import { isEnabled, FF } from "@/lib/feature-flags";
 *   if (await isEnabled(FF.V2_BACKEND_CONFIG)) { ... }
 *
 * 环境变量：
 *   FF_V2_BACKEND_CONFIG=1       启用服务端后端配置
 *   FF_V2_GENERATION_PROFILES=1  启用生成配置修订版
 *   FF_V2_DURABLE_EXECUTION=1    启用持久任务执行
 *   FF_V2_WORKFLOW_SUPPLY_CHAIN=1 启用工作流供应链
 *   FF_V2_COMFYUI_TRANSPORT=1    启用 ComfyUI 传输适配器
 *   FF_V2_MEDIA_ARCHIVING=1      启用安全媒体归档
 *   FF_V2_LOCAL_IMAGE=1          启用本地图片生成
 *   FF_V2_LOCAL_SPEECH=1         启用本地语音生成
 */

/** 功能开关枚举 */
export const FF = {
  /** PR-01: 服务端后端配置与密钥管理 */
  V2_BACKEND_CONFIG: "V2_BACKEND_CONFIG",
  /** PR-02: 独立能力接口与生成配置领域 */
  V2_GENERATION_PROFILES: "V2_GENERATION_PROFILES",
  /** PR-03: 持久任务执行与独立 Worker */
  V2_DURABLE_EXECUTION: "V2_DURABLE_EXECUTION",
  /** PR-04: 工作流包、编译器与环境验证 */
  V2_WORKFLOW_SUPPLY_CHAIN: "V2_WORKFLOW_SUPPLY_CHAIN",
  /** PR-05: ComfyUI 传输适配器与安全取消 */
  V2_COMFYUI_TRANSPORT: "V2_COMFYUI_TRANSPORT",
  /** PR-06: 流式媒体归档与原子提交 */
  V2_MEDIA_ARCHIVING: "V2_MEDIA_ARCHIVING",
  /** PR-07: 本地造相快速闭环 */
  V2_LOCAL_IMAGE: "V2_LOCAL_IMAGE",
  /** PR-09: 本地语音能力 */
  V2_LOCAL_SPEECH: "V2_LOCAL_SPEECH",
} as const;

export type FeatureFlag = (typeof FF)[keyof typeof FF];

/** 开关来源优先级：环境变量 > 默认值（全部关闭） */
const DEFAULTS: Record<FeatureFlag, boolean> = {
  [FF.V2_BACKEND_CONFIG]: false,
  [FF.V2_GENERATION_PROFILES]: false,
  [FF.V2_DURABLE_EXECUTION]: false,
  [FF.V2_WORKFLOW_SUPPLY_CHAIN]: false,
  [FF.V2_COMFYUI_TRANSPORT]: false,
  [FF.V2_MEDIA_ARCHIVING]: false,
  [FF.V2_LOCAL_IMAGE]: false,
  [FF.V2_LOCAL_SPEECH]: false,
};

/** 检查功能开关是否启用 */
export function isEnabled(flag: FeatureFlag): boolean {
  const envValue = process.env[`FF_${flag}`];
  if (envValue !== undefined) {
    return envValue === "1" || envValue.toLowerCase() === "true";
  }
  return DEFAULTS[flag] ?? false;
}

/**
 * Restrict an enabled feature to an exact project allowlist.
 *
 * If FF_<FLAG>_PROJECTS is absent, the global flag applies to every project.
 * If present, empty, oversized, or malformed values fail closed.
 */
export function isEnabledForProject(flag: FeatureFlag, projectId: string): boolean {
  if (!isEnabled(flag)) return false;
  const raw = process.env[`FF_${flag}_PROJECTS`];
  if (raw === undefined) return true;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(projectId)) return false;
  if (raw.length > 16_384) return false;
  const values = raw.split(",").map((value) => value.trim());
  if (values.length < 1 || values.length > 200
    || values.some((value) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value))) {
    return false;
  }
  return new Set(values).has(projectId);
}

/** 批量检查：返回所有已启用的开关列表 */
export function enabledFlags(): FeatureFlag[] {
  return Object.values(FF).filter((f) => isEnabled(f));
}
