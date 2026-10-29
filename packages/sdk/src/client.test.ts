import { describe, expect, it, vi } from "vitest";
import type { SchemaDefinition } from "@lattice/types";
import {
  AuthPersistenceError,
  ClientTooOldError,
  ConfigFetchError,
  ProductClient,
  RealtimeURLMismatchError,
  createDesktopStorage,
  createMemoryStorage,
  createMobileStorage,
  createWebStorage,
  fetchAppConfig,
  type StorageAdapter,
} from "@lattice/sdk";

const config = {
  version: 1,
  tenant_id: "tenant_dev",
  backend_url: "https://acme.app.example.com/",
  realtime_url: "https://acme.app.example.com/api/realtime",
  app_key: "pk_dev_000000",
  schema_version: "opaque_schema_id",
  min_client_version: "0.1.0",
  features: ["orders"],
  collections: ["orders"],
};
const featureFlags = { features: { orders: { enabled: true, options: { mode: "read" } } } };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function apiFetch(calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/v1/config")) return json(config);
    if (url.includes("auth-with-password")) {
      const token = `e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`;
      return json({ token, record: { id: "user_1", collectionName: "users" } });
    }
    return json({ items: [] });
  }) as typeof fetch;
}

function adapters(fetchImpl = apiFetch(), storage = createMemoryStorage()) {
  return { fetch: fetchImpl, storage };
}

