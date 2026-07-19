import path from "node:path";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { executionBackends, resourcePools, resourcePoolSlots } from "../src/lib/db/schema";
import { canonicalize } from "../src/lib/generation/workflows/canonical";

const POOL_ID = "local-gpu-4090";

const BACKENDS = [
  {
    id: "comfy-visual-8000",
    displayName: "本地图片与视频服务",
    baseUrl: "http://127.0.0.1:8000",
    capabilities: ["image", "video"],
  },
  {
    id: "comfy-index-8001",
    displayName: "本地 IndexTTS2 服务",
    baseUrl: "http://127.0.0.1:8001",
    capabilities: ["speech"],
  },
  {
    id: "comfy-omni-8002",
    displayName: "本地 OmniVoice 服务",
    baseUrl: "http://127.0.0.1:8002",
    capabilities: ["speech"],
  },
] as const;

function same(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

export async function configureLocalGenerationBackends(): Promise<void> {
  const now = Date.now();
  db.transaction((tx) => {
    const [pool] = tx.select().from(resourcePools).where(eq(resourcePools.id, POOL_ID)).all();
    const expectedPool = {
      id: POOL_ID,
      displayName: "本地 RTX 4090 单卡资源池",
      capacity: 1,
      policyJson: { maxConcurrency: 1, device: "cuda:0" },
    };
    if (!pool) {
      tx.insert(resourcePools).values({ ...expectedPool, createdAtMs: now, updatedAtMs: now }).run();
    } else if (pool.displayName !== expectedPool.displayName || pool.capacity !== 1
      || !same(pool.policyJson, expectedPool.policyJson)) {
      throw new Error("Existing local GPU resource pool conflicts with the required immutable configuration");
    }

    const slots = tx.select().from(resourcePoolSlots)
      .where(eq(resourcePoolSlots.resourcePoolId, POOL_ID)).all();
    if (slots.length === 0) {
      tx.insert(resourcePoolSlots).values({
        resourcePoolId: POOL_ID,
        slotNo: 0,
        ownerAttemptId: null,
        leaseToken: null,
        fencingToken: 0,
        expiresAtMs: null,
        updatedAtMs: now,
      }).run();
    } else if (slots.length !== 1 || slots[0].slotNo !== 0) {
      throw new Error("Local GPU resource pool must have exactly one physical slot numbered zero");
    }

    for (const definition of BACKENDS) {
      const [existing] = tx.select().from(executionBackends)
        .where(eq(executionBackends.id, definition.id)).all();
      const networkPolicyJson = {
        allowedHosts: ["127.0.0.1"],
        allowedPorts: [Number(new URL(definition.baseUrl).port)],
        resolvedAddresses: ["127.0.0.1"],
        rejectRedirects: true,
        allowRedirect: false,
      };
      const capabilitiesJson = { capabilities: [...definition.capabilities] };
      if (!existing) {
        tx.insert(executionBackends).values({
          id: definition.id,
          displayName: definition.displayName,
          adapterKind: "comfyui",
          baseUrl: definition.baseUrl,
          topology: "same-host",
          sharingMode: "dedicated",
          authType: "none",
          authConfigJson: {},
          tlsConfigJson: {},
          networkPolicyJson,
          resourcePoolId: POOL_ID,
          capabilitiesJson,
          environmentFingerprint: null,
          featureSnapshotJson: null,
          validatedAtMs: null,
          enabled: 0,
          createdAtMs: now,
          updatedAtMs: now,
        }).run();
        continue;
      }
      if (existing.displayName !== definition.displayName
        || existing.adapterKind !== "comfyui"
        || existing.baseUrl !== definition.baseUrl
        || existing.topology !== "same-host"
        || existing.sharingMode !== "dedicated"
        || existing.authType !== "none"
        || existing.resourcePoolId !== POOL_ID
        || !same(existing.authConfigJson, {})
        || !same(existing.tlsConfigJson, {})
        || !same(existing.networkPolicyJson, networkPolicyJson)
        || !same(existing.capabilitiesJson, capabilitiesJson)) {
        throw new Error(`Existing backend ${definition.id} conflicts with the required immutable configuration`);
      }
    }
  });
  console.log(JSON.stringify({
    resourcePoolId: POOL_ID,
    backendIds: BACKENDS.map((backend) => backend.id),
    state: "disabled-pending-package-approval",
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  configureLocalGenerationBackends().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
