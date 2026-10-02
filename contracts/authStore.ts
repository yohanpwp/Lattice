import { AsyncAuthStore } from "pocketbase";
import type { StorageAdapter } from "./platform";

/** Builds a PocketBase auth store that persists through our StorageAdapter. */
export function createAuthStore(storage: StorageAdapter, key: string): AsyncAuthStore {
  return new AsyncAuthStore({
    save: (serialized) => storage.setItem(key, serialized),
    clear: () => storage.removeItem(key),
    initial: storage.getItem(key).then(
      (value) => value ?? "",
      () => "",
    ),
  });
}