describe("ProductClient bootstrap", () => {
  it("uses the injected fetch for config and PocketBase requests, binds filters and waits for logout storage", async () => {
    const calls: string[] = [];
    const values = new Map<string, string>();
    const storage: StorageAdapter = {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => { values.set(key, value); },
      removeItem: async (key) => { values.delete(key); },
    };
    const client = await ProductClient.connect({ backendUrl: "https://acme.app.example.com/", clientVersion: "0.1.0", platform: adapters(apiFetch(calls), storage) });
    expect(client.hasFeature("orders")).toBe(true);
    expect(client.filter("owner = {:owner}", { owner: `u1") || true || ("` })).toContain(JSON.stringify(`u1") || true || ("`));

    await client.login("a@example.com", "secret");
    expect(client.isAuthenticated).toBe(true);
    expect(calls.some((url) => url.endsWith("/v1/config"))).toBe(true);
    expect(calls.some((url) => url.includes("/api/collections/users/auth-with-password"))).toBe(true);
    expect([...values.values()].some((value) => value.includes("e30."))).toBe(true);
    await client.logout();
    expect(client.isAuthenticated).toBe(false);
    expect(values.size).toBe(0);
  });

  it("waits for asynchronous auth restoration before returning", async () => {
    let release!: (value: string | null) => void;
    let completed = false;
    const storage: StorageAdapter = {
      getItem: () => new Promise((resolve) => { release = resolve; }),
      setItem: async () => {},
      removeItem: async () => {},
    };
    const pending = ProductClient.fromConfig(config, { clientVersion: "0.1.0", platform: { storage, fetch: apiFetch() } }).then((client) => { completed = true; return client; });
    await Promise.resolve();
    expect(completed).toBe(false);
    release(null);
    await pending;
    expect(completed).toBe(true);
  });

  it("surfaces failed or malformed auth restoration", async () => {
    const failed: StorageAdapter = {
      getItem: async () => { throw new Error("keychain unavailable"); },
      setItem: async () => {}, removeItem: async () => {},
    };
    const corrupt: StorageAdapter = {
      getItem: async () => "not-json",
      setItem: async () => {}, removeItem: async () => {},
    };
    await expect(ProductClient.fromConfig(config, { clientVersion: "0.1.0", platform: { storage: failed } })).rejects.toBeInstanceOf(AuthPersistenceError);
    await expect(ProductClient.fromConfig(config, { clientVersion: "0.1.0", platform: { storage: corrupt } })).rejects.toBeInstanceOf(AuthPersistenceError);
  });

  it("isolates auth by normalized backend URL and tenant", async () => {
    const saved: string[] = [];
    const storage: StorageAdapter = {
      getItem: async () => null,
      setItem: async (key) => { saved.push(key); },
      removeItem: async () => {},
    };
    const a = await ProductClient.fromConfig(config, { clientVersion: "0.1.0", platform: { storage } });
    a.authStore.save("a");
    await a.authStore.flush();
    const other = { ...config, tenant_id: "tenant_other", backend_url: "https://other.example.com", realtime_url: "https://other.example.com/api/realtime" };
    const b = await ProductClient.fromConfig(other, { clientVersion: "0.1.0", platform: { storage } });
    b.authStore.save("b");
    await b.authStore.flush();
    expect(saved).toHaveLength(2);
    expect(saved[0]).not.toBe(saved[1]);
  });

  it("surfaces storage persistence errors from login and logout", async () => {
    const storage: StorageAdapter = {
      getItem: async () => null,
      setItem: async () => { throw new Error("disk full"); },
      removeItem: async () => { throw new Error("keychain locked"); },
    };
    const client = await ProductClient.fromConfig(config, { clientVersion: "0.1.0", platform: { storage, fetch: apiFetch() } });
    await expect(client.login("a@example.com", "secret")).rejects.toBeInstanceOf(AuthPersistenceError);
    await expect(client.logout()).rejects.toBeInstanceOf(AuthPersistenceError);
  });

  it("fetches schema-validated features with the PocketBase auth token", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return json(config);
      calls.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
      return json(featureFlags);
    }) as typeof fetch;
    const client = await ProductClient.fromConfig(config, { clientVersion: "0.1.0", platform: { storage: createMemoryStorage(), fetch: fetchImpl } });
    client.authStore.save("pb-user-token");
    await client.authStore.flush();

    await expect(client.getFeatures()).resolves.toEqual(featureFlags);
    expect(calls).toEqual([{ url: expect.stringContaining("/v1/features"), authorization: "pb-user-token" }]);
  });

  it("rejects invalid features and HTTP errors", async () => {
    let response: Response = json({ features: { orders: {} } });
    const fetchImpl = (async (input: RequestInfo | URL) => String(input).endsWith("/v1/config") ? json(config) : response) as typeof fetch;
    const client = await ProductClient.fromConfig(config, { clientVersion: "0.1.0", platform: { storage: createMemoryStorage(), fetch: fetchImpl } });
    client.authStore.save("pb-user-token");
    await client.authStore.flush();

    await expect(client.getFeatures()).rejects.toThrow();
    response = json({ message: "unauthorized" }, 401);
    await expect(client.getFeatures()).rejects.toThrow();
  });

  it("persists a changed refreshed token and restores it in a new client", async () => {
    const initialToken = "e30.eyJleHAiOjQ3MDAwMDAwMDB9.sig";
    const refreshedToken = "e30.eyJleHAiOjQ3MDAwMDAwMDEwfQ.sig";
    const values = new Map<string, string>();
    const refreshFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return json(config);
      if (url.includes("auth-refresh")) return json({ token: refreshedToken, record: { id: "user_1", collectionName: "users" } });
      return json({});
    }) as typeof fetch;
    const storage: StorageAdapter = {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => { values.set(key, value); },
      removeItem: async (key) => { values.delete(key); },
    };
    const client = await ProductClient.fromConfig(config, { clientVersion: "0.1.0", platform: { storage, fetch: refreshFetch } });
    client.authStore.save(initialToken, { id: "user_1", collectionName: "users" } as never);
    await client.authStore.flush();
    expect(await client.refreshSession()).toBe(true);
    expect([...values.values()].some((value) => value.includes(refreshedToken))).toBe(true);
    expect([...values.values()].some((value) => value.includes(initialToken))).toBe(false);

    const restored = await ProductClient.fromConfig(config, { clientVersion: "0.1.0", platform: { storage, fetch: refreshFetch } });
    expect(restored.authStore.token).toBe(refreshedToken);
  });

  it("clears expired and rejected sessions, retains offline sessions, and surfaces storage failures", async () => {
    const validToken = "e30.eyJleHAiOjQ3MDAwMDAwMDB9.sig";
    const expiredToken = "e30.eyJleHAiOjF9.sig";
    const values = new Map<string, string>();
    const storage: StorageAdapter = {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => { values.set(key, value); },
      removeItem: async (key) => { values.delete(key); },
    };
    const noRefresh = (status: number) => (async (input: RequestInfo | URL) =>
      String(input).endsWith("/v1/config") ? json(config) : json({ message: "rejected" }, status)) as typeof fetch;

    const expired = await ProductClient.fromConfig(config, { clientVersion: "0.1.0", platform: { storage, fetch: noRefresh(401) } });
    expired.authStore.save(expiredToken, { id: "user_1", collectionName: "users" } as never);
    await expired.authStore.flush();
    expect(await expired.refreshSession()).toBe(false);
    expect(values.size).toBe(0);

    const rejected = await ProductClient.fromConfig(config, { clientVersion: "0.1.0", platform: { storage, fetch: noRefresh(401) } });
    rejected.authStore.save(validToken, { id: "user_1", collectionName: "users" } as never);
    await rejected.authStore.flush();
    expect(await rejected.refreshSession()).toBe(false);
    expect(values.size).toBe(0);

    const offlineFetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/v1/config")) return json(config);
      throw new Error("offline");
    }) as typeof fetch;
    const offline = await ProductClient.fromConfig(config, { clientVersion: "0.1.0", platform: { storage, fetch: offlineFetch } });
    offline.authStore.save(validToken, { id: "user_1", collectionName: "users" } as never);
    await offline.authStore.flush();
    expect(await offline.refreshSession()).toBe(true);
    expect(offline.authStore.token).toBe(validToken);

    let rejectRefreshWrite = false;
    const failingStorage: StorageAdapter = {
      getItem: async () => null,
      setItem: async (_key, value) => {
        if (rejectRefreshWrite && value.includes("refreshed")) throw new Error("disk unavailable");
        if (rejectRefreshWrite) throw new Error("disk unavailable");
      },
      removeItem: async () => {},
    };
    const successfulRefresh = (async (input: RequestInfo | URL) =>
      String(input).endsWith("/v1/config") ? json(config) : json({ token: `${validToken}.new`, record: { id: "user_1", collectionName: "users" } })) as typeof fetch;
    const failing = await ProductClient.fromConfig(config, { clientVersion: "0.1.0", platform: { storage: failingStorage, fetch: successfulRefresh } });
    failing.authStore.save(validToken, { id: "user_1", collectionName: "users" } as never);
    await failing.authStore.flush();
    rejectRefreshWrite = true;
    await expect(failing.refreshSession()).rejects.toBeInstanceOf(AuthPersistenceError);

    const failingRemoval: StorageAdapter = {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => { throw new Error("keychain locked"); },
    };
    const removalClient = await ProductClient.fromConfig(config, { clientVersion: "0.1.0", platform: { storage: failingRemoval, fetch: noRefresh(401) } });
    removalClient.authStore.save(validToken, { id: "user_1", collectionName: "users" } as never);
    await removalClient.authStore.flush();
    await expect(removalClient.refreshSession()).rejects.toBeInstanceOf(AuthPersistenceError);
  });

  it("rejects old clients and mismatched realtime endpoints", async () => {
    await expect(ProductClient.fromConfig(config, { clientVersion: "0.0.9", platform: adapters() })).rejects.toBeInstanceOf(ClientTooOldError);
    await expect(ProductClient.fromConfig({ ...config, realtime_url: "https://other.example.com/api/realtime" }, { clientVersion: "0.1.0", platform: adapters() })).rejects.toBeInstanceOf(RealtimeURLMismatchError);
  });

  it("awaits the app's realtime polyfill initialization", async () => {
    let initialized = false;
    await ProductClient.fromConfig(config, { clientVersion: "0.1.0", platform: { storage: createMemoryStorage(), initializeRealtime: async () => { await Promise.resolve(); initialized = true; } } });
    expect(initialized).toBe(true);
  });

  it("uses the same client contract through web, desktop and mobile storage adapters", async () => {
    const values = new Map<string, string>();
    const native = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => { values.set(key, value); },
      removeItem: async (key: string) => { values.delete(key); },
    };
    const originalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } });
    try {
      for (const storage of [createWebStorage(), createDesktopStorage(native), createMobileStorage(native)]) {
        const client = await ProductClient.fromConfig(config, { clientVersion: "0.1.0", platform: { storage } });
        expect(client.hasFeature("orders")).toBe(true);
        expect(client.collection("orders")).toBe(client.collection("orders"));
        expect(client.filter("owner = {:owner}", { owner: "u1" })).toContain('"u1"');
        client.authStore.save("token");
        await client.authStore.flush();
        expect(values.size).toBeGreaterThan(0);
        await client.logout();
      }
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalStorage });
      values.clear();
    }
  });

  it("preserves ordered async auth writes before logout removal", async () => {
    const operations: string[] = [];
    let releaseWrite!: () => void;
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => { writeStarted = resolve; });
    const storage: StorageAdapter = {
      getItem: async () => null,
      setItem: async () => { operations.push("write:start"); writeStarted(); await new Promise<void>((resolve) => { releaseWrite = resolve; }); operations.push("write:end"); },
      removeItem: async () => { operations.push("remove"); },
    };
    const client = await ProductClient.fromConfig(config, { clientVersion: "0.1.0", platform: { storage } });
    client.authStore.save("token");
    await started;
    const logout = client.logout();
    expect(operations).toEqual(["write:start"]);
    releaseWrite();
    await logout;
    expect(operations).toEqual(["write:start", "write:end", "remove"]);
  });

  it("subscribes and unsubscribes realtime through the global EventSource polyfill", async () => {
    const original = globalThis.EventSource;
    class FakeEventSource {
      static latest: FakeEventSource;
      closed = false;
      readonly url: string;
      constructor(url: string | URL) { this.url = String(url); FakeEventSource.latest = this; }
      addEventListener(type: string, callback: EventListener): void {
        if (type === "PB_CONNECT") queueMicrotask(() => callback({ lastEventId: "fake", data: "" } as MessageEvent));
      }
      removeEventListener(): void {}
      close(): void { this.closed = true; }
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
    }
    Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });
    try {
      const client = await ProductClient.fromConfig(config, { clientVersion: "0.1.0", platform: { storage: createMemoryStorage(), fetch: apiFetch() } });
      const unsubscribe = await client.collection("orders").subscribe("*", () => {});
      expect(FakeEventSource.latest.url).toContain("/api/realtime");
      await unsubscribe();
      expect(FakeEventSource.latest.closed).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "EventSource", { configurable: true, value: original });
    }
  });

  it("reconnectRealtime resets reconnect backoff and reconnects active subscriptions, and logout disconnects", async () => {
    const original = globalThis.EventSource;
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      closed = false;
      readonly url: string;
      constructor(url: string | URL) {
        this.url = String(url);
        FakeEventSource.instances.push(this);
      }
      addEventListener(type: string, callback: EventListener): void {
        if (type === "PB_CONNECT") queueMicrotask(() => callback({ lastEventId: "client-abc", data: "" } as MessageEvent));
      }
      removeEventListener(): void {}
      close(): void { this.closed = true; }
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
    }
    Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });
    try {
      FakeEventSource.instances = [];
      const client = await ProductClient.fromConfig(config, { clientVersion: "0.1.0", platform: { storage: createMemoryStorage(), fetch: apiFetch() } });
      await client.collection("orders").subscribe("*", () => {});
      expect(FakeEventSource.instances.length).toBe(1);

      // Simulate a background disconnect with backoff attempts
      const rt = (client.pb as any).realtime;
      rt.reconnectAttempts = 5;
      let timerCleared = false;
      rt.reconnectTimeoutId = setTimeout(() => {}, 10000);
      const originalClear = globalThis.clearTimeout;
      (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => {
        if (id === rt.reconnectTimeoutId) timerCleared = true;
        originalClear(id);
      }) as typeof clearTimeout;

      try {
        await client.reconnectRealtime();
        expect(rt.reconnectAttempts).toBe(0);
        expect(timerCleared).toBe(true);

        // Verify logout clears subscriptions and disconnects
        await client.logout();
        expect(rt.clientId).toBe("");
      } finally {
        (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = originalClear;
      }
    } finally {
      Object.defineProperty(globalThis, "EventSource", { configurable: true, value: original });
    }
  });

  it("preserves automatic retries and active subscriptions on offline realtime reconnect failure", async () => {
    const original = globalThis.EventSource;
    class OfflineEventSource {
      static instances: OfflineEventSource[] = [];
      closed = false;
      readonly url: string;
      constructor(url: string | URL) {
        this.url = String(url);
        OfflineEventSource.instances.push(this);
        // Simulate immediate connection failure when attempting to connect while offline
        queueMicrotask(() => {
          if (this.onerror) {
            this.onerror(new Event("error"));
          }
        });
      }
      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void { this.closed = true; }
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
    }

    class OnlineEventSource {
      static instances: OnlineEventSource[] = [];
      closed = false;
      readonly url: string;
      constructor(url: string | URL) {
        this.url = String(url);
        OnlineEventSource.instances.push(this);
      }
      addEventListener(type: string, callback: EventListener): void {
        if (type === "PB_CONNECT") {
          queueMicrotask(() => callback({ lastEventId: "client-xyz", data: "" } as MessageEvent));
        }
      }
      removeEventListener(): void {}
      close(): void { this.closed = true; }
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
    }

    try {
      // Start online and subscribe to a collection
      Object.defineProperty(globalThis, "EventSource", { configurable: true, value: OnlineEventSource });
      const client = await ProductClient.fromConfig(config, {
        clientVersion: "0.1.0",
        platform: { storage: createMemoryStorage(), fetch: apiFetch() },
      });
      await client.collection("orders").subscribe("*", () => {});
      const rt = (client.pb as any).realtime;
      expect(Object.keys(rt.subscriptions).length).toBeGreaterThan(0);

      // Now switch to offline
      Object.defineProperty(globalThis, "EventSource", { configurable: true, value: OfflineEventSource });
      // Simulate connection lost while in background: clientId cleared, disconnect called with keepSubscriptions
      rt.disconnect(true);
      expect(rt.clientId).toBeFalsy();
      expect(Object.keys(rt.subscriptions).length).toBeGreaterThan(0);

      // Set initial backoff state
      rt.reconnectAttempts = 2;

      // Simulate resume triggering reconnectRealtime() while offline
      await client.reconnectRealtime();

      // Subscriptions must still be retained
      expect(Object.keys(rt.subscriptions).length).toBeGreaterThan(0);
      // Reconnect attempts must not be reset to 0 (which would kill retries in PocketBase)
      expect(rt.reconnectAttempts).toBeGreaterThanOrEqual(1);
      // A retry timer must be active
      expect(rt.reconnectTimeoutId).toBeDefined();

      // Clean up timer
      if (rt.reconnectTimeoutId) {
        clearTimeout(rt.reconnectTimeoutId);
      }
    } finally {
      Object.defineProperty(globalThis, "EventSource", { configurable: true, value: original });
    }
  });

  it("handles transition from offline reconnect backoff to online recovery", async () => {
    const original = globalThis.EventSource;
    let isOnline = false;

    class DynamicEventSource {
      closed = false;
      readonly url: string;
      constructor(url: string | URL) {
        this.url = String(url);
        queueMicrotask(() => {
          if (!isOnline) {
            if (this.onerror) this.onerror(new Event("error"));
          }
        });
      }
      addEventListener(type: string, callback: EventListener): void {
        if (type === "PB_CONNECT" && isOnline) {
          queueMicrotask(() => callback({ lastEventId: "client-recovered", data: "" } as MessageEvent));
        }
      }
      removeEventListener(): void {}
      close(): void { this.closed = true; }
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
    }

    try {
      Object.defineProperty(globalThis, "EventSource", { configurable: true, value: DynamicEventSource });
      const client = await ProductClient.fromConfig(config, {
        clientVersion: "0.1.0",
        platform: { storage: createMemoryStorage(), fetch: apiFetch() },
      });

      // Start with initial connection online
      isOnline = true;
      await client.collection("orders").subscribe("*", () => {});
      const rt = (client.pb as any).realtime;
      expect(rt.clientId).toBe("client-recovered");

      // Go offline
      isOnline = false;
      rt.disconnect(true);
      expect(rt.clientId).toBeFalsy();

      // Offline reconnect with 0 prior attempts schedules backoff retry
      await client.reconnectRealtime();
      expect(rt.reconnectAttempts).toBe(1);
      expect(rt.reconnectTimeoutId).toBeDefined();

      // Now network returns online WITHOUT another resume event
      isOnline = true;

      // Automatic retry backoff timer must fire and reconnect successfully
      await vi.waitFor(() => {
        expect(rt.clientId).toBe("client-recovered");
        expect(rt.reconnectAttempts).toBe(0);
      }, { timeout: 2000, interval: 25 });
    } finally {
      Object.defineProperty(globalThis, "EventSource", { configurable: true, value: original });
    }
  });

  it("retries across multiple offline intervals and recovers when online without new resume events", async () => {
    const original = globalThis.EventSource;
    let isOnline = false;

    class MultiAttemptEventSource {
      closed = false;
      readonly url: string;
      constructor(url: string | URL) {
        this.url = String(url);
        queueMicrotask(() => {
          if (!isOnline) {
            if (this.onerror) this.onerror(new Event("error"));
          }
        });
      }
      addEventListener(type: string, callback: EventListener): void {
        if (type === "PB_CONNECT" && isOnline) {
          queueMicrotask(() => callback({ lastEventId: "client-recovered-multi", data: "" } as MessageEvent));
        }
      }
      removeEventListener(): void {}
      close(): void { this.closed = true; }
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
    }

    try {
      Object.defineProperty(globalThis, "EventSource", { configurable: true, value: MultiAttemptEventSource });
      const client = await ProductClient.fromConfig(config, {
        clientVersion: "0.1.0",
        platform: { storage: createMemoryStorage(), fetch: apiFetch() },
      });

      isOnline = true;
      await client.collection("orders").subscribe("*", () => {});
      const rt = (client.pb as any).realtime;
      expect(rt.clientId).toBe("client-recovered-multi");

      // Go offline
      isOnline = false;
      rt.disconnect(true);

      // Trigger resume while offline
      await client.reconnectRealtime();
      expect(rt.reconnectAttempts).toBe(1);
      expect(rt.reconnectTimeoutId).toBeDefined();

      // Wait until PocketBase's internal retry executes and increments to attempt 2 while still offline
      await vi.waitFor(() => {
        expect(rt.reconnectAttempts).toBeGreaterThanOrEqual(2);
      }, { timeout: 1500, interval: 25 });

      // Now restore connectivity
      isOnline = true;

      // Ensure automatic recovery completes without any further resume event
      await vi.waitFor(() => {
        expect(rt.clientId).toBe("client-recovered-multi");
        expect(rt.reconnectAttempts).toBe(0);
      }, { timeout: 2000, interval: 25 });
    } finally {
      Object.defineProperty(globalThis, "EventSource", { configurable: true, value: original });
    }
  });
});

