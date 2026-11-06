import { describe, expect, it, vi } from "vitest";
import { ContractError, type SchemaDefinition } from "@lattice/types";
import {
  AuthPersistenceError,
  ClientTooOldError,
  ConfigFetchError,
  IncompatibleModuleError,
  ModuleSetupError,
  ProductClient,
  RealtimeURLMismatchError,
  SUPPORTED_MODULE_MAJOR_VERSION,
  assertModuleEntry,
  createDesktopStorage,
  createMemoryStorage,
  createMobileStorage,
  createWebStorage,
  fetchAppConfig,
  isModuleVersionCompatible,
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
    expect(single?.published).toBe(true);
  });

  it("creates, updates, and deletes pages with publishing and nav_order support", async () => {
    let storedPage: any = null;
    const customFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      if (url.endsWith("/v1/config")) return json(config);
      if (url.includes("auth-with-password")) {
        const token = `e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`;
        return json({ token, record: { id: "u1", role: "admin", collectionName: "users" } });
      }
      if (url.includes("/api/collections/app_pages/records")) {
        if (method === "GET") {
          if (storedPage) {
            return json({ items: [storedPage], totalItems: 1, totalPages: 1 });
          }
          return json({ items: [], totalItems: 0, totalPages: 0 });
        }
        if (method === "POST") {
          const body = JSON.parse(String(init?.body || "{}"));
          storedPage = {
            id: "pb_rec_9999999",
            ...body,
            created: "2026-11-04T12:00:00Z",
            updated: "2026-11-04T12:00:00Z",
          };
          return json(storedPage);
        }
        if (method === "PATCH") {
          const body = JSON.parse(String(init?.body || "{}"));
          storedPage = { ...storedPage, ...body, updated: "2026-11-04T12:30:00Z" };
          return json(storedPage);
        }
        if (method === "DELETE") {
          storedPage = null;
          return new Response(null, { status: 204 });
        }
      }
      return json({});
    }) as typeof fetch;

    const client = await ProductClient.connect({
      backendUrl: "https://acme.app.example.com/",
      clientVersion: "0.1.0",
      platform: { storage: createMemoryStorage(), fetch: customFetch },
    });
    await client.login("admin@example.com", "secret");

    const created = await client.createPage({
      page_id: "projects-table",
      name: "Projects Table",
      view_type: "table",
      collection: "projects",
      published: true,
      nav_order: 1,
    });
    expect(created.page_id).toBe("projects-table");
    expect(created.published).toBe(true);
    expect(created.nav_order).toBe(1);

    // Update using 15-character page_id slug to ensure it resolves page_id without mistaking it for record ID
    const updated = await client.updatePage("projects-table", {
      published: false,
    });
    expect(updated.published).toBe(false);
    expect(updated.id).toBe("pb_rec_9999999");

    // Delete using page_id slug
    await client.deletePage("projects-table");
    expect(storedPage).toBeNull();
  });

  it("loads and saves shared dashboard layouts via getDashboardLayout() and saveDashboardLayout()", async () => {
    let savedLayoutDoc: any = null;
    const customFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || "GET";
      if (url.endsWith("/v1/config")) return json(config);
      if (url.includes("auth-with-password")) {
        const token = `e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`;
        return json({ token, record: { id: "u1", role: "admin", collectionName: "users" } });
      }
      if (url.includes("/api/collections/dashboards/records")) {
        if (method === "GET") {
          if (!savedLayoutDoc) {
            return json({ items: [], totalItems: 0, totalPages: 0 });
          }
          return json({ items: [savedLayoutDoc], totalItems: 1, totalPages: 1 });
        }
        if (method === "POST") {
          const body = JSON.parse(String(init?.body || "{}"));
          if (savedLayoutDoc && savedLayoutDoc.name === body.name) {
            return new Response(JSON.stringify({ message: "Dashboard already exists" }), { status: 409 });
          }
          savedLayoutDoc = {
            id: "dash_main_rec",
            name: body.name,
            layout: body.layout,
            revision: 1,
            created: "2026-11-04T12:00:00Z",
            updated: "2026-11-04T12:00:00Z",
          };
          return json(savedLayoutDoc);
        }
        if (method === "PATCH") {
          const body = JSON.parse(String(init?.body || "{}"));
          if (!body.expected_revision) {
            return new Response(JSON.stringify({ message: "expected_revision is required" }), { status: 400 });
          }
          if (body.expected_revision !== (savedLayoutDoc?.revision ?? 1)) {
            return new Response(JSON.stringify({ message: "conflict" }), { status: 409 });
          }
          savedLayoutDoc = {
            ...savedLayoutDoc,
            name: body.name || savedLayoutDoc.name,
            layout: body.layout,
            revision: (savedLayoutDoc?.revision ?? 1) + 1,
            updated: new Date().toISOString(),
          };
          return json(savedLayoutDoc);
        }
      }
      return json({});
    }) as typeof fetch;

    const client = await ProductClient.connect({
      backendUrl: "https://acme.app.example.com/",
      clientVersion: "0.1.0",
      platform: { storage: createMemoryStorage(), fetch: customFetch },
    });
    await client.login("admin@example.com", "secret");

    const initial = await client.getDashboardLayout("main");
    expect(initial).toBeNull();

    const layoutToSave = {
      id: "main",
      name: "Workspace Overview",
      layout: [
        {
          id: "w1",
          type: "kpi" as const,
          collection: "projects",
          x: 0,
          y: 0,
          w: 4,
          h: 2,
          props: { metric: "count" },
        },
      ],
    };

    const saved = await client.saveDashboardLayout(layoutToSave, "main");
    expect(saved.id).toBe("main");
    expect(saved.layout).toHaveLength(1);
    expect(saved.layout[0]?.type).toBe("kpi");
    expect(saved.revision).toBe(1);

    const loaded = await client.getDashboardLayout("main");
    expect(loaded?.layout).toHaveLength(1);
    expect(loaded?.layout[0]?.collection).toBe("projects");
    expect(loaded?.revision).toBe(1);

    // Save with matching expectedRevision advances to 2
    const updated = await client.saveDashboardLayout(layoutToSave, "main", { expectedRevision: 1 });
    expect(updated.revision).toBe(2);

    // Concurrent save with stale revision (1) fails with 409 Conflict
    await expect(
      client.saveDashboardLayout(layoutToSave, "main", { expectedRevision: 1 })
    ).rejects.toThrow();

    // First-create assertion (expectedRevision: 0) fails when dashboard already exists
    await expect(
      client.saveDashboardLayout(layoutToSave, "main", { expectedRevision: 0 })
    ).rejects.toThrow();
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
      if (url.includes("/v1/workspace/modules/")) {
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
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

  const validCatalogModule = {
    module_id: "customer_job_tracking",
    name: "Customer & Job Tracking",
    version: "1.0.0",
    description: "Track customer contacts and manage assigned jobs with status updates.",
    icon: "clipboard-check",
    supported_platforms: ["web", "mobile"] as ["web", "mobile"],
    required_datasets: [
      {
        dataset_role: "customers",
        name: "Customers",
        required_fields: [
          { field_role: "name", name: "name", type: "text" as const, required: true },
        ],
      },
      {
        dataset_role: "jobs",
        name: "Jobs",
        assignee_field_role: "assignee",
        required_fields: [
          { field_role: "title", name: "title", type: "text" as const, required: true },
        ],
      },
    ],
    screens: ["job_list", "customer_list"],
    actions: ["create_job", "update_job_status"],
    permissions: {
      customers: { read: true, scope: "all" as const },
      jobs: { read: true, create: true, update: true, scope: "assigned" as const },
    },
    disabling: "Disabling hides dedicated module screens and navigation.",
  };

  it("sets up managed workspace modules and subscribes to realtime updates", async () => {
    let installedModule: any = null;
    const customFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return json(config);
      if (url.includes("/v1/workspace/modules/customer_job_tracking/setup") && init?.method === "POST") {
        installedModule = {
          module_id: "customer_job_tracking",
          version: "1.0.0",
          enabled: true,
          mapping: {
            customer_dataset: "customers",
            customer_name_field: "name",
            job_dataset: "jobs",
            job_title_field: "title",
            job_customer_field: "customer",
            job_status_field: "status",
            job_assignee_field: "assignee",
          },
        };
        return json(installedModule);
      }
      if (url.includes("/v1/workspace/modules") && init?.method === "GET") {
        return json(installedModule ? [{ ...validCatalogModule, ...installedModule, installed: true }] : []);
      }
      if (url.includes("auth-with-password")) {
        const token = `e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`;
        return json({
          token,
          record: { id: "owner_1", collectionName: "users", role: "owner" },
        });
      }
      return json({});
    }) as typeof fetch;

    const client = await ProductClient.connect({
      backendUrl: "https://acme.app.example.com/",
      clientVersion: "1.0.0",
      platform: {
        storage: createMemoryStorage(),
        fetch: customFetch,
      },
    });

    await client.login("owner@example.com", "Password123!");

    // Setup module
    const setupRes = await client.setupWorkspaceModule("customer_job_tracking", {
      use_suggested: true,
    });
    expect(setupRes.module_id).toBe("customer_job_tracking");
    expect(setupRes.enabled).toBe(true);

    // List modules
    const modules = await client.getWorkspaceModules();
    expect(modules.length).toBe(1);
    expect(modules[0]?.module_id).toBe("customer_job_tracking");

    // Realtime subscription unsubscribe handles gracefully
    const unsub = client.subscribeWorkspaceModules(() => {});
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("surfaces ModuleSetupError with partial created datasets when setup fails during provisioning", async () => {
    const customFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return json(config);
      if (url.includes("/v1/workspace/modules/customer_job_tracking/setup") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            error: "provision_failed",
            message: "failed to provision jobs dataset: disk full",
            created: ["customers"],
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("auth-with-password")) {
        return json({
          token: `e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`,
          record: { id: "owner_1", collectionName: "users", role: "owner" },
        });
      }
      return json({});
    }) as typeof fetch;

    const client = await ProductClient.connect({
      backendUrl: "https://acme.app.example.com/",
      clientVersion: "1.0.0",
      platform: { storage: createMemoryStorage(), fetch: customFetch },
    });
    await client.login("owner@example.com", "Password123!");

    let caught: any = null;
    try {
      await client.setupWorkspaceModule("customer_job_tracking", { use_suggested: true });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ModuleSetupError);
    expect(caught.code).toBe("provision_failed");
    expect(caught.message).toContain("failed to provision jobs dataset");
    expect(caught.created).toEqual(["customers"]);
  });

  it("synchronizes module enablement across separate web and mobile sessions with retained records", async () => {
    const originalEventSource = globalThis.EventSource;
    class FakeEventSource {
      closed = false;
      readonly url: string;
      constructor(url: string | URL) { this.url = String(url); }
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
      let installed = true;
      let enabled = true;
      const moduleSubscribers = new Set<(event: any) => void>();

      const customerRecords = [
        { id: "cust_1", name: "Acme Industrial", phone: "555-0199" },
      ];
      const jobRecords = [
        { id: "job_1", title: "Boiler Maintenance", customer: "cust_1", status: "Open", assignee: "tech_1" },
      ];

      const customFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/v1/config")) return json(config);
        if (url.includes("/v1/workspace/modules/customer_job_tracking") && init?.method === "PUT") {
          const body = JSON.parse(String(init?.body || "{}"));
          enabled = body.enabled;
          const mod = { ...validCatalogModule, installed, enabled };
          for (const cb of moduleSubscribers) {
            cb({ action: "update", record: mod });
          }
          return json(mod);
        }
        if (url.includes("/v1/workspace/modules/customer_job_tracking") && (!init?.method || init.method === "GET")) {
          return json({ ...validCatalogModule, installed, enabled });
        }
        if (url.includes("/v1/workspace/modules") && (!init?.method || init.method === "GET")) {
          return json([{ ...validCatalogModule, installed, enabled }]);
        }
        if (url.includes("/api/collections/customers/records")) {
          return json({ items: customerRecords, totalItems: customerRecords.length });
        }
        if (url.includes("/api/collections/jobs/records")) {
          return json({ items: jobRecords, totalItems: jobRecords.length });
        }
        if (url.includes("auth-with-password")) {
          const body = JSON.parse(String(init?.body || "{}"));
          const isOwner = body.identity === "owner@example.com";
          const token = `e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`;
          return json({
            token,
            record: {
              id: isOwner ? "owner_1" : "tech_1",
              collectionName: "users",
              role: isOwner ? "owner" : "member",
              permissions: isOwner
                ? {}
                : {
                    customers: { read: true, scope: "all" },
                    jobs: { read: true, create: true, update: true, delete: false, scope: "assigned" },
                  },
            },
          });
        }
        return json({});
      }) as typeof fetch;

      // Web Owner session
      const ownerStorage = createMemoryStorage();
      const ownerClient = await ProductClient.connect({
        backendUrl: "https://acme.app.example.com/",
        clientVersion: "1.0.0",
        platform: { storage: ownerStorage, fetch: customFetch },
      });
      await ownerClient.login("owner@example.com", "Password123!");

      // Mobile Member session
      const mobileStorage = createMemoryStorage();
      const mobileClient = await ProductClient.connect({
        backendUrl: "https://acme.app.example.com/",
        clientVersion: "1.0.0",
        platform: { storage: mobileStorage, fetch: customFetch },
      });
      await mobileClient.login("tech1@example.com", "Password123!");

      // Mobile client subscribes to module updates
      let mobileObservedEvent: any = null;
      (mobileClient.pb as any).collection = (name: string) => ({
        subscribe: async (_topic: string, cb: (e: any) => void) => {
          if (name === "workspace_modules") moduleSubscribers.add(cb);
          return () => moduleSubscribers.delete(cb);
        },
        unsubscribe: async () => {},
        getList: async () => ({ items: name === "customers" ? customerRecords : jobRecords, totalItems: 1 }),
      });

      const unsubMobile = mobileClient.subscribeWorkspaceModules((event) => {
        mobileObservedEvent = event;
      });

      // 1. Initially enabled on both clients
      expect(await ownerClient.isModuleEnabled("customer_job_tracking")).toBe(true);
      expect(await mobileClient.isModuleEnabled("customer_job_tracking")).toBe(true);

      // 2. Owner disables module in Web session
      await ownerClient.setModuleEnabled("customer_job_tracking", false);
      expect(await ownerClient.isModuleEnabled("customer_job_tracking")).toBe(false);

      // 3. Mobile session observes disabled state via realtime event delivery
      expect(mobileObservedEvent).not.toBeNull();
      expect(mobileObservedEvent.action).toBe("update");
      expect(mobileObservedEvent.record.enabled).toBe(false);
      expect(mobileObservedEvent.record.module_id).toBe("customer_job_tracking");
      expect(await mobileClient.isModuleEnabled("customer_job_tracking")).toBe(false);

      // 4. Customer and Job records remain completely intact and queryable while module is disabled
      const custRes = await mobileClient.collection("customers").getList();
      expect(custRes.items).toHaveLength(1);
      expect(custRes.items[0]?.name).toBe("Acme Industrial");

      const jobRes = await mobileClient.collection("jobs").getList();
      expect(jobRes.items).toHaveLength(1);
      expect(jobRes.items[0]?.title).toBe("Boiler Maintenance");

      // 5. Owner re-enables module in Web session
      mobileObservedEvent = null;
      await ownerClient.setModuleEnabled("customer_job_tracking", true);
      expect(await ownerClient.isModuleEnabled("customer_job_tracking")).toBe(true);

      // Assert realtime event delivery on re-enable
      expect(mobileObservedEvent).not.toBeNull();
      expect(mobileObservedEvent.action).toBe("update");
      expect(mobileObservedEvent.record.enabled).toBe(true);
      expect(mobileObservedEvent.record.module_id).toBe("customer_job_tracking");
      expect(await mobileClient.isModuleEnabled("customer_job_tracking")).toBe(true);

      unsubMobile();
    } finally {
      Object.defineProperty(globalThis, "EventSource", { configurable: true, value: originalEventSource });
    }
  });

  it("surfaces server errors on setModuleEnabled and preserves local state", async () => {
    let serverFails = false;
    let installed = true;
    let enabled = true;

    const customFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return json(config);
      if (url.includes("/v1/workspace/modules/customer_job_tracking") && init?.method === "PUT") {
        if (serverFails) {
          return new Response(JSON.stringify({ error: "not_installed", message: "Module not installed" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const body = JSON.parse(String(init?.body || "{}"));
        enabled = body.enabled;
        return json({ ...validCatalogModule, installed, enabled });
      }
      if (url.includes("/v1/workspace/modules/customer_job_tracking") && init?.method === "GET") {
        return json({ ...validCatalogModule, installed, enabled });
      }
      if (url.includes("/v1/workspace/modules") && init?.method === "GET") {
        return json([{ ...validCatalogModule, installed, enabled }]);
      }
      if (url.includes("auth-with-password")) {
        const token = `e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`;
        return json({
          token,
          record: { id: "owner_1", collectionName: "users", role: "owner" },
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
    await client.login("owner@example.com", "Password123!");

    // Initially enabled
    expect(await client.isModuleEnabled("customer_job_tracking")).toBe(true);

    // When server fails, error must be thrown and local state not updated
    serverFails = true;
    await expect(client.setModuleEnabled("customer_job_tracking", false)).rejects.toThrow();

    // Still enabled according to server
    serverFails = false;
    expect(await client.isModuleEnabled("customer_job_tracking")).toBe(true);

    // When server succeeds, state updates
    await client.setModuleEnabled("customer_job_tracking", false);
    expect(await client.isModuleEnabled("customer_job_tracking")).toBe(false);
  });

  it("decides enablement from server installation for fresh clients", async () => {
    const customFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return json(config);
      if (url.includes("/v1/workspace/modules/customer_job_tracking")) {
        return json({ ...validCatalogModule, installed: false, enabled: false });
      }
      if (url.includes("/v1/workspace/modules")) {
        return json([{ ...validCatalogModule, installed: false, enabled: false }]);
      }
      if (url.includes("auth-with-password")) {
        const token = `e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`;
        return json({
          token,
          record: { id: "member_1", collectionName: "users", role: "member" },
        });
      }
      return json({});
    }) as typeof fetch;

    const storage = createMemoryStorage(); // Fresh device with empty storage
    const client = await ProductClient.connect({
      backendUrl: "https://acme.app.example.com/",
      clientVersion: "0.1.0",
      platform: { storage, fetch: customFetch },
    });
    await client.login("member@example.com", "Password123!");

    // Fresh client should see uninstalled module as disabled
    const disabled = await client.getDisabledModules();
    expect(disabled).toContain("customer_job_tracking");
    expect(await client.isModuleEnabled("customer_job_tracking")).toBe(false);
  });
});

describe("managed module contract and version compatibility", () => {
  const validModContract = {
    module_id: "customer_job_tracking",
    name: "Customer & Job Tracking",
    version: "1.0.0",
    description: "Track customer contacts and manage assigned jobs with status updates.",
    icon: "clipboard-check",
    supported_platforms: ["web", "mobile"] as ["web", "mobile"],
    required_datasets: [
      {
        dataset_role: "customers",
        name: "Customers",
        required_fields: [
          { field_role: "name", name: "name", type: "text" as const, required: true },
        ],
      },
      {
        dataset_role: "jobs",
        name: "Jobs",
        assignee_field_role: "assignee",
        required_fields: [
          { field_role: "title", name: "title", type: "text" as const, required: true },
        ],
      },
    ],
    screens: ["job_list", "customer_list"],
    actions: ["create_job", "update_job_status"],
    permissions: {
      customers: { read: true, scope: "all" as const },
      jobs: { read: true, create: true, update: true, scope: "assigned" as const },
    },
    disabling: "Disabling hides dedicated module screens and navigation.",
  };

  it("checks supported module major version policy", () => {
    expect(SUPPORTED_MODULE_MAJOR_VERSION).toBe(1);
    expect(isModuleVersionCompatible("1.0.0")).toBe(true);
    expect(isModuleVersionCompatible("1.2.3")).toBe(true);
    expect(isModuleVersionCompatible("2.0.0")).toBe(false);
    expect(isModuleVersionCompatible("0.9.0")).toBe(false);
    expect(isModuleVersionCompatible("invalid")).toBe(false);
  });

  it("assertModuleEntry accepts valid module contract with installation metadata", () => {
    const entry = {
      ...validModContract,
      installed: true,
      enabled: true,
      mapping: { customer_dataset: "customers" },
      installed_at: "2026-11-03T00:00:00Z",
      updated_at: "2026-11-03T01:00:00Z",
    };
    const validated = assertModuleEntry(entry);
    expect(validated.module_id).toBe("customer_job_tracking");
    expect(validated.version).toBe("1.0.0");
    expect(validated.installed).toBe(true);
    expect(validated.enabled).toBe(true);
    expect(validated.mapping).toEqual({ customer_dataset: "customers" });
  });

  it("assertModuleEntry rejects an incompatible major version with IncompatibleModuleError", () => {
    const entry = {
      ...validModContract,
      version: "2.0.0",
      installed: true,
      enabled: true,
    };
    expect(() => assertModuleEntry(entry)).toThrow(IncompatibleModuleError);
    try {
      assertModuleEntry(entry);
    } catch (err: any) {
      expect(err).toBeInstanceOf(IncompatibleModuleError);
      expect(err.moduleId).toBe("customer_job_tracking");
      expect(err.version).toBe("2.0.0");
    }
  });

  it("assertModuleEntry requires actual booleans for installed and enabled", () => {
    // Malformed string boolean "false" or "true" must be rejected, not coerced
    expect(() =>
      assertModuleEntry({
        ...validModContract,
        installed: "false" as any,
        enabled: true,
      }),
    ).toThrow(ContractError);

    expect(() =>
      assertModuleEntry({
        ...validModContract,
        installed: true,
        enabled: "true" as any,
      }),
    ).toThrow(ContractError);

    expect(() =>
      assertModuleEntry({
        ...validModContract,
        installed: 1 as any,
        enabled: true,
      }),
    ).toThrow(ContractError);

    // Missing installed or enabled must be rejected
    expect(() =>
      assertModuleEntry({
        ...validModContract,
        enabled: true,
      }),
    ).toThrow(ContractError);

    expect(() =>
      assertModuleEntry({
        ...validModContract,
        installed: true,
      }),
    ).toThrow(ContractError);

    expect(() =>
      assertModuleEntry({
        ...validModContract,
      }),
    ).toThrow(ContractError);

    // Actual booleans must be accepted
    const res = assertModuleEntry({
      ...validModContract,
      installed: false,
      enabled: false,
    });
    expect(res.installed).toBe(false);
    expect(res.enabled).toBe(false);
  });

  it("assertModuleEntry rejects malformed contract with ContractError", () => {
    // Non-semver version
    expect(() =>
      assertModuleEntry({ ...validModContract, version: "v1.0", installed: true, enabled: true }),
    ).toThrow(ContractError);
    expect(() =>
      assertModuleEntry({ ...validModContract, version: "1.0-beta", installed: true, enabled: true }),
    ).toThrow(ContractError);

    // Missing required fields
    const { required_datasets: _omit, ...missingReq } = validModContract;
    expect(() => assertModuleEntry({ ...missingReq, installed: true, enabled: true })).toThrow(ContractError);

    const { module_id: _omitId, ...missingId } = validModContract;
    expect(() => assertModuleEntry({ ...missingId, installed: true, enabled: true })).toThrow(ContractError);
  });

  it("getWorkspaceModules handles incompatible entries individually without hiding the catalog", async () => {
    const validOtherMod = {
      ...validModContract,
      module_id: "fleet_dispatch",
      name: "Fleet & Dispatch",
      version: "1.0.0",
    };
    const incompatibleMod = {
      ...validModContract,
      module_id: "future_module",
      name: "Future Module V2",
      version: "2.0.0",
    };
    const malformedMod = {
      module_id: "broken_module",
      version: "invalid",
      installed: "not-a-boolean",
    };

    let modulePayload: any = [
      { ...validModContract, installed: true, enabled: true },
      { ...incompatibleMod, installed: true, enabled: true },
      { ...validOtherMod, installed: false, enabled: false },
      malformedMod,
    ];

    const customFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return json(config);
      if (url.includes("auth-with-password")) {
        const token = `e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`;
        return json({
          token,
          record: { id: "owner_1", collectionName: "users", role: "owner" },
        });
      }
      const singleMatch = url.match(/\/v1\/workspace\/modules\/([^/?#]+)$/);
      if (singleMatch && singleMatch[1]) {
        const id = decodeURIComponent(singleMatch[1]);
        const found = modulePayload.find((m: any) => m.module_id === id);
        if (found) return json(found);
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/v1/workspace/modules")) {
        return json(modulePayload);
      }
      return json({});
    }) as typeof fetch;

    const client = await ProductClient.connect({
      backendUrl: "https://acme.app.example.com/",
      clientVersion: "1.0.0",
      platform: { storage: createMemoryStorage(), fetch: customFetch },
    });

    // 1. One incompatible or malformed module does NOT reject the whole list
    const modules = await client.getWorkspaceModules();
    expect(modules).toHaveLength(4);

    // 2. Compatible modules are preserved and marked compatible: true
    expect(modules[0]?.module_id).toBe("customer_job_tracking");
    expect(modules[0]?.compatible).toBe(true);
    expect(modules[0]?.enabled).toBe(true);

    expect(modules[2]?.module_id).toBe("fleet_dispatch");
    expect(modules[2]?.compatible).toBe(true);
    expect(modules[2]?.enabled).toBe(false);

    // 3. Incompatible module surfaces its status and is disabled
    expect(modules[1]?.module_id).toBe("future_module");
    expect(modules[1]?.compatible).toBe(false);
    expect(modules[1]?.compatibility_error).toContain("2.0.0");
    expect(modules[1]?.enabled).toBe(false);

    // 4. Malformed module surfaces its status and is disabled
    expect(modules[3]?.module_id).toBe("broken_module");
    expect(modules[3]?.compatible).toBe(false);
    expect(modules[3]?.compatibility_error).toBeDefined();
    expect(modules[3]?.enabled).toBe(false);

    // 5. getModules preserves compatible modules while carrying compatibility status
    const allModules = await client.getModules();
    const cjt = allModules.find((m) => m.id === "customer_job_tracking");
    expect(cjt).toBeDefined();
    expect(cjt?.enabled).toBe(true);
    expect(cjt?.compatible).toBe(true);

    const future = allModules.find((m) => m.id === "future_module");
    expect(future).toBeDefined();
    expect(future?.enabled).toBe(false);
    expect(future?.compatible).toBe(false);
    expect(future?.compatibility_error).toContain("2.0.0");
    expect(future?.description).toContain("2.0.0");

    const broken = allModules.find((m) => m.id === "broken_module");
    expect(broken).toBeDefined();
    expect(broken?.enabled).toBe(false);
    expect(broken?.compatible).toBe(false);
    expect(broken?.compatibility_error).toBeDefined();

    // 6. setModuleEnabled rejects enabling incompatible or broken modules
    await client.login("owner@example.com", "Password123!");
    await expect(client.setModuleEnabled("future_module", true)).rejects.toBeInstanceOf(
      IncompatibleModuleError,
    );
    await expect(client.setModuleEnabled("broken_module", true)).rejects.toBeInstanceOf(
      ContractError,
    );
  });

  it("getWorkspaceModule validates contract and enforces version compatibility", async () => {
    let status = 200;
    let singlePayload: any = { ...validModContract, installed: true, enabled: true };

    const customFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return json(config);
      if (url.includes("/v1/workspace/modules/customer_job_tracking")) {
        if (status !== 200) {
          return new Response(JSON.stringify(status === 404 ? { error: "not_found" } : singlePayload), {
            status,
            headers: { "Content-Type": "application/json" },
          });
        }
        return json(singlePayload);
      }
      return json({});
    }) as typeof fetch;

    const client = await ProductClient.connect({
      backendUrl: "https://acme.app.example.com/",
      clientVersion: "1.0.0",
      platform: { storage: createMemoryStorage(), fetch: customFetch },
    });

    // 1. Valid module retrieved
    const mod = await client.getWorkspaceModule("customer_job_tracking");
    expect(mod).not.toBeNull();
    expect(mod?.module_id).toBe("customer_job_tracking");
    expect(mod?.version).toBe("1.0.0");

    // 2. 404 returns null
    status = 404;
    expect(await client.getWorkspaceModule("customer_job_tracking")).toBeNull();

    // 3. Incompatible major version in 200 response throws IncompatibleModuleError
    status = 200;
    singlePayload = { ...validModContract, version: "2.1.0", installed: true, enabled: true };
    await expect(client.getWorkspaceModule("customer_job_tracking")).rejects.toBeInstanceOf(IncompatibleModuleError);

    // 4. Backend HTTP 400 with incompatible_module_contract is mapped to IncompatibleModuleError
    status = 400;
    singlePayload = {
      error: "incompatible_module_contract",
      message: 'incompatible module version: version "2.0.0" is not supported (supported major version: 1)',
    };
    await expect(client.getWorkspaceModule("customer_job_tracking")).rejects.toBeInstanceOf(IncompatibleModuleError);
    try {
      await client.getWorkspaceModule("customer_job_tracking");
    } catch (err: any) {
      expect(err).toBeInstanceOf(IncompatibleModuleError);
      expect(err.moduleId).toBe("customer_job_tracking");
      expect(err.version).toBe("2.0.0");
    }

    // 5. Missing requirements throws ContractError
    status = 200;
    singlePayload = { module_id: "customer_job_tracking", version: "1.0.0", installed: true, enabled: true };
    await expect(client.getWorkspaceModule("customer_job_tracking")).rejects.toBeInstanceOf(ContractError);
  });

  it("setupWorkspaceModule enforces version compatibility and validates installation", async () => {
    let setupResponse: any = {
      module_id: "customer_job_tracking",
      version: "1.0.0",
      enabled: true,
      mapping: {
        customer_dataset: "customers",
        customer_name_field: "name",
        job_dataset: "jobs",
        job_title_field: "title",
        job_customer_field: "customer",
        job_status_field: "status",
        job_assignee_field: "assignee",
      },
    };

    let setupStatus = 200;
    const customFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return json(config);
      if (url.includes("/v1/workspace/modules/customer_job_tracking/setup") && init?.method === "POST") {
        if (setupStatus !== 200) {
          return new Response(JSON.stringify(setupResponse), {
            status: setupStatus,
            headers: { "Content-Type": "application/json" },
          });
        }
        return json(setupResponse);
      }
      return json({});
    }) as typeof fetch;

    const client = await ProductClient.connect({
      backendUrl: "https://acme.app.example.com/",
      clientVersion: "1.0.0",
      platform: { storage: createMemoryStorage(), fetch: customFetch },
    });

    // 1. Compatible setup succeeds
    const res = await client.setupWorkspaceModule("customer_job_tracking", { use_suggested: true });
    expect(res.module_id).toBe("customer_job_tracking");
    expect(res.version).toBe("1.0.0");

    // 2. Incompatible major version in setup response throws IncompatibleModuleError
    setupResponse = { ...setupResponse, version: "2.0.0" };
    await expect(
      client.setupWorkspaceModule("customer_job_tracking", { use_suggested: true }),
    ).rejects.toBeInstanceOf(IncompatibleModuleError);

    // 3. Backend HTTP 400 with incompatible_module_contract is mapped to IncompatibleModuleError
    setupStatus = 400;
    setupResponse = {
      error: "incompatible_module_contract",
      message: 'incompatible module version: version "2.0.0" is not supported (supported major version: 1)',
    };
    await expect(
      client.setupWorkspaceModule("customer_job_tracking", { use_suggested: true }),
    ).rejects.toBeInstanceOf(IncompatibleModuleError);

    // 4. Malformed installation throws ContractError
    setupStatus = 200;
    setupResponse = { module_id: "customer_job_tracking", version: "1.0.0" }; // missing enabled and mapping
    await expect(
      client.setupWorkspaceModule("customer_job_tracking", { use_suggested: true }),
    ).rejects.toBeInstanceOf(ContractError);
  });

  it("isModuleEnabled propagates IncompatibleModuleError and does not fall back to true", async () => {
    let modulePayload: any = { ...validModContract, version: "2.0.0", installed: true, enabled: true };
    let httpStatus = 200;
    let shouldNetworkFail = false;

    const customFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return json(config);
      if (url.includes("auth-with-password")) {
        const token = `e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`;
        return json({
          token,
          record: { id: "member_1", collectionName: "users", role: "member" },
        });
      }
      if (url.includes("/v1/workspace/modules/customer_job_tracking")) {
        if (shouldNetworkFail) {
          throw new Error("Network error");
        }
        if (httpStatus !== 200) {
          return new Response(JSON.stringify(modulePayload), {
            status: httpStatus,
            headers: { "Content-Type": "application/json" },
          });
        }
        return json(modulePayload);
      }
      return json({});
    }) as typeof fetch;

    const storage = createMemoryStorage(); // Fresh client without disabled storage entries
    const client = await ProductClient.connect({
      backendUrl: "https://acme.app.example.com/",
      clientVersion: "1.0.0",
      platform: { storage, fetch: customFetch },
    });
    await client.login("member@example.com", "Password123!");

    // 1. Incompatible version in 200 response must reject with IncompatibleModuleError rather than falling back to true
    await expect(client.isModuleEnabled("customer_job_tracking")).rejects.toBeInstanceOf(
      IncompatibleModuleError,
    );

    // 2. Backend HTTP 400 with incompatible_module_contract must reject with IncompatibleModuleError rather than falling back to true
    httpStatus = 400;
    modulePayload = {
      error: "incompatible_module_contract",
      message: 'incompatible module version: version "2.0.0" is not supported (supported major version: 1)',
    };
    await expect(client.isModuleEnabled("customer_job_tracking")).rejects.toBeInstanceOf(
      IncompatibleModuleError,
    );

    // 3. Malformed installation state (e.g. non-boolean string "false") must reject with ContractError
    httpStatus = 200;
    modulePayload = { ...validModContract, version: "1.0.0", installed: "false", enabled: true };
    await expect(client.isModuleEnabled("customer_job_tracking")).rejects.toBeInstanceOf(ContractError);

    // 4. Network error falls back to local storage (not disabled on fresh client -> true)
    shouldNetworkFail = true;
    expect(await client.isModuleEnabled("customer_job_tracking")).toBe(true);

    // If local storage has it disabled, network error falls back to false
    const key = `lattice:disabled_modules:${encodeURIComponent(config.backend_url)}:${encodeURIComponent(config.tenant_id)}`;
    await storage.setItem(key, JSON.stringify(["customer_job_tracking"]));
    expect(await client.isModuleEnabled("customer_job_tracking")).toBe(false);
  });

  it("requires a successful compatibility check before enabling managed modules and rejects when reads fail even if write would succeed", async () => {
    let getSingleFailed = true;
    let getCatalogFailed = true;
    let putCalled = false;

    const modulePayload = {
      ...validModContract,
      version: "1.0.0",
      installed: true,
      enabled: false,
    };

    const customFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return json(config);
      if (url.includes("auth-with-password")) {
        const token = `e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`;
        return json({
          token,
          record: { id: "owner_1", collectionName: "users", role: "owner" },
        });
      }
      if (url.includes("/v1/workspace/modules/customer_job_tracking") && init?.method === "PUT") {
        putCalled = true;
        const body = JSON.parse(String(init?.body || "{}"));
        modulePayload.enabled = Boolean(body.enabled);
        return json({ ...modulePayload });
      }
      if (url.includes("/v1/workspace/modules/customer_job_tracking") && (!init?.method || init.method === "GET")) {
        if (getSingleFailed) {
          throw new Error("Temporary network failure on single module lookup");
        }
        return json(modulePayload);
      }
      if (url.includes("/v1/workspace/modules") && (!init?.method || init.method === "GET")) {
        if (getCatalogFailed) {
          throw new Error("Temporary network failure on catalog lookup");
        }
        return json([modulePayload]);
      }
      return json({});
    }) as typeof fetch;

    const storage = createMemoryStorage();
    const key = `lattice:disabled_modules:${encodeURIComponent(config.backend_url)}:${encodeURIComponent(config.tenant_id)}`;
    await storage.setItem(key, JSON.stringify(["customer_job_tracking"]));

    const client = await ProductClient.connect({
      backendUrl: "https://acme.app.example.com/",
      clientVersion: "1.0.0",
      platform: { storage, fetch: customFetch },
    });
    await client.login("owner@example.com", "Password123!");

    // 1. When both reads fail, enabling customer_job_tracking must reject, must NOT call PUT, and must NOT update local state
    await expect(client.setModuleEnabled("customer_job_tracking", true)).rejects.toThrow(
      "Temporary network failure on single module lookup",
    );
    expect(putCalled).toBe(false);
    expect(await client.getDisabledModules()).toContain("customer_job_tracking");

    // 2. When single read fails but catalog read succeeds, compatibility is verified and PUT succeeds
    getCatalogFailed = false;
    await client.setModuleEnabled("customer_job_tracking", true);
    expect(putCalled).toBe(true);
    expect(await client.getDisabledModules()).not.toContain("customer_job_tracking");
  });

  it("setModuleEnabled surfaces server errors and avoids local update when workspace_modules write fails for unmanaged module", async () => {
    let writeFails = true;
    const customFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return json(config);
      if (url.includes("auth-with-password")) {
        const token = `e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`;
        return json({
          token,
          record: { id: "owner_1", collectionName: "users", role: "owner" },
        });
      }
      if (url.includes("/v1/workspace/modules")) return json([]);
      if (url.includes("/api/collections/workspace_modules/records")) {
        if (init?.method === "GET" || !init?.method) {
          return new Response(JSON.stringify({ code: 404, message: "Not found." }), { status: 404 });
        }
        if (init?.method === "POST" || init?.method === "PATCH") {
          if (writeFails) {
            return new Response(JSON.stringify({ code: 500, message: "Disk full or database lock failed" }), { status: 500 });
          }
          return json({ id: "wm_1", module_id: "custom_mod", enabled: false });
        }
      }
      return json({});
    }) as unknown as typeof fetch;

    const storage = createMemoryStorage();
    const client = await ProductClient.connect({
      backendUrl: "https://acme.app.example.com/",
      clientVersion: "1.0.0",
      platform: { storage, fetch: customFetch },
    });
    await client.login("owner@example.com", "Password123!");

    // 1. When server write fails, setModuleEnabled MUST reject and NOT update local storage
    await expect(client.setModuleEnabled("custom_mod", false)).rejects.toThrow();
    expect(await client.getDisabledModules()).not.toContain("custom_mod");

    // 2. When server write succeeds, setModuleEnabled succeeds and updates local storage
    writeFails = false;
    await client.setModuleEnabled("custom_mod", false);
    expect(await client.getDisabledModules()).toContain("custom_mod");
  });
});
