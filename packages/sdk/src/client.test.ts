import { describe, expect, it } from "vitest";
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
