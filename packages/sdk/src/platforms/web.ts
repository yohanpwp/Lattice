import type { StorageAdapter } from "../platform";

/**
 * Browser storage backed by localStorage. Failures reject the returned
 * promise so callers can report persistence problems instead of losing auth.
 */
export function createWebStorage(): StorageAdapter {
  return {
    getItem: async (key) => {
      if (!globalThis.localStorage) throw new Error("localStorage is unavailable");
      return globalThis.localStorage.getItem(key);
    },
    setItem: async (key, value) => {
      if (!globalThis.localStorage) throw new Error("localStorage is unavailable");
      globalThis.localStorage.setItem(key, value);
    },
    removeItem: async (key) => {
      if (!globalThis.localStorage) throw new Error("localStorage is unavailable");
      globalThis.localStorage.removeItem(key);
    },
  };
}
