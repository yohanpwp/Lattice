import { ProductClient, createDesktopStorage, type DesktopStorageApi } from "@lattice/sdk";

export function connectDesktop(backendUrl: string, clientVersion: string, storageApi: DesktopStorageApi): Promise<ProductClient> {
  return ProductClient.connect({ backendUrl, clientVersion, platform: { storage: createDesktopStorage(storageApi) } });
}
