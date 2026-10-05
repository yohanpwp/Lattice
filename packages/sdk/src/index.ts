export { ProductClient, RealtimeURLMismatchError, type ClientOptions, type ConnectOptions } from "./client";
export { fetchAppConfig } from "./config";
export { AuthPersistenceError, createAuthStore, type PersistentAuthStore } from "./authStore";
export { ClientTooOldError, ConfigFetchError } from "./errors";
export { createMemoryStorage, type HostStorageApi, type PlatformAdapters, type StorageAdapter } from "./platform";
export { createWebStorage } from "./platforms/web";
export { createDesktopStorage, type DesktopStorageApi } from "./platforms/desktop";
export { createMobileStorage, type MobileStorageApi } from "./platforms/mobile";
export { compareVersions, isClientCompatible } from "./version";
