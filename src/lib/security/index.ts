export {
  validateUrl,
  validateBackendUrl,
  validateBackendUrlResolved,
  noRedirectFetchOptions,
  isRedirectResponse,
  getRequestNetworkPolicy,
} from "./network-policy";
export type { NetworkPolicy, AddressValidationResult, BackendTopology } from "./network-policy";

export { requireAdmin, AdminAuthenticationError } from "./admin-auth";
export type { AdminPrincipal } from "./admin-auth";
export { encryptSecret, decryptSecret, isEncryptedSecret, SecretConfigurationError } from "./secrets";
export {
  assertPlainObject,
  rejectUnknownKeys,
  readRequiredString,
  readOptionalString,
  readBoolean,
  readEnum,
  readRecord,
  readJsonBodyLimited,
  RequestValidationError,
  UpstreamResponseError,
  readJsonResponseLimited,
} from "./request-validation";

export {
  writeAuditEvent,
  sanitizeForLog,
  maskKey,
  AuditAction,
  AuditTargetType,
} from "./audit";
export type { AuditAction as AuditActionType, AuditTargetType as AuditTargetTypeType, AuditEventInput } from "./audit";

export { assertSafeBackendHeaderValue, validateBackendAuthConfig, resolveBackendAuthHeaders } from "./backend-auth";
export type { BackendAuthType, BackendAuthConfig } from "./backend-auth";

export { resolveLegacyProviderSecrets } from "./provider-secrets";

export { assertModelDiscoveryUrl, ModelDiscoveryPolicyError } from "./model-discovery-policy";

export { requestPinnedJson } from "./pinned-json-request";

export { assertTrustedRequestOrigin } from "./request-origin";
export { assertMutationRequest, type MutationRequestClass } from "./mutation-request";

export {
  buildTrustedProxyProof,
  decodeTrustedProxySecret,
  hasCompleteTrustedProxyProofHeaders,
  TRUSTED_PROXY_HEADER_NAMES,
  verifyTrustedProxyRequest,
  TrustedProxyAuthError,
} from "./trusted-proxy-auth";

export {
  isAuthenticatedLocalClientRequest,
  LOCAL_CLIENT_TOKEN_HEADER,
} from "./local-client-auth";
