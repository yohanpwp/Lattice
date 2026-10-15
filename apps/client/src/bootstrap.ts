import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { App as CapApp } from "@capacitor/app";
import { SecureStorage, StorageError, StorageErrorType, KeychainAccess } from "@aparajita/capacitor-secure-storage";
import {
  createMobileStorage,
  createWebStorage,
  type HostStorageApi,
  type PlatformAdapters,
} from "@lattice/sdk";

export function createClientSecureStorageApi(): HostStorageApi {
  let configurePromise: Promise<void> | null = null;
  async function ensureConfigured() {
    if (!configurePromise) {
      configurePromise = (async () => {
        try {
          await SecureStorage.setDefaultKeychainAccess(KeychainAccess.afterFirstUnlockThisDeviceOnly);
        } catch {
          // Non-iOS platforms ignore keychain accessibility setting
        }
      })();
    }
    await configurePromise;
  }

  return {
    async getItem(key: string): Promise<string | null> {
      await ensureConfigured();
      try {
        const value = await SecureStorage.getItem(key);
        return value ?? null;
      } catch (err) {
        if (
          (err instanceof StorageError && err.code === StorageErrorType.missingKey) ||
          ((err as { code?: string })?.code === StorageErrorType.missingKey)
        ) {
          return null;
        }
        throw err;
      }
    },
    async setItem(key: string, value: string): Promise<void> {
      await ensureConfigured();
      await SecureStorage.setItem(key, value);
    },
    async removeItem(key: string): Promise<void> {
      await ensureConfigured();
      try {
        await SecureStorage.removeItem(key);
      } catch (err) {
        if (
          (err instanceof StorageError && err.code === StorageErrorType.missingKey) ||
          ((err as { code?: string })?.code === StorageErrorType.missingKey)
        ) {
          return;
        }
        throw err;
      }
    },
  };
}

let appStateListenerHandle: PluginListenerHandle | null = null;
let isResuming = false;
const activeRealtimeSubscribers = new Set<() => Promise<void> | void>();

export function registerRealtimeSubscriber(reconnect: () => Promise<void> | void): () => void {
  activeRealtimeSubscribers.add(reconnect);
  return () => {
    activeRealtimeSubscribers.delete(reconnect);
  };
}

export async function handleAppResume(): Promise<void> {
  if (isResuming) return;
  isResuming = true;
  try {
    for (const subscriber of activeRealtimeSubscribers) {
      try {
        await subscriber();
      } catch (err) {
        console.warn("Realtime resume reconnection failed:", err);
      }
    }
  } finally {
    isResuming = false;
  }
}

export async function setupMobileRealtime(): Promise<() => void> {
  if (typeof globalThis.EventSource === "undefined") {
    throw new Error("EventSource is not supported on this platform.");
  }

  if (appStateListenerHandle) {
    await appStateListenerHandle.remove();
    appStateListenerHandle = null;
  }

  appStateListenerHandle = await CapApp.addListener("appStateChange", async (state) => {
    if (state.isActive) {
      await handleAppResume();
    }
  });

  return () => {
    if (appStateListenerHandle) {
      void appStateListenerHandle.remove();
      appStateListenerHandle = null;
    }
  };
}

let activeClientUnsubscribe: (() => void) | null = null;

export function registerProductClient(client: unknown): () => void {
  if (activeClientUnsubscribe) {
    activeClientUnsubscribe();
    activeClientUnsubscribe = null;
  }

  const typedClient = client as {
    reconnectRealtime?: () => Promise<void>;
    pb?: {
      realtime?: {
        subscriptions?: Record<string, unknown>;
        clientId?: string;
        isConnected?: boolean;
        connect: () => Promise<void>;
        reconnectAttempts?: number;
        reconnectTimeoutId?: ReturnType<typeof setTimeout>;
      };
    };
  };

  const reconnect = async () => {
    try {
      if (typeof typedClient?.reconnectRealtime === "function") {
        await typedClient.reconnectRealtime();
        return;
      }
      const rt = typedClient?.pb?.realtime;
      if (rt) {
        if (rt.reconnectTimeoutId) {
          clearTimeout(rt.reconnectTimeoutId);
        }
        rt.reconnectAttempts = 0;
        const subs = rt.subscriptions;
        const hasSubscriptions = subs && Object.keys(subs).length > 0;
        if (hasSubscriptions || rt.clientId || rt.isConnected) {
          await rt.connect();
        }
      }
    } catch (err) {
      console.warn("Realtime client reconnection failed:", err);
    }
  };

  const unregister = registerRealtimeSubscriber(reconnect);
  activeClientUnsubscribe = unregister;

  return () => {
    unregister();
    if (activeClientUnsubscribe === unregister) {
      activeClientUnsubscribe = null;
    }
  };
}

export async function bootstrapPlatform(): Promise<PlatformAdapters> {
  if (Capacitor.isNativePlatform()) {
    const storageApi = createClientSecureStorageApi();
    return {
      storage: createMobileStorage(storageApi),
      initializeRealtime: async () => {
        await setupMobileRealtime();
      },
      onClientInitialized: (client) => {
        return registerProductClient(client);
      },
    };
  }

  return {
    storage: createWebStorage(),
  };
}
