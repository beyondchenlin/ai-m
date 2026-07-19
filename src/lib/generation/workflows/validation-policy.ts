export const WORKFLOW_VALIDATION_KINDS = ["release", "local-self-use"] as const;
export type WorkflowValidationKind = typeof WORKFLOW_VALIDATION_KINDS[number];

const SINGLE_USER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

export function localSelfUseModeEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const userId = environment.AI_M_SINGLE_USER_ID?.trim() ?? "";
  return environment.AI_M_LOCAL_SELF_USE === "true"
    && environment.AI_M_USER_IDENTITY_MODE === "single-user"
    && SINGLE_USER_ID_PATTERN.test(userId);
}

export function allowedWorkflowValidationKinds(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WorkflowValidationKind[] {
  return localSelfUseModeEnabled(environment)
    ? ["release", "local-self-use"]
    : ["release"];
}

export function workflowValidationId(
  kind: WorkflowValidationKind,
  pairDigest: string,
): string {
  return `${kind}:${pairDigest}`;
}

export function workflowStateAllowedForValidation(
  kind: WorkflowValidationKind,
  state: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (kind === "release") return state === "active";
  return localSelfUseModeEnabled(environment)
    && ["installed", "reviewed", "active"].includes(state);
}

export function selectApplicableWorkflowValidation<T extends {
  validationKind: WorkflowValidationKind;
  environmentFingerprint: string;
  environmentLockDigest: string | null;
}>(
  validations: readonly T[],
  context: {
    workflowState: string;
    backendFingerprint: string | null;
    workflowLockDigest: string | null;
    environment?: Readonly<Record<string, string | undefined>>;
  },
): T | null {
  if (!context.backendFingerprint) return null;
  const allowedKinds = new Set(allowedWorkflowValidationKinds(context.environment));
  const applicable = validations.filter((validation) => (
    allowedKinds.has(validation.validationKind)
    && workflowStateAllowedForValidation(
      validation.validationKind,
      context.workflowState,
      context.environment,
    )
    && validation.environmentFingerprint === context.backendFingerprint
    && validation.environmentLockDigest === context.workflowLockDigest
  ));
  return applicable.find((validation) => validation.validationKind === "release")
    ?? applicable.find((validation) => validation.validationKind === "local-self-use")
    ?? null;
}
