import { describe, expect, it } from "vitest";
import {
  applyStaticPolicy,
  captureEnvironmentFingerprint,
  compareEnvironmentFingerprints,
  validateWorkflowStructure,
} from "../validator";

function makeWorkflow(classTypes: string[]): Record<string, unknown> {
  return Object.fromEntries(classTypes.map((classType, index) => [String(index + 1), {
    class_type: classType,
    inputs: {},
  }]));
}

describe("workflow structure validation", () => {
  it("rejects an empty workflow", () => {
    const result = validateWorkflowStructure({});
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("no executable nodes"))).toBe(true);
  });

  it("enforces node and class limits", () => {
    const workflow = makeWorkflow(["A", "B", "C", "D"]);
    expect(validateWorkflowStructure(workflow, { maxNodes: 3 }).valid).toBe(false);
    expect(validateWorkflowStructure(workflow, { maxNodeClasses: 3 }).valid).toBe(false);
  });

  it("enforces the platform node allowlist when supplied", () => {
    const result = validateWorkflowStructure(makeWorkflow(["Allowed", "Forbidden"]), {
      allowedNodeClasses: ["Allowed"],
    });
    expect(result.errors).toContain("Node class not allowed: Forbidden");
  });

  it("rejects malformed official node maps", () => {
    const result = validateWorkflowStructure({ nonNumeric: { class_type: "A", inputs: {} } });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes("numeric"))).toBe(true);
  });

  it("produces a stable digest", () => {
    const workflow = makeWorkflow(["KSampler"]);
    expect(validateWorkflowStructure(workflow).digest).toBe(validateWorkflowStructure(workflow).digest);
  });
});

describe("workflow static policy", () => {
  it.each(["../etc/passwd", "..\\Windows\\System32", "/etc/passwd", "C:\\Windows\\win.ini", "https://example.com/file"])(
    "rejects unsafe static input %s",
    (unsafe) => {
      const workflow = { "1": { class_type: "LoadImage", inputs: { image: unsafe } } };
      const result = applyStaticPolicy(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors.some((error) => error.includes("Unsafe static workflow input"))).toBe(true);
    },
  );

  it("accepts a normal relative model/input name", () => {
    const workflow = { "1": { class_type: "LoadImage", inputs: { image: "approved-input.png" } } };
    expect(applyStaticPolicy(workflow).valid).toBe(true);
  });

  it("blocks platform-owned dangerous node classes", () => {
    const result = applyStaticPolicy(makeWorkflow(["ShellCommand"]));
    expect(result.errors).toContain("Blocked node class: ShellCommand");
  });
});

describe("environment fingerprint", () => {
  it("captures stable compatibility fields", () => {
    const fingerprint = captureEnvironmentFingerprint();
    expect(fingerprint.os).toBe(process.platform);
    expect(fingerprint.nodeVersion).toBe(process.version);
    expect(fingerprint.architecture).toBe(process.arch);
    expect(typeof fingerprint.capturedAtMs).toBe("number");
  });

  it("ignores capture timestamp but detects runtime drift", () => {
    const expected = captureEnvironmentFingerprint();
    const same = { ...expected, capturedAtMs: Number(expected.capturedAtMs) + 1 };
    expect(compareEnvironmentFingerprints(expected, same).compatible).toBe(true);
    const drifted = { ...same, os: "another-os" };
    const result = compareEnvironmentFingerprints(expected, drifted);
    expect(result.compatible).toBe(false);
    expect(result.differences.some((difference) => difference.startsWith("os:"))).toBe(true);
  });
});
