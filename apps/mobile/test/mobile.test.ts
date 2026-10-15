import { describe, expect, it, vi, beforeEach } from "vitest";
import { SecureStorage, StorageError, StorageErrorType, KeychainAccess } from "@aparajita/capacitor-secure-storage";
import { createMobileStorage, createAuthStore, AuthPersistenceError } from "@lattice/sdk";
import { createSecureStorageApi } from "../src/storage";

vi.mock("@aparajita/capacitor-secure-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aparajita/capacitor-secure-storage")>();
  return {
    ...actual,
    SecureStorage: {
      setDefaultKeychainAccess: vi.fn(),
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
  };
});

describe("Mobile Secure Storage Adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(SecureStorage.setDefaultKeychainAccess).mockResolvedValue();
    vi.mocked(SecureStorage.getItem).mockResolvedValue(null);
    vi.mocked(SecureStorage.setItem).mockResolvedValue();
    vi.mocked(SecureStorage.removeItem).mockResolvedValue();
  });

  it("configures Keychain access on first operation", async () => {
    vi.mocked(SecureStorage.getItem).mockResolvedValue("test-value");

    const api = createSecureStorageApi();
    const val = await api.getItem("token");

    expect(val).toBe("test-value");
    expect(SecureStorage.setDefaultKeychainAccess).toHaveBeenCalledWith(
      KeychainAccess.afterFirstUnlockThisDeviceOnly
    );
  });

  it("returns null when key does not exist without throwing", async () => {
    vi.mocked(SecureStorage.getItem).mockRejectedValue(
      new StorageError("Key not found", StorageErrorType.missingKey)
    );

    const api = createSecureStorageApi();
    const val = await api.getItem("non-existent-key");
    expect(val).toBeNull();
  });

  it("stores and removes items successfully", async () => {
    const api = createSecureStorageApi();
    await api.setItem("key1", "val1");
    expect(SecureStorage.setItem).toHaveBeenCalledWith("key1", "val1");

    await api.removeItem("key1");
    expect(SecureStorage.removeItem).toHaveBeenCalledWith("key1");
  });

  it("ignores missingKey errors on removeItem", async () => {
    vi.mocked(SecureStorage.removeItem).mockRejectedValue(
      new StorageError("Key not found", StorageErrorType.missingKey)
    );

    const api = createSecureStorageApi();
    await expect(api.removeItem("already-missing")).resolves.toBeUndefined();
  });

  it("propagates system/hardware/OS errors instead of returning null", async () => {
    vi.mocked(SecureStorage.getItem).mockRejectedValue(
      new StorageError("Hardware KeyStore locked", StorageErrorType.osError)
    );

    const api = createSecureStorageApi();
    await expect(api.getItem("locked-key")).rejects.toThrow("Hardware KeyStore locked");
  });

  it("integrates with SDK auth store and surfaces AuthPersistenceError on hardware errors", async () => {
    vi.mocked(SecureStorage.getItem).mockRejectedValue(
      new StorageError("KeyStore unreadable", StorageErrorType.osError)
    );

    const storage = createMobileStorage(createSecureStorageApi());
    const authStore = createAuthStore(storage, "test-auth-key");

    await expect(authStore.ready).rejects.toThrow(AuthPersistenceError);
  });
});
