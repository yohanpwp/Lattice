import { ProductClient, createMobileStorage, type MobileStorageApi } from "@lattice/sdk";

export function connectMobile(backendUrl: string, clientVersion: string, secureStorage: MobileStorageApi, installEventSource: () => Promise<void>): Promise<ProductClient> {
  return ProductClient.connect({
    backendUrl,
    clientVersion,
    platform: { storage: createMobileStorage(secureStorage), initializeRealtime: installEventSource },
  });
}
