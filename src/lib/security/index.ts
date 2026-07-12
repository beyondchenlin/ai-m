/**
 * v2.0 security 模块入口
 */

export {
  validateUrl,
  validateBackendUrl,
  noRedirectFetchOptions,
  isRedirectResponse,
  getRequestNetworkPolicy,
} from "./network-policy";
export type { NetworkPolicy, AddressValidationResult } from "./network-policy";

export {
  writeAuditEvent,
  sanitizeForLog,
  maskKey,
  AuditAction,
  AuditTargetType,
} from "./audit";
export type { AuditAction as AuditActionType, AuditTargetType as AuditTargetTypeType, AuditEventInput } from "./audit";