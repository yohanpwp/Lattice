import type { StorageAdapter } from "../platform";

/**
 * Browser storage backed by localStorage. Every access is guarded because
 * storage can be unavailable (private mode, blocked cookies, SSR).
 */
export function createWebStorage(): StorageAdapter {
  return {
    getItem: async (key) => {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    setItem: async (key, value) => {
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        /* ignore: running without persistence is better than crashing */
      }
    },
    removeItem: async (key) => {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}
