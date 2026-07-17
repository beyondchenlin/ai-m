import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComfyUIConnectionManager,
  connectionManagerRegistry,
} from "../comfyui-connection-manager";

type TestSocket = WebSocket & {
  onopen: WebSocket["onopen"];
  onmessage: WebSocket["onmessage"];
  onerror: WebSocket["onerror"];
  onclose: WebSocket["onclose"];
  close: ReturnType<typeof vi.fn>;
};

function socket(): TestSocket {
  return {
    close: vi.fn(), onopen: null, onmessage: null, onerror: null, onclose: null,
  } as unknown as TestSocket;
}

afterEach(() => {
  vi.useRealTimers();
  connectionManagerRegistry.closeAll();
});

describe("ComfyUI connection manager lifecycle", () => {
  it("shares equivalent identities while isolating credential and policy identities", () => {
    const firstFactory = {
      canonicalEndpoint: "http://comfy.policy.test:8188",
      registryKey: "endpoint:credential-a:policy-1",
      open: () => socket(),
    };
    const sameFactory = { ...firstFactory, open: () => socket() };
    const rotatedCredential = { ...firstFactory, registryKey: "endpoint:credential-b:policy-1", open: () => socket() };
    const revisedPolicy = { ...firstFactory, registryKey: "endpoint:credential-b:policy-2", open: () => socket() };

    const first = connectionManagerRegistry.acquire(firstFactory);
    const concurrent = Array.from({ length: 20 }, () => connectionManagerRegistry.acquire(sameFactory));
    expect(new Set(concurrent.map((lease) => lease.manager))).toEqual(new Set([first.manager]));

    const second = connectionManagerRegistry.acquire(rotatedCredential);
    expect(second.manager).not.toBe(first.manager);

    const third = connectionManagerRegistry.acquire(revisedPolicy);
    expect(third.manager).not.toBe(second.manager);
    for (const lease of [first, ...concurrent, second, third]) lease.release();
  });

  it("bounds default reconnect attempts and disconnect clears timers and socket handlers", async () => {
    vi.useFakeTimers();
    const created: TestSocket[] = [];
    const manager = new ComfyUIConnectionManager(() => {
      const next = socket();
      created.push(next);
      return next;
    }, { initialDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 });

    manager.connect();
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = created.at(-1)!;
      current.onclose?.call(current, { code: 1006 } as CloseEvent);
      await vi.advanceTimersToNextTimerAsync();
    }

    expect(created.length).toBeLessThanOrEqual(6);
    const finalSocket = created.at(-1)!;
    finalSocket.onclose?.call(finalSocket, { code: 1006 } as CloseEvent);
    manager.disconnect();
    await vi.runAllTimersAsync();
    expect(created.length).toBeLessThanOrEqual(6);
    expect(finalSocket.onopen).toBeNull();
    expect(finalSocket.onmessage).toBeNull();
    expect(finalSocket.onerror).toBeNull();
    expect(finalSocket.onclose).toBeNull();
  });

  it("exhausts the reconnect budget when sockets open and immediately drop", async () => {
    vi.useFakeTimers();
    let created = 0;
    const manager = new ComfyUIConnectionManager(() => {
      created++;
      const next = socket();
      queueMicrotask(() => {
        next.onopen?.call(next, new Event("open"));
        next.onclose?.call(next, { code: 1006 } as CloseEvent);
      });
      return next;
    }, { initialDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 });

    manager.connect();
    for (let attempt = 0; attempt < 10; attempt++) {
      await vi.runAllTicks();
      await vi.advanceTimersToNextTimerAsync();
    }

    expect(created).toBeLessThanOrEqual(6);
    expect(manager.getState()).toBe("disconnected");
    manager.disconnect();
  });

  it("cancels a pending reconnect before an explicit connect creates a healthy socket", async () => {
    vi.useFakeTimers();
    const created: TestSocket[] = [];
    const manager = new ComfyUIConnectionManager(() => {
      const next = socket();
      created.push(next);
      return next;
    }, { initialDelayMs: 10, maxDelayMs: 10, jitterFactor: 0 });

    manager.connect();
    created[0].onclose?.call(created[0], { code: 1006 } as CloseEvent);
    manager.connect();
    created[1].onopen?.call(created[1], new Event("open"));
    await vi.runAllTimersAsync();

    expect(created).toHaveLength(2);
    expect(created[1].close).not.toHaveBeenCalled();
    expect(manager.getState()).toBe("connected");
    manager.disconnect();
  });

  it("retires a rotated identity only after every existing lease releases", () => {
    const oldFactory = {
      canonicalEndpoint: "http://comfy.policy.test:8188",
      registryKey: "endpoint:credential-a:policy-1",
      open: () => socket(),
    };
    const rotatedFactory = {
      ...oldFactory,
      registryKey: "endpoint:credential-b:policy-2",
      open: () => socket(),
    };
    type Lease = { manager: ComfyUIConnectionManager; release(): void };
    const registry = connectionManagerRegistry as unknown as {
      acquire(factory: typeof oldFactory): Lease;
    };

    const oldA = registry.acquire(oldFactory);
    const oldB = registry.acquire(oldFactory);
    oldA.manager.connect();
    const rotated = registry.acquire(rotatedFactory);

    expect(rotated.manager).not.toBe(oldA.manager);
    expect(oldA.manager.getState()).toBe("connecting");
    oldA.release();
    oldA.release();
    expect(oldA.manager.getState()).toBe("connecting");
    oldB.release();
    expect(oldA.manager.getState()).toBe("disconnected");
    rotated.release();
    expect(connectionManagerRegistry.getAll()).toHaveLength(0);
  });

  it("shares one client ID within an entry and rotates it after the final lease releases", () => {
    const factory = {
      canonicalEndpoint: "http://comfy.policy.test:8188",
      registryKey: "endpoint:credential-a:policy-1",
      open: () => socket(),
    };
    const first = connectionManagerRegistry.acquire(factory) as { manager: ComfyUIConnectionManager; clientId?: string; release(): void };
    const concurrent = connectionManagerRegistry.acquire(factory) as { manager: ComfyUIConnectionManager; clientId?: string; release(): void };

    expect(first.clientId).toBeTruthy();
    expect(concurrent.clientId).toBe(first.clientId);
    first.release();
    concurrent.release();

    const replacement = connectionManagerRegistry.acquire(factory) as { manager: ComfyUIConnectionManager; clientId?: string; release(): void };
    expect(replacement.clientId).not.toBe(first.clientId);
    replacement.release();
  });

  it("ignores delayed events from a socket replaced by reconnect", async () => {
    vi.useFakeTimers();
    const created: TestSocket[] = [];
    const manager = new ComfyUIConnectionManager(() => {
      const next = socket();
      created.push(next);
      return next;
    }, { initialDelayMs: 1, maxDelayMs: 1, jitterFactor: 0 });

    manager.connect();
    const stale = created[0];
    stale.onopen?.call(stale, new Event("open"));
    const delayedClose = stale.onclose!;
    stale.onerror?.call(stale, new Event("error"));
    expect(stale.close).toHaveBeenCalledOnce();
    await vi.advanceTimersToNextTimerAsync();

    const current = created[1];
    current.onopen?.call(current, new Event("open"));
    const generation = manager.getGeneration();
    delayedClose.call(stale, { code: 1006 } as CloseEvent);

    expect(manager.getState()).toBe("connected");
    expect(manager.getGeneration()).toBe(generation);
    await vi.runAllTimersAsync();
    expect(created).toHaveLength(2);
    manager.disconnect();
  });
});
