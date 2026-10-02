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
