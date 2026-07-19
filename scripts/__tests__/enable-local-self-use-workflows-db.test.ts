import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/db";
import {
  executionBackends,
  generationProfileRevisions,
  generationProfileStates,
  resourcePools,
  workflowBackendValidations,
  workflowPackageRevisions,
  workflowPackageStates,
} from "../../src/lib/db/schema";
import { setupTestDb, type TestDbContext } from "../../src/lib/test-helpers/db";
import {
  commitLocalActivation,
  type PreparedLocalActivation,
} from "../enable-local-self-use-workflows";

let context: TestDbContext;

beforeAll(async () => {
  context = setupTestDb();
  await db.insert(resourcePools).values({
    id: "local-pool",
    displayName: "Local",
    capacity: 1,
    policyJson: {},
    createdAtMs: 1,
    updatedAtMs: 1,
  });
  await db.insert(executionBackends).values({
    id: "comfy-omni-8002",
    displayName: "Omni",
    adapterKind: "comfyui",
    baseUrl: "http://127.0.0.1:8002",
    topology: "same-host",
    sharingMode: "dedicated",
    authType: "none",
    authConfigJson: {},
    tlsConfigJson: {},
    networkPolicyJson: {},
    resourcePoolId: "local-pool",
    capabilitiesJson: ["speech"],
    environmentFingerprint: "old",
    enabled: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  });
  await db.insert(workflowPackageRevisions).values({
    digest: "workflow-digest",
    workflowId: "workflow",
    version: "1",
    capability: "speech",
    workflowApiJson: {},
    manifestJson: {},
    compiledBindingsJson: {},
    packageLockJson: {},
    packagePath: "package",
    workflowSha256: "workflow-sha",
    environmentLockDigest: "lock",
    compilerVersion: "1.0.0",
    compiledAtMs: 1,
    createdAtMs: 1,
  });
  await db.insert(workflowPackageStates).values({
    workflowPackageDigest: "workflow-digest",
    state: "installed",
    reviewedBy: "formal-reviewer",
    reviewedAtMs: 1,
    updatedAtMs: 1,
  });
  await db.insert(generationProfileRevisions).values([
    {
      id: "profile-old",
      profileKey: "speech-profile",
      revisionNo: 1,
      revisionDigest: "revision-old",
      displayName: "Old",
      capability: "speech",
      adapterKind: "comfyui",
      executionBackendId: "comfy-omni-8002",
      workflowPackageDigest: "workflow-digest",
      configJson: {},
      createdAtMs: 1,
    },
    {
      id: "profile-latest",
      profileKey: "speech-profile",
      revisionNo: 2,
      revisionDigest: "revision-latest",
      displayName: "Latest",
      capability: "speech",
      adapterKind: "comfyui",
      executionBackendId: "comfy-omni-8002",
      workflowPackageDigest: "workflow-digest",
      configJson: {},
      createdAtMs: 2,
    },
  ]);
  await db.insert(generationProfileStates).values([
    {
      generationProfileRevisionId: "profile-old",
      enabled: 1,
      visibility: "workspace",
      updatedAtMs: 1,
    },
    {
      generationProfileRevisionId: "profile-latest",
      enabled: 0,
      visibility: "admin",
      updatedAtMs: 1,
    },
  ]);
  await db.insert(workflowBackendValidations).values({
    id: "release:existing",
    workflowPackageDigest: "workflow-digest",
    executionBackendId: "comfy-omni-8002",
    validationKind: "release",
    environmentFingerprint: "formal-fingerprint",
    environmentLockDigest: "lock",
    reviewerId: "formal-reviewer",
    reportJson: { formal: true },
    validatedAtMs: 1,
    updatedAtMs: 1,
  });
});

afterAll(() => context.cleanup());

describe("local activation database transaction", () => {
  it("preserves release provenance and atomically replaces the visible historical revision", async () => {
    const rows = await db.select({
      profile: generationProfileRevisions,
      profileState: generationProfileStates,
      workflow: workflowPackageRevisions,
      workflowState: workflowPackageStates,
    }).from(generationProfileRevisions)
      .innerJoin(
        generationProfileStates,
        eq(generationProfileStates.generationProfileRevisionId, generationProfileRevisions.id),
      )
      .innerJoin(
        workflowPackageRevisions,
        eq(workflowPackageRevisions.digest, generationProfileRevisions.workflowPackageDigest),
      )
      .innerJoin(
        workflowPackageStates,
        eq(workflowPackageStates.workflowPackageDigest, workflowPackageRevisions.digest),
      );
    const latest = rows.find((row) => row.profile.id === "profile-latest")!;
    const [backend] = await db.select().from(executionBackends)
      .where(eq(executionBackends.id, "comfy-omni-8002"));
    const prepared: PreparedLocalActivation = new Map([[
      backend.id,
      {
        backend,
        features: {
          environmentFingerprint: "local-fingerprint",
        } as never,
        rows: [latest],
        inventories: new Map([[
          "workflow-digest",
          { schemaVersion: 1, models: [], inventoryDigest: "inventory" },
        ]]),
      },
    ]]);

    commitLocalActivation(prepared, rows, 100);

    const validations = await db.select().from(workflowBackendValidations);
    expect(validations).toHaveLength(2);
    expect(validations.find((row) => row.validationKind === "release")).toMatchObject({
      reviewerId: "formal-reviewer",
      environmentFingerprint: "formal-fingerprint",
      reportJson: { formal: true },
    });
    expect(validations.find((row) => row.validationKind === "local-self-use")).toMatchObject({
      reviewerId: "local-self-use",
      environmentFingerprint: "local-fingerprint",
    });
    const states = await db.select().from(generationProfileStates);
    expect(states.find((row) => row.generationProfileRevisionId === "profile-old"))
      .toMatchObject({ enabled: 0, visibility: "admin" });
    expect(states.find((row) => row.generationProfileRevisionId === "profile-latest"))
      .toMatchObject({ enabled: 1, visibility: "workspace" });
    expect((await db.select().from(workflowPackageStates))[0]).toMatchObject({
      state: "installed",
      reviewedBy: "formal-reviewer",
      reviewedAtMs: 1,
    });
  });
});
