import { describe, expect, it } from "vitest";
import {
  allowedWorkflowValidationKinds,
  localSelfUseModeEnabled,
  selectApplicableWorkflowValidation,
  workflowStateAllowedForValidation,
} from "../validation-policy";

const localEnvironment = {
  AI_M_LOCAL_SELF_USE: "true",
  AI_M_USER_IDENTITY_MODE: "single-user",
  AI_M_SINGLE_USER_ID: "local-user",
};

describe("workflow validation policy", () => {
  it("requires all three explicit local self-use controls", () => {
    expect(localSelfUseModeEnabled(localEnvironment)).toBe(true);
    expect(localSelfUseModeEnabled({ ...localEnvironment, AI_M_LOCAL_SELF_USE: "false" })).toBe(false);
    expect(localSelfUseModeEnabled({ ...localEnvironment, AI_M_USER_IDENTITY_MODE: "trusted-proxy" })).toBe(false);
    expect(localSelfUseModeEnabled({ ...localEnvironment, AI_M_SINGLE_USER_ID: "bad user" })).toBe(false);
  });

  it("ignores local validations when local mode is off", () => {
    expect(allowedWorkflowValidationKinds({})).toEqual(["release"]);
    expect(workflowStateAllowedForValidation("local-self-use", "installed", {})).toBe(false);
  });

  it("keeps release activation strict while allowing local imported states locally", () => {
    expect(allowedWorkflowValidationKinds(localEnvironment))
      .toEqual(["release", "local-self-use"]);
    expect(workflowStateAllowedForValidation("release", "reviewed", localEnvironment)).toBe(false);
    expect(workflowStateAllowedForValidation("release", "active", localEnvironment)).toBe(true);
    expect(workflowStateAllowedForValidation("local-self-use", "installed", localEnvironment)).toBe(true);
    expect(workflowStateAllowedForValidation("local-self-use", "revoked", localEnvironment)).toBe(false);
  });

  it("chooses an applicable local validation when an inapplicable release validation coexists", () => {
    const validations = [
      {
        validationKind: "release" as const,
        environmentFingerprint: "fingerprint",
        environmentLockDigest: "lock",
      },
      {
        validationKind: "local-self-use" as const,
        environmentFingerprint: "fingerprint",
        environmentLockDigest: "lock",
      },
    ];
    expect(selectApplicableWorkflowValidation(validations, {
      workflowState: "installed",
      backendFingerprint: "fingerprint",
      workflowLockDigest: "lock",
      environment: localEnvironment,
    })?.validationKind).toBe("local-self-use");
    expect(selectApplicableWorkflowValidation(validations, {
      workflowState: "active",
      backendFingerprint: "fingerprint",
      workflowLockDigest: "lock",
      environment: localEnvironment,
    })?.validationKind).toBe("release");
  });

  it("rejects every validation when the backend or lock drifted", () => {
    const validation = [{
      validationKind: "release" as const,
      environmentFingerprint: "old",
      environmentLockDigest: "old-lock",
    }];
    expect(selectApplicableWorkflowValidation(validation, {
      workflowState: "active",
      backendFingerprint: "new",
      workflowLockDigest: "new-lock",
    })).toBeNull();
  });
});
