/**
 * PR-11: 工作流结构约束与静态策略测试
 */

import { describe, it, expect } from "vitest";
import {
  validateWorkflowStructure,
  applyStaticPolicy,
  captureEnvironmentFingerprint,
  compareEnvironmentFingerprints,
} from "../validator";

function makeNode(classType: string, inputs: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: Math.random().toString(36).slice(2),
    class_type: classType,
    inputs,
  };
}

function makeWorkflow(nodes: Record<string, unknown>[], outputs: unknown[] = []): Record<string, unknown> {
  return { nodes, outputs };
}

describe("PR-11: 工作流结构约束", () => {
  it("空工作流应被拒绝", () => {
    const result = validateWorkflowStructure(makeWorkflow([]));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Workflow has no nodes");
    expect(result.nodeCount).toBe(0);
  });

  it("节点数超过上限应被拒绝", () => {
    const nodes = Array.from({ length: 5 }, () => makeNode("KSampler"));
    const result = validateWorkflowStructure(makeWorkflow(nodes), { maxNodes: 3 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("5 nodes, max is 3"))).toBe(true);
  });

  it("节点类超过上限应被拒绝", () => {
    const nodes = [
      makeNode("A"),
      makeNode("B"),
      makeNode("C"),
    ];
    const result = validateWorkflowStructure(makeWorkflow(nodes), { maxNodeClasses: 2 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("3 node classes, max is 2"))).toBe(true);
  });

  it("允许通配符 * 时接受任意节点类", () => {
    const result = validateWorkflowStructure(makeWorkflow([makeNode("CustomNode")]));
    expect(result.valid).toBe(true);
    expect(result.nodeClasses.has("CustomNode")).toBe(true);
  });

  it("未在允许列表的节点类应被拒绝", () => {
    const result = validateWorkflowStructure(makeWorkflow([makeNode("ForbiddenNode")]), {
      allowedNodeClasses: ["KSampler", "CheckpointLoaderSimple"],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Node class not allowed: ForbiddenNode");
  });

  it("输出数超过上限应被拒绝", () => {
    const outputs = Array.from({ length: 5 }, (_, i) => ({ name: `out${i}` }));
    const result = validateWorkflowStructure(makeWorkflow([makeNode("SaveImage")], outputs), { maxOutputs: 3 });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("5 outputs, max is 3"))).toBe(true);
  });

  it("无输出应产生警告但不被拒绝", () => {
    const result = validateWorkflowStructure(makeWorkflow([makeNode("KSampler")], []));
    expect(result.valid).toBe(true);
    expect(result.warnings).toContain("Workflow has no outputs defined");
  });

  it("摘要应对相同工作流保持稳定", () => {
    const workflow = makeWorkflow([makeNode("KSampler")], [{ name: "preview" }]);
    const a = validateWorkflowStructure(workflow);
    const b = validateWorkflowStructure(workflow);
    expect(a.digest).toBe(b.digest);
    expect(a.digest.startsWith("sha256:")).toBe(true);
  });

  it("工作流结构变化后摘要应变化", () => {
    const a = validateWorkflowStructure(makeWorkflow([makeNode("KSampler")]));
    const b = validateWorkflowStructure(makeWorkflow([makeNode("KSampler2")]));
    expect(a.digest).not.toBe(b.digest);
  });

  it("无 class_type 的节点不计入节点类但仍计入节点数", () => {
    const result = validateWorkflowStructure(makeWorkflow([{ inputs: {} }, makeNode("KSampler")]));
    expect(result.nodeCount).toBe(2);
    expect(result.nodeClasses.has("KSampler")).toBe(true);
    expect(result.nodeClasses.size).toBe(1);
    expect(result.valid).toBe(true);
  });

  it("重复的 class_type 不重复计数", () => {
    const result = validateWorkflowStructure(makeWorkflow([makeNode("KSampler"), makeNode("KSampler")]));
    expect(result.nodeCount).toBe(2);
    expect(result.nodeClasses.size).toBe(1);
  });

  it("未知顶层字段不破坏结构验证", () => {
    const workflow = makeWorkflow([makeNode("KSampler")]);
    (workflow as Record<string, unknown>).unknownField = "should be ignored";
    const result = validateWorkflowStructure(workflow);
    expect(result.valid).toBe(true);
  });
});

describe("PR-11: 静态策略", () => {
  it("应检测节点输入中的路径穿越", () => {
    const workflow = makeWorkflow([
      makeNode("LoadImage", { image: "../etc/passwd" }),
    ]);
    const result = applyStaticPolicy(workflow);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Path traversal detected"))).toBe(true);
  });

  it("应检测 Windows 风格路径穿越", () => {
    const workflow = makeWorkflow([
      makeNode("LoadImage", { image: "..\\Windows\\System32\\cmd.exe" }),
    ]);
    const result = applyStaticPolicy(workflow);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Path traversal detected"))).toBe(true);
  });

  it("正常路径不应触发路径穿越", () => {
    const workflow = makeWorkflow([
      makeNode("LoadImage", { image: "models/checkpoint.safetensors" }),
    ]);
    const result = applyStaticPolicy(workflow);
    expect(result.valid).toBe(true);
  });

  it("禁止的节点类应被拒绝", () => {
    const workflow = makeWorkflow([makeNode("DangerousNode")]);
    const result = applyStaticPolicy(workflow, { blockedNodeClasses: ["DangerousNode"] });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Blocked node class: DangerousNode");
  });

  it("关闭路径穿越检查时不应拦截", () => {
    const workflow = makeWorkflow([
      makeNode("LoadImage", { image: "../etc/passwd" }),
    ]);
    const result = applyStaticPolicy(workflow, { enforcePathTraversalCheck: false });
    expect(result.valid).toBe(true);
  });
});

describe("PR-11: 环境指纹", () => {
  it("应捕获关键环境信息", () => {
    const fp = captureEnvironmentFingerprint();
    expect(fp.os).toBe(process.platform);
    expect(fp.nodeVersion).toBe(process.version);
    expect(fp.architecture).toBe(process.arch);
    expect(typeof fp.timestamp).toBe("number");
  });

  it("相同环境指纹应判定为兼容", () => {
    const fp = captureEnvironmentFingerprint();
    const { compatible, differences } = compareEnvironmentFingerprints(fp, fp);
    expect(compatible).toBe(true);
    expect(differences).toHaveLength(0);
  });

  it("不同平台或 Node 版本应判定为不兼容", () => {
    const baseline = captureEnvironmentFingerprint();
    const current = { ...baseline, os: "another-os" };
    const { compatible, differences } = compareEnvironmentFingerprints(baseline, current);
    expect(compatible).toBe(false);
    expect(differences.some((d) => d.startsWith("os:"))).toBe(true);
  });
});
