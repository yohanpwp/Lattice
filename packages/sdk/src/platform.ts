/**
 * What differs between platforms. Each app (web, desktop, mobile) passes its
 * own implementation; the rest of the SDK is platform-agnostic.
 */
export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface PlatformAdapters {
  /** Where the auth token is persisted (localStorage, OS keychain, SecureStore...). */
  storage: StorageAdapter;
  /** Optional fetch override (tests, custom TLS, etc.). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Installs a platform EventSource polyfill on globalThis before realtime use. */
  initializeRealtime?: () => Promise<void>;
}

/** Host storage methods used by desktop and mobile application shells. */
export interface HostStorageApi {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

function adaptHostStorage(api: HostStorageApi): StorageAdapter {
  return {
    getItem: async (key) => await api.getItem(key),
    setItem: async (key, value) => await api.setItem(key, value),
    removeItem: async (key) => await api.removeItem(key),
  };
}

/** Adapter for desktop host APIs such as Tauri's app-managed storage wrapper. */
export function createDesktopStorage(api: HostStorageApi): StorageAdapter {
  return adaptHostStorage(api);
}

/** Adapter for mobile keychain or secure-storage wrappers owned by the app. */
export function createMobileStorage(api: HostStorageApi): StorageAdapter {
  return adaptHostStorage(api);
}

/** In-memory storage for tests and server-side rendering. Nothing is persisted. */
export function createMemoryStorage(initial: Record<string, string> = {}): StorageAdapter {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
}
