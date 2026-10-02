import PocketBase, { type RecordModel } from "pocketbase";
import { assertAppConfig, type AppConfig } from "@yourproduct/types";
import { createAuthStore } from "./authStore";
import { fetchAppConfig } from "./config";
import { ClientTooOldError } from "./errors";
import type { PlatformAdapters } from "./platform";
import { isClientCompatible } from "./version";

export interface ClientOptions {
  /** Version of this app build, MAJOR.MINOR.PATCH. Checked against min_client_version. */
  clientVersion: string;
  platform: PlatformAdapters;
}

export interface ConnectOptions extends ClientOptions {
  /** Stable tenant hostname, e.g. https://acme.app.example.com */
  backendUrl: string;
}

/**
 * Entry point for every app. Wraps the PocketBase JS SDK (transport, auth
 * store, realtime) and adds our config, versioning and platform adapters.
 */
export class ProductClient {
  readonly config: AppConfig;
  readonly pb: PocketBase;

  private constructor(config: AppConfig, pb: PocketBase) {
    this.config = config;
    this.pb = pb;
  }

  /** Fetches the tenant config from the backend, then builds the client. */
  static async connect(options: ConnectOptions): Promise<ProductClient> {
    const config = await fetchAppConfig(options.backendUrl, options.platform.fetch);
    return ProductClient.fromConfig(config, options);
  }

  /** Builds the client from a config you already have (embedded or cached). */
  static fromConfig(config: unknown, options: ClientOptions): ProductClient {
    const valid = assertAppConfig(config);

    if (!isClientCompatible(options.clientVersion, valid.min_client_version)) {
      throw new ClientTooOldError(options.clientVersion, valid.min_client_version);
    }

    // One auth slot per tenant so switching organizations never mixes tokens.
    const authStore = createAuthStore(options.platform.storage, `yp_auth:${valid.tenant_id}`);
    const pb = new PocketBase(valid.backend_url, authStore);

    return new ProductClient(valid, pb);
  }

  hasFeature(name: string): boolean {
    return this.config.features.includes(name);
  }

  collection<T = RecordModel>(name: string) {
    return this.pb.collection<T>(name);
  }

  /**
   * Builds a safe filter string. Always pass user input through params;
   * never concatenate it into the filter.
   *   client.filter("author = {:id}", { id })
   */
  filter(raw: string, params?: Record<string, unknown>): string {
    return this.pb.filter(raw, params);
  }

  get isAuthenticated(): boolean {
    return this.pb.authStore.isValid;
  }

  login(email: string, password: string, authCollection = "users") {
    return this.pb.collection(authCollection).authWithPassword(email, password);
  }

  logout(): void {
    this.pb.authStore.clear();
  }
}
