import { ProductClient, createWebStorage } from "@lattice/sdk";

export function connectWeb(backendUrl: string, clientVersion: string): Promise<ProductClient> {
  return ProductClient.connect({ backendUrl, clientVersion, platform: { storage: createWebStorage() } });
}
