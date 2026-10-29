import PocketBase, { type RecordModel } from "pocketbase";
import {
  assertAppConfig,
  assertFeatures,
  assertSchemaDefinition,
  assertPageDefinition,
  assertWorkspaceUser,
  assertWorkspaceSetupRequest,
  assertWorkspaceInvitation,
  type AppConfig,
  type Features,
  type SchemaDefinition,
  type PageDefinition,
  type WorkspaceUser,
  type WorkspaceSetupRequest,
  type WorkspaceInvitation,
  type DatasetPermission,
  type WorkspaceModule,
} from "@lattice/types";
import { AuthPersistenceError, createAuthStore, type PersistentAuthStore } from "./authStore";
import { fetchAppConfig } from "./config";
import { ClientTooOldError } from "./errors";
import { createMemoryStorage, type PlatformAdapters } from "./platform";
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
  readonly platform: PlatformAdapters;
  readonly payments: PaymentsClient;
  private constructor(config: AppConfig, pb: PocketBase, authStore: PersistentAuthStore, platform?: PlatformAdapters) {
    this.config = config;
    this.pb = pb;
    this.authStore = authStore;
    this.platform = platform ?? { storage: createMemoryStorage() };
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

    return new ProductClient(valid, pb, authStore, options.platform);
  }

  /**
   * Fetches the tenant's feature flags and non-secret options from
   * GET /v1/features. Requires a signed-in user.
   */
  async getFeatures(): Promise<Features> {
    const data = await this.pb.send("/v1/features", { method: "GET" });
    return assertFeatures(data);
  }

  /**
   * Fetches all registered business schema definitions from GET /v1/schemas.
   * Requires a signed-in user.
   */
  async getSchemas(): Promise<SchemaDefinition[]> {
    const list = await this.pb.send<SchemaDefinition[]>("/v1/schemas", { method: "GET" });
    return (list ?? []).map((item) => assertSchemaDefinition(item));
  }

  /**
   * Fetches a single business schema definition by schema_id from GET /v1/schemas/{id}.
   * Requires a signed-in user.
   */
  async getSchema(id: string): Promise<SchemaDefinition> {
    const data = await this.pb.send<SchemaDefinition>(`/v1/schemas/${encodeURIComponent(id)}`, { method: "GET" });
    return assertSchemaDefinition(data);
  }

  /**
   * Creates a new business schema definition via POST /v1/schemas.
   * Backed by a PocketBase collection and stored in schema_definitions.
   * Requires a signed-in user.
   */
  async createSchema(def: SchemaDefinition): Promise<SchemaDefinition> {
    const valid = assertSchemaDefinition(def);
    const created = await this.pb.send<SchemaDefinition>("/v1/schemas", {
      method: "POST",
      body: valid,
    });
    return assertSchemaDefinition(created);
  }

  /**
   * Safely updates an existing business schema definition via PATCH /v1/schemas/{id}.
   * Requires owner or admin user.
   */
  async updateSchema(id: string, update: Partial<SchemaDefinition>): Promise<SchemaDefinition> {
    const updated = await this.pb.send<SchemaDefinition>(`/v1/schemas/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: update,
    });
    return assertSchemaDefinition(updated);
  }

  /**
   * Deletes a business schema definition via DELETE /v1/schemas/{id}.
   * Requires a signed-in user.
   */
  async deleteSchema(id: string): Promise<void> {
    await this.pb.send(`/v1/schemas/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /**
   * Fetches all registered custom pages from app_pages collection.
   * Requires a signed-in user.
   */
  async getPages(): Promise<PageDefinition[]> {
    try {
      const records = await this.pb.collection("app_pages").getFullList({
        sort: "created",
        requestKey: null,
      });
      return records.map((rec) =>
        assertPageDefinition({
          page_id: rec.page_id,
          name: rec.name,
          description: rec.description || undefined,
          icon: rec.icon || undefined,
          view_type: rec.view_type,
          collection: rec.collection,
          config: rec.config ?? {},
          created: rec.created,
          updated: rec.updated,
        }),
      );
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      if (status === 404) return [];
      throw err;
    }
  }

  /**
   * Fetches a single custom page definition by page_id.
   * Requires a signed-in user.
   */
  async getPage(pageId: string): Promise<PageDefinition | null> {
    try {
      const rec = await this.pb.collection("app_pages").getFirstListItem(
        this.filter("page_id = {:id}", { id: pageId }),
        { requestKey: null },
      );
      return assertPageDefinition({
        page_id: rec.page_id,
        name: rec.name,
        description: rec.description || undefined,
        icon: rec.icon || undefined,
        view_type: rec.view_type,
        collection: rec.collection,
        config: rec.config ?? {},
        created: rec.created,
        updated: rec.updated,
      });
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      if (status === 404) return null;
      throw err;
    }
  }

  /**
   * Creates a custom page definition in app_pages (requires Owner or Admin).
   */
  async createPage(page: PageDefinition): Promise<PageDefinition> {
    const valid = assertPageDefinition(page);
    const rec = await this.pb.collection("app_pages").create(valid);
    return assertPageDefinition({
      page_id: rec.page_id,
      name: rec.name,
      description: rec.description || undefined,
      icon: rec.icon || undefined,
      view_type: rec.view_type,
      collection: rec.collection,
      config: rec.config ?? {},
      created: rec.created,
      updated: rec.updated,
    });
  }

  /**
   * Updates an existing custom page definition in app_pages (requires Owner or Admin).
   */
  async updatePage(recordId: string, page: Partial<PageDefinition>): Promise<PageDefinition> {
    const rec = await this.pb.collection("app_pages").update(recordId, page);
    return assertPageDefinition({
      page_id: rec.page_id,
      name: rec.name,
      description: rec.description || undefined,
      icon: rec.icon || undefined,
      view_type: rec.view_type,
      collection: rec.collection,
      config: rec.config ?? {},
      created: rec.created,
      updated: rec.updated,
    });
  }

  /**
   * Deletes a custom page definition from app_pages (requires Owner or Admin).
   */
  async deletePage(recordId: string): Promise<void> {
    await this.pb.collection("app_pages").delete(recordId);
  }

  /**
   * Initializes the workspace and creates the first owner using an operator setup secret.
   */
  async setupWorkspace(input: WorkspaceSetupRequest): Promise<WorkspaceUser> {
    const valid = assertWorkspaceSetupRequest(input);
    const created = await this.pb.send<WorkspaceUser>("/v1/workspace/setup", {
      method: "POST",
      body: valid,
    });
    return assertWorkspaceUser(created);
  }

  /**
   * Lists all workspace users (requires Owner or Admin).
   */
  async getWorkspaceUsers(): Promise<WorkspaceUser[]> {
    const list = await this.pb.send<WorkspaceUser[]>("/v1/workspace/users", { method: "GET" });
    return (list ?? []).map((u) => assertWorkspaceUser(u));
  }

  /**
   * Updates a workspace user's role, status, or permissions (requires Owner or Admin).
   */
  async updateWorkspaceUser(
    id: string,
    update: { role?: "owner" | "admin" | "member"; disabled?: boolean; permissions?: Record<string, DatasetPermission> },
  ): Promise<WorkspaceUser> {
    const updated = await this.pb.send<WorkspaceUser>(`/v1/workspace/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: update,
    });
    return assertWorkspaceUser(updated);
  }

  /**
   * Creates an invitation for a new member or admin (requires Owner or Admin).
   */
  async createInvitation(input: { email: string; role: "admin" | "member"; permissions?: Record<string, unknown> }): Promise<WorkspaceInvitation> {
    const created = await this.pb.send<WorkspaceInvitation>("/v1/workspace/invitations", {
      method: "POST",
      body: input,
    });
    return assertWorkspaceInvitation(created);
  }

  /**
   * Lists all pending invitations (requires Owner or Admin).
   */
  async getWorkspaceInvitations(): Promise<WorkspaceInvitation[]> {
    const list = await this.pb.send<WorkspaceInvitation[]>("/v1/workspace/invitations", { method: "GET" });
    return (list ?? []).map((inv) => assertWorkspaceInvitation(inv));
  }

  /**
   * Accepts a single-use invitation token and sets up credentials.
   */
  async acceptInvitation(input: { token: string; name: string; password: string }): Promise<WorkspaceUser> {
    const user = await this.pb.send<WorkspaceUser>("/v1/workspace/invitations/accept", {
      method: "POST",
      body: input,
    });
    return assertWorkspaceUser(user);
  }

  /**
   * Revokes an existing invitation (requires Owner or Admin).
   */
  async revokeInvitation(id: string): Promise<void> {
    await this.pb.send(`/v1/workspace/invitations/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /**
   * Reissues a fresh token for an unaccepted invitation (requires Owner or Admin).
   */
  async reissueInvitation(id: string): Promise<WorkspaceInvitation> {
    const reissued = await this.pb.send<WorkspaceInvitation>(
      `/v1/workspace/invitations/${encodeURIComponent(id)}/reissue`,
      { method: "POST" },
    );
    return assertWorkspaceInvitation(reissued);
  }

  /**
   * Fetches the current authenticated user's role and effective permissions.
   */
  async getMyPermissions(): Promise<{ user_id: string; role: string; permissions: Record<string, DatasetPermission> }> {
    return this.pb.send("/v1/workspace/permissions", { method: "GET" });
  }

  get currentUserRole(): "owner" | "admin" | "member" | null {
    const rec = this.pb.authStore.record;
    if (!rec) return null;
    return (rec.role as "owner" | "admin" | "member") || null;
  }

  get currentUserId(): string | null {
    return this.pb.authStore.record?.id || null;
  }

  get isOwner(): boolean {
    return this.currentUserRole === "owner";
  }

  get isAdmin(): boolean {
    return this.currentUserRole === "admin";
  }

  get isOwnerOrAdmin(): boolean {
    return this.isOwner || this.isAdmin;
  }

  hasDatasetPermission(dataset: string, action: "read" | "create" | "update" | "delete"): boolean {
    if (this.isOwnerOrAdmin) return true;
    if (this.currentUserRole !== "member") return false;
    const rec = this.pb.authStore.record as { permissions?: Record<string, DatasetPermission> } | null;
    if (!rec?.permissions) return false;
    const perm = rec.permissions[dataset];
    if (!perm) return false;
    return Boolean(perm[action]);
  }

  getDatasetScope(dataset: string): "all" | "assigned" | null {
    if (this.isOwnerOrAdmin) return "all";
    if (this.currentUserRole !== "member") return null;
    const rec = this.pb.authStore.record as { permissions?: Record<string, DatasetPermission> } | null;
    return rec?.permissions?.[dataset]?.scope || null;
  }

  hasFeature(name: string): boolean {
    return this.config.features.includes(name);
  }

  /**
   * Retrieves list of disabled module IDs for this tenant workspace.
   */
  async getDisabledModules(): Promise<string[]> {
    try {
      const key = `lattice:disabled_modules:${encodeURIComponent(this.config.backend_url)}:${encodeURIComponent(this.config.tenant_id)}`;
      const raw = await this.platform.storage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Checks whether a module is currently enabled.
   */
  async isModuleEnabled(moduleId: string): Promise<boolean> {
    const disabled = await this.getDisabledModules();
    return !disabled.includes(moduleId);
  }

  /**
   * Enables or disables a module in the workspace.
   * Requires owner or admin authority.
   */
  async setModuleEnabled(moduleId: string, enabled: boolean): Promise<void> {
    if (!this.isOwnerOrAdmin) {
      throw new Error("Only workspace owners and admins can configure workspace modules");
    }
    const current = await this.getDisabledModules();
    const set = new Set(current);
    if (enabled) {
      set.delete(moduleId);
    } else {
      set.add(moduleId);
    }
    const key = `lattice:disabled_modules:${encodeURIComponent(this.config.backend_url)}:${encodeURIComponent(this.config.tenant_id)}`;
    await this.platform.storage.setItem(key, JSON.stringify(Array.from(set)));
  }

  /**
   * Discovers and returns all workspace modules (dashboards, features, datasets, and pages)
   * mapped with their active status, dataset linkages, and custom pages.
   */
  async getModules(): Promise<WorkspaceModule[]> {
    const disabled = new Set(await this.getDisabledModules());
    const modules: WorkspaceModule[] = [];

    // 1. Dashboard module
    modules.push({
      id: "dashboard",
      name: "Dashboard & Analytics",
      description: "Overview metrics, KPIs, and operational dashboard summaries",
      icon: "📊",
      enabled: !disabled.has("dashboard"),
    });

    // 2. Built-in feature flags from tenant config
    for (const feat of this.config.features) {
      const id = `feature_${feat}`;
      const name = feat.charAt(0).toUpperCase() + feat.slice(1).replace(/[-_]/g, " ");
      modules.push({
        id,
        name: `Feature: ${name}`,
        description: `Built-in workspace capability flag (${feat})`,
        icon: "⚡",
        enabled: !disabled.has(id),
        feature_flag: feat,
      });
    }

    // 3. Schema datasets and their mapped custom pages
    const [schemas, pages] = await Promise.all([
      this.getSchemas().catch(() => [] as SchemaDefinition[]),
      this.getPages().catch(() => [] as PageDefinition[]),
    ]);

    const mappedPageIds = new Set<string>();

    for (const schema of schemas) {
      const id = schema.schema_id;
      const associatedPages = pages.filter((p) => p.collection === schema.schema_id);
      for (const p of associatedPages) {
        mappedPageIds.add(p.page_id);
      }
      modules.push({
        id,
        name: schema.name,
        description: schema.description || `Dataset management for ${schema.name}`,
        icon: schema.icon || "📁",
        enabled: !disabled.has(id),
        dataset_id: schema.schema_id,
        page_ids: associatedPages.map((p) => p.page_id),
      });
    }

    // 4. Standalone custom pages not mapped to any registered schema
    for (const page of pages) {
      if (!mappedPageIds.has(page.page_id)) {
        const id = `page_${page.page_id}`;
        modules.push({
          id,
          name: page.name,
          description: page.description || `Custom view (${page.view_type})`,
          icon: page.icon || "📄",
          enabled: !disabled.has(id),
          page_ids: [page.page_id],
        });
      }
    }

    return modules;
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
    try {
      await this.pb.realtime.unsubscribe();
    } catch {
      // Ignore if realtime connection is inactive
    }
    this.pb.authStore.clear();
    await this.authStore.flush();
  }

  /**
   * Attempts to reconnect the realtime SSE stream upon resume if there
   * are active subscriptions or a previously established connection.
   *
   * Preserves active subscriptions and re-schedules automatic exponential backoff
   * if the reconnection attempt fails while offline.
   */
  async reconnectRealtime(): Promise<void> {
    const rt = this.pb.realtime as unknown as {
      subscriptions?: Record<string, unknown>;
      clientId?: string;
      isConnected?: boolean;
      connect: () => Promise<void>;
      initConnect?: () => void;
      reconnectAttempts?: number;
      maxReconnectAttempts?: number;
      predefinedReconnectIntervals?: number[];
      reconnectTimeoutId?: ReturnType<typeof setTimeout>;
    };
    if (!rt) return;

    const savedSubscriptions = rt.subscriptions ? { ...rt.subscriptions } : {};
    const hasSubscriptions = Object.keys(savedSubscriptions).length > 0;
    if (!hasSubscriptions && !rt.clientId && !rt.isConnected) {
      return;
    }

    if (rt.reconnectTimeoutId) {
      clearTimeout(rt.reconnectTimeoutId);
      rt.reconnectTimeoutId = undefined;
    }

    const prevAttempts = rt.reconnectAttempts ?? 0;
    rt.reconnectAttempts = 0;

    try {
      await rt.connect();
    } catch {
      // Reconnect failed while offline. Restore active subscriptions and
      // re-schedule automatic retry backoff so retries are preserved.
      if (rt.subscriptions && Object.keys(rt.subscriptions).length === 0 && hasSubscriptions) {
        rt.subscriptions = savedSubscriptions;
      }
      if (!rt.reconnectTimeoutId) {
        const intervals = rt.predefinedReconnectIntervals || [200, 300, 500, 1000, 1200, 1500, 2000];
        const nextAttempt = prevAttempts + 1;
        const maxAttempts = rt.maxReconnectAttempts ?? Infinity;
        if (nextAttempt <= maxAttempts) {
          const delay = intervals[Math.min(nextAttempt - 1, intervals.length - 1)] || 1000;
          rt.reconnectAttempts = nextAttempt;
          rt.reconnectTimeoutId = setTimeout(() => {
            if (typeof rt.initConnect === "function") {
              rt.initConnect();
            } else {
              this.reconnectRealtime().catch(() => {});
            }
          }, delay);
        }
      }
    }
  }
}