describe("config transport and host adapters", () => {
  it("reports config HTTP and JSON errors", async () => {
    await expect(fetchAppConfig("https://acme.example.com", (async () => json({}, 503)) as typeof fetch)).rejects.toMatchObject({ name: "ConfigFetchError", status: 503 });
    await expect(fetchAppConfig("https://acme.example.com", (async () => new Response("no json", { status: 200 })) as typeof fetch)).rejects.toBeInstanceOf(ConfigFetchError);
    await expect(fetchAppConfig("https://acme.example.com", (async () => { throw new Error("offline"); }) as typeof fetch)).rejects.toBeInstanceOf(ConfigFetchError);
  });

  it("propagates synchronous or asynchronous host storage operations", async () => {
    const data = new Map<string, string>();
    const api = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
    for (const adapter of [createDesktopStorage(api), createMobileStorage(api)]) {
      await adapter.setItem("token", "secret");
      expect(await adapter.getItem("token")).toBe("secret");
      await adapter.removeItem("token");
      expect(await adapter.getItem("token")).toBeNull();
    }
  });
});

describe("schema management", () => {
  it("fetches, gets, creates, and deletes schemas", async () => {
    const mockSchema: SchemaDefinition = {
      schema_id: "inventory",
      name: "Inventory",
      description: "Warehouse stock items",
      icon: "📦",
      fields: [
        { name: "item_code", label: "Item Code", type: "text", required: true },
        { name: "quantity", label: "Quantity", type: "number", required: true },
        { name: "status", label: "Status", type: "select", options: ["in_stock", "low", "out_of_stock"] },
      ],
    };

    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const customFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/v1/config")) return json(config);
      if (url.includes("auth-with-password")) {
        const token = `e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`;
        return json({ token, record: { id: "user_1", collectionName: "users" } });
      }
      if (url.endsWith("/v1/schemas") && (!init?.method || init.method === "GET")) {
        return json([mockSchema]);
      }
      if (url.endsWith("/v1/schemas/inventory") && (!init?.method || init.method === "GET")) {
        return json(mockSchema);
      }
      if (url.endsWith("/v1/schemas") && init?.method === "POST") {
        return json({ ...mockSchema, created: "2026-10-20T12:00:00Z" });
      }
      if (url.endsWith("/v1/schemas/inventory") && init?.method === "PATCH") {
        return json({ ...mockSchema, name: "Updated Inventory", updated: "2026-10-20T13:00:00Z" });
      }
      if (url.endsWith("/v1/schemas/inventory") && init?.method === "DELETE") {
        return json({ status: "deleted" });
      }
      return json({});
    }) as typeof fetch;

    const client = await ProductClient.connect({
      backendUrl: "https://acme.app.example.com/",
      clientVersion: "0.1.0",
      platform: { storage: createMemoryStorage(), fetch: customFetch },
    });
    await client.login("admin@example.com", "secret");

    // List schemas
    const schemas = await client.getSchemas();
    expect(schemas).toHaveLength(1);
    expect(schemas[0]?.schema_id).toBe("inventory");
    expect(schemas[0]?.fields).toHaveLength(3);

    // Get single schema
    const single = await client.getSchema("inventory");
    expect(single.name).toBe("Inventory");

    // Create schema
    const created = await client.createSchema(mockSchema);
    expect(created.schema_id).toBe("inventory");
    expect(created.created).toBeDefined();

    // Update schema
    const updated = await client.updateSchema("inventory", {
      ...mockSchema,
      name: "Updated Inventory",
    });
    expect(updated.name).toBe("Updated Inventory");
    expect(calls.some((c) => c.url.endsWith("/v1/schemas/inventory") && c.method === "PATCH")).toBe(true);

    // Delete schema
    await client.deleteSchema("inventory");
    expect(calls.some((c) => c.url.endsWith("/v1/schemas/inventory") && c.method === "DELETE")).toBe(true);
  });

  it("fetches custom pages via getPages() and getPage()", async () => {
    const mockPageRecord = {
      id: "rec_page_1",
      page_id: "orders-board",
      name: "Orders Board",
      view_type: "kanban",
      collection: "orders",
      config: {
        groupByField: "status",
        cardFields: ["title", "total"],
      },
      created: "2026-10-20T10:00:00Z",
      updated: "2026-10-20T10:00:00Z",
    };

    const customFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return json(config);
      if (url.includes("auth-with-password")) {
        const token = `e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`;
        return json({ token, record: { id: "u1", collectionName: "users" } });
      }
      if (url.includes("/api/collections/app_pages/records") && url.includes("getFirstListItem")) {
        return json(mockPageRecord);
      }
      if (url.includes("/api/collections/app_pages/records")) {
        return json({ items: [mockPageRecord], totalItems: 1, totalPages: 1 });
      }
      return json({});
    }) as typeof fetch;

    const client = await ProductClient.connect({
      backendUrl: "https://acme.app.example.com/",
      clientVersion: "0.1.0",
      platform: { storage: createMemoryStorage(), fetch: customFetch },
    });
    await client.login("admin@example.com", "secret");

    const pages = await client.getPages();
    expect(pages).toHaveLength(1);
    expect(pages[0]?.page_id).toBe("orders-board");
    expect(pages[0]?.view_type).toBe("kanban");
    expect(pages[0]?.config?.groupByField).toBe("status");

    const single = await client.getPage("orders-board");
    expect(single?.name).toBe("Orders Board");
    expect(single?.collection).toBe("orders");
  });

  it("manages workspace setup, users, and role permissions", async () => {
    const customFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return json({ ...config, has_owner: false });
      if (url.endsWith("/v1/workspace/setup")) {
        return json({
          id: "owner_1",
          email: "owner@example.com",
          name: "Owner Alice",
          role: "owner",
          disabled: false,
        });
      }
      if (url.endsWith("/v1/workspace/users")) {
        return json([
          {
            id: "owner_1",
            email: "owner@example.com",
            name: "Owner Alice",
            role: "owner",
            disabled: false,
          },
          {
            id: "member_1",
            email: "bob@example.com",
            name: "Member Bob",
            role: "member",
            disabled: false,
            permissions: {
              jobs: { read: true, create: true, update: true, delete: false, scope: "assigned" },
            },
          },
        ]);
      }
      if (url.includes("auth-with-password")) {
        const token = `e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`;
        return json({
          token,
          record: {
            id: "member_1",
            collectionName: "users",
            role: "member",
            permissions: {
              jobs: { read: true, create: true, update: false, delete: false, scope: "assigned" },
            },
          },
        });
      }
      return json({});
    }) as typeof fetch;

    const client = await ProductClient.connect({
      backendUrl: "https://acme.app.example.com/",
      clientVersion: "0.1.0",
      platform: { storage: createMemoryStorage(), fetch: customFetch },
    });

    // 1. Workspace setup call
    const ownerUser = await client.setupWorkspace({
      token: "lattice_setup_secret123",
      email: "owner@example.com",
      name: "Owner Alice",
      password: "Password123456!",
    });
    expect(ownerUser.id).toBe("owner_1");
    expect(ownerUser.role).toBe("owner");

    // 2. Login as member and test role / permission getters
    await client.login("bob@example.com", "Password123456!");
    expect(client.currentUserRole).toBe("member");
    expect(client.isOwner).toBe(false);
    expect(client.isAdmin).toBe(false);
    expect(client.isOwnerOrAdmin).toBe(false);

    // 3. Permission checks
    expect(client.hasDatasetPermission("jobs", "read")).toBe(true);
    expect(client.hasDatasetPermission("jobs", "create")).toBe(true);
    expect(client.hasDatasetPermission("jobs", "update")).toBe(false);
    expect(client.hasDatasetPermission("jobs", "delete")).toBe(false);
    expect(client.hasDatasetPermission("customers", "read")).toBe(false); // deny by default

    // 4. List workspace users
    const users = await client.getWorkspaceUsers();
    expect(users).toHaveLength(2);
    expect(users[0]?.role).toBe("owner");
    expect(users[1]?.role).toBe("member");
  });

  it("manages workspace modules and enforces owner/admin permission for configuration", async () => {
    let authRole = "owner";
    const customFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return json(config);
      if (url.includes("/v1/schemas")) {
        return json([
          {
            schema_id: "customers",
            name: "Customer Accounts",
            description: "Directory of client accounts",
            icon: "👥",
            fields: [{ name: "name", type: "text" }],
          },
          {
            schema_id: "jobs",
            name: "Work Orders",
            icon: "📋",
            fields: [{ name: "title", type: "text" }],
          },
        ]);
      }
      if (url.includes("/collections/app_pages/records")) {
        return json({
          items: [
            {
              id: "page_rec_1",
              page_id: "customer_list",
              name: "Customer List View",
              view_type: "table",
              collection: "customers",
              config: {},
            },
            {
              id: "page_rec_2",
              page_id: "custom_kpis",
              name: "Standalone KPI Dashboard",
              view_type: "dashboard",
              collection: "analytics",
              config: {},
            },
          ],
        });
      }
      if (url.includes("auth-with-password")) {
        const token = `e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`;
        return json({
          token,
          record: {
            id: authRole === "owner" ? "owner_1" : "member_1",
            collectionName: "users",
            role: authRole,
          },
        });
      }
      return json({});
    }) as typeof fetch;

    const storage = createMemoryStorage();
    const client = await ProductClient.connect({
      backendUrl: "https://acme.app.example.com/",
      clientVersion: "0.1.0",
      platform: { storage, fetch: customFetch },
    });

    // 1. Unauthenticated or member cannot configure modules
    await expect(client.setModuleEnabled("customers", false)).rejects.toThrow(
      "Only workspace owners and admins can configure workspace modules",
    );

    // 2. Sign in as owner
    await client.login("owner@example.com", "Password123!");
    expect(client.isOwner).toBe(true);

    // 3. Discover modules
    const modules = await client.getModules();
    expect(modules.length).toBeGreaterThanOrEqual(4);

    const dashboardMod = modules.find((m) => m.id === "dashboard");
    expect(dashboardMod).toBeDefined();
    expect(dashboardMod?.enabled).toBe(true);

    const featureMod = modules.find((m) => m.feature_flag === "orders");
    expect(featureMod).toBeDefined();
    expect(featureMod?.name).toContain("Orders");

    const customerMod = modules.find((m) => m.id === "customers");
    expect(customerMod).toBeDefined();
    expect(customerMod?.dataset_id).toBe("customers");
    expect(customerMod?.page_ids).toEqual(["customer_list"]);

    const standaloneMod = modules.find((m) => m.id === "page_custom_kpis");
    expect(standaloneMod).toBeDefined();
    expect(standaloneMod?.name).toBe("Standalone KPI Dashboard");

    // 4. Disable customers module
    await client.setModuleEnabled("customers", false);
    expect(await client.isModuleEnabled("customers")).toBe(false);

    // 5. Verify getModules reflects disabled status
    const updatedModules = await client.getModules();
    const updatedCustomerMod = updatedModules.find((m) => m.id === "customers");
    expect(updatedCustomerMod?.enabled).toBe(false);

    // 6. Re-enable customers module
    await client.setModuleEnabled("customers", true);
    expect(await client.isModuleEnabled("customers")).toBe(true);

    // 7. Sign in as member and verify blocked
    authRole = "member";
    await client.login("member@example.com", "Password123!");
    expect(client.currentUserRole).toBe("member");
    await expect(client.setModuleEnabled("customers", false)).rejects.toThrow(
      "Only workspace owners and admins can configure workspace modules",
    );
  });
});
