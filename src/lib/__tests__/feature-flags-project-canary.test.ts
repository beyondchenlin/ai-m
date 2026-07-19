import { afterEach, describe, expect, it } from "vitest";
import { FF, isEnabledForProject } from "../feature-flags";

const flag = `FF_${FF.V2_DURABLE_EXECUTION}`;
const projects = `${flag}_PROJECTS`;
const originalFlag = process.env[flag];
const originalProjects = process.env[projects];

afterEach(() => {
  if (originalFlag === undefined) delete process.env[flag];
  else process.env[flag] = originalFlag;
  if (originalProjects === undefined) delete process.env[projects];
  else process.env[projects] = originalProjects;
});

describe("project canary feature gates", () => {
  it("inherits a globally enabled flag when no allowlist is configured", () => {
    process.env[flag] = "1";
    delete process.env[projects];
    expect(isEnabledForProject(FF.V2_DURABLE_EXECUTION, "project-a")).toBe(true);
  });

  it("allows only exact project IDs in the canary allowlist", () => {
    process.env[flag] = "1";
    process.env[projects] = "project-a, project-b";
    expect(isEnabledForProject(FF.V2_DURABLE_EXECUTION, "project-a")).toBe(true);
    expect(isEnabledForProject(FF.V2_DURABLE_EXECUTION, "project")).toBe(false);
    expect(isEnabledForProject(FF.V2_DURABLE_EXECUTION, "project-c")).toBe(false);
  });

  it("fails closed for disabled flags and malformed or empty allowlists", () => {
    process.env[flag] = "0";
    process.env[projects] = "project-a";
    expect(isEnabledForProject(FF.V2_DURABLE_EXECUTION, "project-a")).toBe(false);
    process.env[flag] = "1";
    process.env[projects] = "";
    expect(isEnabledForProject(FF.V2_DURABLE_EXECUTION, "project-a")).toBe(false);
    process.env[projects] = "project-a,*";
    expect(isEnabledForProject(FF.V2_DURABLE_EXECUTION, "project-a")).toBe(false);
  });
});
