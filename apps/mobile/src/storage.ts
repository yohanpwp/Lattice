import { SecureStorage, StorageError, StorageErrorType, KeychainAccess } from "@aparajita/capacitor-secure-storage";
import type { HostStorageApi } from "@lattice/sdk";

export function createSecureStorageApi(): HostStorageApi {
  let configurePromise: Promise<void> | null = null;
  async function ensureConfigured() {
    if (!configurePromise) {
      configurePromise = (async () => {
        try {
          await SecureStorage.setDefaultKeychainAccess(KeychainAccess.afterFirstUnlockThisDeviceOnly);
        } catch {
          // No-op on non-iOS
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
