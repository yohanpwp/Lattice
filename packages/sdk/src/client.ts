import PocketBase, { type RecordModel } from "pocketbase";
import { assertAppConfig, assertFeatures, type AppConfig, type Features } from "@lattice/types";
import { AuthPersistenceError, createAuthStore, type PersistentAuthStore } from "./authStore";
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

export class RealtimeURLMismatchError extends Error {
  constructor(configured: string, expected: string) {
    super(`realtime_url must be ${expected}; received ${configured}`);
    this.name = "RealtimeURLMismatchError";
  }
}

function normalizeBackendURL(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("backend_url must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("backend_url cannot include credentials, query parameters, or a fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href.replace(/\/$/, "");
}

function normalizeRealtimeURL(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href.replace(/\/$/, "");
}

import { PaymentsClient } from "./payments";

/** Central API for every client platform. */
export class ProductClient {
  readonly config: AppConfig;
  readonly pb: PocketBase;
  readonly authStore: PersistentAuthStore;
  readonly payments: PaymentsClient;
  private constructor(config: AppConfig, pb: PocketBase, authStore: PersistentAuthStore) {
    this.config = config;
    this.pb = pb;
    this.authStore = authStore;
    this.payments = new PaymentsClient(pb);
  }

  /** Resolves when any saved session has been loaded. */
  get sessionRestored(): Promise<void> {
    return this.authStore.ready;
  }

  static async connect(options: ConnectOptions): Promise<ProductClient> {
    const config = await fetchAppConfig(options.backendUrl, options.platform.fetch);
    return ProductClient.fromConfig(config, options);
  }

  static async fromConfig(config: unknown, options: ClientOptions): Promise<ProductClient> {
    const valid = assertAppConfig(config);
    if (!isClientCompatible(options.clientVersion, valid.min_client_version)) {
      throw new ClientTooOldError(options.clientVersion, valid.min_client_version);
    }

    const backendURL = normalizeBackendURL(valid.backend_url);
    const expectedRealtimeURL = `${backendURL}/api/realtime`;
    const realtimeURL = normalizeRealtimeURL(valid.realtime_url);
    if (realtimeURL !== expectedRealtimeURL) {
      throw new RealtimeURLMismatchError(realtimeURL, expectedRealtimeURL);
    }

    await options.platform.initializeRealtime?.();
    const key = `lattice:auth:${encodeURIComponent(backendURL)}:${encodeURIComponent(valid.tenant_id)}`;
    const authStore = createAuthStore(options.platform.storage, key);
    await authStore.ready;
    const pb = new PocketBase(backendURL, authStore);
    pb.beforeSend = async (url, requestOptions) => {
      await authStore.flush();
      return {
        url,
        options: { ...requestOptions, fetch: options.platform.fetch ?? requestOptions.fetch },
      };
    };

    return new ProductClient(valid, pb, authStore);
  }

  /**
   * Fetches the tenant's feature flags and non-secret options from
   * GET /v1/features. Requires a signed-in user.
   */
  async getFeatures(): Promise<Features> {
    const data = await this.pb.send("/v1/features", { method: "GET" });
    return assertFeatures(data);
  }

  hasFeature(name: string): boolean {
    return this.config.features.includes(name);
  }

  collection<T = RecordModel>(name: string) {
    return this.pb.collection<T>(name);
  }

  /** PocketBase filter placeholder binding; pass values as params, never interpolate. */
  filter(raw: string, params?: Record<string, unknown>): string {
    return this.pb.filter(raw, params);
  }

  get isAuthenticated(): boolean {
    return this.pb.authStore.isValid;
  }

  async login(email: string, password: string, authCollection = "users") {
    const result = await this.pb.collection(authCollection).authWithPassword(email, password);
    await this.authStore.flush();
    return result;
  }

  /**
   * Checks a restored session with the server and refreshes its token.
   * Returns false (and signs out locally) if the session is gone or rejected
   * (expired, revoked, user deleted). A network failure keeps the session, so
   * an offline app does not sign people out.
   */
  async refreshSession(): Promise<boolean> {
    if (!this.pb.authStore.token) return false;
    if (!this.pb.authStore.isValid) {
      this.pb.authStore.clear();
      await this.authStore.flush();
      return false;
    }

    const collection = this.pb.authStore.record?.collectionName ?? "users";
    try {
      await this.pb.collection(collection).authRefresh();
      await this.authStore.flush();
      return true;
    } catch (err) {
      if (err instanceof AuthPersistenceError) throw err;
      const status = (err as { status?: number } | null)?.status;
      if (status === 401 || status === 403 || status === 404) {
        this.pb.authStore.clear();
        await this.authStore.flush();
        return false;
      }
      return true;
    }
  }

  async logout(): Promise<void> {
    this.pb.authStore.clear();
    await this.authStore.flush();
  }
}
