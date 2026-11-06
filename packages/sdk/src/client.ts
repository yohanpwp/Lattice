import PocketBase, { type RecordModel } from "pocketbase";
import {
  assertAppConfig,
  assertFeatures,
  assertSchemaDefinition,
  assertPageDefinition,
  assertDashboardLayout,
  assertWorkspaceUser,
  assertWorkspaceSetupRequest,
  assertWorkspaceInvitation,
  assertModuleContract,
  assertWorkspaceModuleInstallation,
  ContractError,
  type ContractIssue,
  type AppConfig,
  type Features,
  type SchemaDefinition,
  type PageDefinition,
  type DashboardLayout,
  type WorkspaceUser,
  type WorkspaceSetupRequest,
  type WorkspaceInvitation,
  type DatasetPermission,
  type WorkspaceModule,
  type WorkspaceModuleInstallation,
  type ModuleContract,
} from "@lattice/types";
import { AuthPersistenceError, createAuthStore, type PersistentAuthStore } from "./authStore";
import { fetchAppConfig } from "./config";
import { ClientTooOldError, IncompatibleModuleError, ModuleSetupError } from "./errors";
import { createMemoryStorage, type PlatformAdapters } from "./platform";
import { isClientCompatible, isModuleVersionCompatible } from "./version";

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

export interface WorkspaceModuleEntry extends ModuleContract {
  installed: boolean;
  enabled: boolean;
  mapping?: any;
  installed_at?: string;
  updated_at?: string;
  compatible?: boolean;
  compatibility_error?: string;
}

/**
 * Splits and validates a module contract response alongside its installation state.
 * Validates the contract structure against ModuleContract schema and enforces
 * the client supported-version policy.
 */
export function assertModuleEntry(value: unknown): WorkspaceModuleEntry {
  if (!value || typeof value !== "object") {
    throw new ContractError("ModuleContract", [{ path: "/", message: "must be an object" }]);
  }
  const raw = value as Record<string, unknown>;
  const { installed, enabled, mapping, installed_at, updated_at, ...contractPart } = raw;

  const issues: ContractIssue[] = [];
  if (typeof installed !== "boolean") {
    issues.push({ path: "/installed", message: "must be a boolean" });
  }
  if (typeof enabled !== "boolean") {
    issues.push({ path: "/enabled", message: "must be a boolean" });
  }
  if (installed_at !== undefined && typeof installed_at !== "string") {
    issues.push({ path: "/installed_at", message: "must be a string" });
  }
  if (updated_at !== undefined && typeof updated_at !== "string") {
    issues.push({ path: "/updated_at", message: "must be a string" });
  }
  if (issues.length > 0) {
    throw new ContractError("ModuleContract", issues);
  }

  const contract = assertModuleContract(contractPart);
  if (!isModuleVersionCompatible(contract.version)) {
    throw new IncompatibleModuleError(contract.module_id, contract.version);
  }
  return {
    ...contract,
    installed: installed as boolean,
    enabled: enabled as boolean,
    ...(mapping !== undefined ? { mapping } : {}),
    ...(installed_at !== undefined ? { installed_at: installed_at as string } : {}),
    ...(updated_at !== undefined ? { updated_at: updated_at as string } : {}),
    compatible: true,
  };
}

/**
 * Maps backend HTTP errors to specific domain errors like IncompatibleModuleError and ModuleSetupError.
 */
function mapBackendModuleError(err: any, moduleId?: string): Error {
  const data = err?.response || err?.data;
  if (data && typeof data === "object") {
    if (data.error === "incompatible_module_contract") {
      const msg = data.message || err.message;
      const versionMatch = typeof msg === "string" ? /version\s+"([^"]+)"/.exec(msg) : null;
      const version = versionMatch ? versionMatch[1] : undefined;
      return new IncompatibleModuleError(moduleId ?? "unknown", version, msg);
    }
    if (typeof data.error === "string") {
      return new ModuleSetupError(data.message || err.message || "Failed to configure module", data.error, {
        created: Array.isArray(data.created) ? data.created : undefined,
        blockedOperations: Array.isArray(data.blocked_operations) ? data.blocked_operations : undefined,
        dataset: typeof data.dataset === "string" ? data.dataset : undefined,
      });
    }
  }
  if (err?.originalError instanceof Error) {
    return err.originalError;
  }
  return err;
}

/** Central API for every client platform. */
export class ProductClient {
  readonly config: AppConfig;
  readonly pb: PocketBase;
  readonly authStore: PersistentAuthStore;
  readonly platform: PlatformAdapters;
  readonly payments: PaymentsClient;
  private readonly knownManagedModules = new Set<string>(["customer_job_tracking"]);
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
    const list = await this.pb.send<SchemaDefinition[]>("/v1/schemas", { method: "GET", requestKey: null });
    const results: SchemaDefinition[] = [];
    for (const item of list ?? []) {
      try {
        results.push(assertSchemaDefinition(item));
      } catch (err) {
        console.warn("[getSchemas] Skipping invalid schema definition:", item?.schema_id, err);
      }
    }
    return results;
  }

  /**
   * Fetches a single business schema definition by schema_id from GET /v1/schemas/{id}.
   * Requires a signed-in user.
   */
  async getSchema(id: string): Promise<SchemaDefinition> {
    const data = await this.pb.send<SchemaDefinition>(`/v1/schemas/${encodeURIComponent(id)}`, { method: "GET", requestKey: null });
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
      requestKey: null,
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
      requestKey: null,
    });
    return assertSchemaDefinition(updated);
  }

  /**
   * Deletes a business schema definition via DELETE /v1/schemas/{id}.
   * Requires a signed-in user.
   */
  async deleteSchema(id: string): Promise<void> {
    await this.pb.send(`/v1/schemas/${encodeURIComponent(id)}`, { method: "DELETE", requestKey: null });
  }

  /**
   * Fetches all registered custom pages from app_pages collection.
   * Requires a signed-in user.
   */
  async getPages(): Promise<PageDefinition[]> {
    try {
      const records = await this.pb.collection("app_pages").getFullList({
        sort: "nav_order,created",
        requestKey: null,
      });
      return records.map((rec) =>
        assertPageDefinition({
          id: rec.id,
          page_id: rec.page_id,
          name: rec.name,
          description: rec.description || undefined,
          icon: rec.icon || undefined,
          view_type: rec.view_type,
          collection: rec.collection,
          published: rec.published !== false,
          nav_order: typeof rec.nav_order === "number" ? rec.nav_order : undefined,
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
        id: rec.id,
        page_id: rec.page_id,
        name: rec.name,
        description: rec.description || undefined,
        icon: rec.icon || undefined,
        view_type: rec.view_type,
        collection: rec.collection,
        published: rec.published !== false,
        nav_order: typeof rec.nav_order === "number" ? rec.nav_order : undefined,
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
   * Resolves a page identifier (either PocketBase record ID or human page_id slug)
   * to the authoritative PocketBase record ID.
   */
  private async resolvePageRecordId(recordIdOrPageId: string): Promise<string> {
    try {
      const byPageId = await this.pb
        .collection("app_pages")
        .getFirstListItem(this.filter("page_id = {:id}", { id: recordIdOrPageId }), { requestKey: null });
      if (byPageId && byPageId.id) {
        return byPageId.id;
      }
    } catch {
      // Not found by page_id
    }

    try {
      const byRecId = await this.pb.collection("app_pages").getOne(recordIdOrPageId, { requestKey: null });
      if (byRecId && byRecId.id) {
        return byRecId.id;
      }
    } catch {
      // Not found by record id
    }

    return recordIdOrPageId;
  }

  /**
   * Creates a custom page definition in app_pages (requires Owner or Admin).
   */
  async createPage(page: PageDefinition): Promise<PageDefinition> {
    const valid = assertPageDefinition({
      ...page,
      published: page.published ?? true,
      nav_order: page.nav_order ?? 0,
    });
    const rec = await this.pb.collection("app_pages").create(valid);
    return assertPageDefinition({
      id: rec.id,
      page_id: rec.page_id,
      name: rec.name,
      description: rec.description || undefined,
      icon: rec.icon || undefined,
      view_type: rec.view_type,
      collection: rec.collection,
      published: rec.published !== false,
      nav_order: typeof rec.nav_order === "number" ? rec.nav_order : undefined,
      config: rec.config ?? {},
      created: rec.created,
      updated: rec.updated,
    });
  }

  /**
   * Updates an existing custom page definition in app_pages (requires Owner or Admin).
   */
  async updatePage(recordIdOrPageId: string, page: Partial<PageDefinition>): Promise<PageDefinition> {
    const recId = await this.resolvePageRecordId(recordIdOrPageId);
    const rec = await this.pb.collection("app_pages").update(recId, page);
    return assertPageDefinition({
      id: rec.id,
      page_id: rec.page_id,
      name: rec.name,
      description: rec.description || undefined,
      icon: rec.icon || undefined,
      view_type: rec.view_type,
      collection: rec.collection,
      published: rec.published !== false,
      nav_order: typeof rec.nav_order === "number" ? rec.nav_order : undefined,
      config: rec.config ?? {},
      created: rec.created,
      updated: rec.updated,
    });
  }

  /**
   * Deletes a custom page definition from app_pages (requires Owner or Admin).
   */
  async deletePage(recordIdOrPageId: string): Promise<void> {
    const recId = await this.resolvePageRecordId(recordIdOrPageId);
    await this.pb.collection("app_pages").delete(recId);
  }

  /**
   * Loads a saved dashboard layout by name from the `dashboards` collection.
   */
  async getDashboardLayout(
    name = "main"
  ): Promise<(DashboardLayout & { revision?: number; recordId?: string }) | null> {
    try {
      const rec = await this.pb.collection("dashboards").getFirstListItem(
        this.filter("name = {:name}", { name }),
        { requestKey: null },
      );
      const layout = assertDashboardLayout(rec.layout);
      return {
        ...layout,
        revision: typeof rec.revision === "number" && rec.revision > 0 ? rec.revision : 1,
        recordId: rec.id,
      };
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      if (status === 404) return null;
      throw err;
    }
  }

  /**
   * Saves and publishes a shared or user-specific dashboard layout in the `dashboards` collection.
   * Uses optimistic concurrency control via `expectedRevision` to avoid silent write loss.
   * An expectedRevision of 0 asserts a first-time create; if a dashboard already exists, throws a 409 Conflict.
   * Requires owner or admin role.
   */
  async saveDashboardLayout(
    layout: DashboardLayout,
    name = "main",
    options?: { expectedRevision?: number },
  ): Promise<DashboardLayout & { revision?: number }> {
    const valid = assertDashboardLayout(layout);

    // Explicit first-create assertion: client expects no pre-existing dashboard record
    if (options?.expectedRevision === 0) {
      const existing = await this.pb
        .collection("dashboards")
        .getFirstListItem(this.filter("name = {:name}", { name }), { requestKey: null })
        .catch(() => null);
      if (existing) {
        const err = new Error(`Dashboard layout conflict: dashboard "${name}" already exists on server.`);
        (err as { status?: number }).status = 409;
        throw err;
      }
      try {
        const created = await this.pb.collection("dashboards").create({
          name,
          layout: valid,
          revision: 1,
        });
        const resLayout = assertDashboardLayout(created.layout);
        return {
          ...resLayout,
          revision: typeof created.revision === "number" ? created.revision : 1,
        };
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        if (status === 400 || (err as { message?: string })?.message?.includes("UNIQUE")) {
          (err as { status?: number }).status = 409;
        }
        throw err;
      }
    }

    const existing = await this.pb
      .collection("dashboards")
      .getFirstListItem(this.filter("name = {:name}", { name }), { requestKey: null })
      .catch(() => null);

    if (existing) {
      const expectedRevision =
        options?.expectedRevision ??
        (typeof existing.revision === "number" && existing.revision > 0 ? existing.revision : 1);
      const updated = await this.pb.collection("dashboards").update(existing.id, {
        name,
        layout: valid,
        expected_revision: expectedRevision,
      });
      const resLayout = assertDashboardLayout(updated.layout);
      return {
        ...resLayout,
        revision: typeof updated.revision === "number" ? updated.revision : expectedRevision + 1,
      };
    } else {
      if (typeof options?.expectedRevision === "number" && options.expectedRevision > 0) {
        const err = new Error(
          `Dashboard layout conflict: dashboard "${name}" does not exist to update (expected revision ${options.expectedRevision}).`
        );
        (err as { status?: number }).status = 409;
        throw err;
      }
      try {
        const created = await this.pb.collection("dashboards").create({
          name,
          layout: valid,
          revision: 1,
        });
        const resLayout = assertDashboardLayout(created.layout);
        return {
          ...resLayout,
          revision: typeof created.revision === "number" ? created.revision : 1,
        };
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        if (status === 400 || (err as { message?: string })?.message?.includes("UNIQUE")) {
          (err as { status?: number }).status = 409;
        }
        throw err;
      }
    }
  }

  /**
   * Initializes the workspace and creates the first owner using an operator setup secret.
   */
  async setupWorkspace(input: WorkspaceSetupRequest): Promise<WorkspaceUser> {
    const valid = assertWorkspaceSetupRequest(input);
    const created = await this.pb.send<WorkspaceUser>("/v1/workspace/setup", {
      method: "POST",
      body: valid,
      requestKey: null,
    });
    return assertWorkspaceUser(created);
  }

  /**
   * Lists all workspace users (requires Owner or Admin).
   */
  async getWorkspaceUsers(): Promise<WorkspaceUser[]> {
    const list = await this.pb.send<WorkspaceUser[]>("/v1/workspace/users", { method: "GET", requestKey: null });
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
      requestKey: null,
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
      requestKey: null,
    });
    return assertWorkspaceInvitation(created);
  }

  /**
   * Lists all pending invitations (requires Owner or Admin).
   */
  async getWorkspaceInvitations(): Promise<WorkspaceInvitation[]> {
    const list = await this.pb.send<WorkspaceInvitation[]>("/v1/workspace/invitations", { method: "GET", requestKey: null });
    return (list ?? []).map((inv) => assertWorkspaceInvitation(inv));
  }

  /**
   * Accepts a single-use invitation token and sets up credentials.
   */
  async acceptInvitation(input: { token: string; name: string; password: string }): Promise<WorkspaceUser> {
    const user = await this.pb.send<WorkspaceUser>("/v1/workspace/invitations/accept", {
      method: "POST",
      body: input,
      requestKey: null,
    });
    return assertWorkspaceUser(user);
  }

  /**
   * Revokes an existing invitation (requires Owner or Admin).
   */
  async revokeInvitation(id: string): Promise<void> {
    await this.pb.send(`/v1/workspace/invitations/${encodeURIComponent(id)}`, { method: "DELETE", requestKey: null });
  }

  /**
   * Reissues a fresh token for an unaccepted invitation (requires Owner or Admin).
   */
  async reissueInvitation(id: string): Promise<WorkspaceInvitation> {
    const reissued = await this.pb.send<WorkspaceInvitation>(
      `/v1/workspace/invitations/${encodeURIComponent(id)}/reissue`,
      { method: "POST", requestKey: null },
    );
    return assertWorkspaceInvitation(reissued);
  }

  /**
   * Fetches the current authenticated user's role and effective permissions.
   */
  async getMyPermissions(): Promise<{ user_id: string; role: string; permissions: Record<string, DatasetPermission> }> {
    return this.pb.send("/v1/workspace/permissions", { method: "GET", requestKey: null });
  }

  get currentUserRole(): "owner" | "admin" | "member" | null {
    const rec = this.pb.authStore.record;
    if (!rec) return null;
    return (rec.role as "owner" | "admin" | "member") || null;
  }

  get currentUserId(): string | null {
    return this.pb.authStore.record?.id || null;
  }

  get currentUserEmail(): string | null {
    return this.pb.authStore.record?.email || null;
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
   * Retrieves list of managed modules with installation and catalog status from server.
   * Validates each module contract and enforces the client's supported-version policy,
   * handling incompatible entries individually and surfacing their status while keeping
   * compatible modules available.
   */
  async getWorkspaceModules(): Promise<WorkspaceModuleEntry[]> {
    let res: any[];
    try {
      res = await this.pb.send<any[]>("/v1/workspace/modules", { method: "GET", requestKey: null });
    } catch (err: any) {
      if (err?.status === 404 || err?.response?.status === 404) {
        return [];
      }
      throw mapBackendModuleError(err);
    }
    if (!Array.isArray(res)) return [];
    const entries = res.map((entry) => {
      try {
        return assertModuleEntry(entry);
      } catch (err: unknown) {
        if (err instanceof IncompatibleModuleError || err instanceof ContractError) {
          const raw = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
          const moduleId =
            typeof raw.module_id === "string"
              ? raw.module_id
              : err instanceof IncompatibleModuleError
              ? err.moduleId
              : "unknown";
          const name = typeof raw.name === "string" ? raw.name : moduleId;
          const version =
            typeof raw.version === "string"
              ? raw.version
              : err instanceof IncompatibleModuleError && err.version
              ? err.version
              : "unknown";

          return {
            module_id: moduleId,
            name,
            version,
            description: typeof raw.description === "string" ? raw.description : undefined,
            icon: typeof raw.icon === "string" ? raw.icon : undefined,
            supported_platforms: Array.isArray(raw.supported_platforms)
              ? (raw.supported_platforms as any)
              : ["web"],
            required_datasets: Array.isArray(raw.required_datasets)
              ? (raw.required_datasets as any)
              : [],
            screens: Array.isArray(raw.screens) ? (raw.screens as string[]) : undefined,
            actions: Array.isArray(raw.actions) ? (raw.actions as string[]) : undefined,
            permissions:
              typeof raw.permissions === "object" && raw.permissions !== null
                ? (raw.permissions as any)
                : undefined,
            disabling: typeof raw.disabling === "string" ? raw.disabling : undefined,
            installed: typeof raw.installed === "boolean" ? raw.installed : false,
            enabled: false,
            mapping: raw.mapping,
            installed_at: typeof raw.installed_at === "string" ? raw.installed_at : undefined,
            updated_at: typeof raw.updated_at === "string" ? raw.updated_at : undefined,
            compatible: false,
            compatibility_error: err instanceof Error ? err.message : String(err),
          };
        }
        throw err;
      }
    });

    for (const item of entries) {
      if (item && typeof item.module_id === "string") {
        this.knownManagedModules.add(item.module_id);
      }
    }

    return entries;
  }

  /**
   * Retrieves specific module definition and installation status from server.
   * Validates the module contract and enforces the client's supported-version policy.
   */
  async getWorkspaceModule(id: string): Promise<WorkspaceModuleEntry | null> {
    let res: any;
    try {
      res = await this.pb.send<any>(`/v1/workspace/modules/${encodeURIComponent(id)}`, { method: "GET", requestKey: null });
    } catch (err: any) {
      if (err?.status === 404 || err?.response?.status === 404) {
        return null;
      }
      throw mapBackendModuleError(err, id);
    }
    if (!res) return null;
    const entry = assertModuleEntry(res);
    this.knownManagedModules.add(entry.module_id);
    return entry;
  }

  /**
   * Executes setup for a workspace module (creating suggested datasets or mapping existing ones).
   * Requires owner or admin authority.
   */
  async setupWorkspaceModule(
    id: string,
    payload: { use_suggested: boolean; mapping?: any }
  ): Promise<WorkspaceModuleInstallation> {
    let res: WorkspaceModuleInstallation;
    try {
      res = await this.pb.send<WorkspaceModuleInstallation>(`/v1/workspace/modules/${encodeURIComponent(id)}/setup`, {
        method: "POST",
        body: payload,
        requestKey: null,
      });
    } catch (err: any) {
      throw mapBackendModuleError(err, id);
    }
    const valid = assertWorkspaceModuleInstallation(res);
    if (!isModuleVersionCompatible(valid.version)) {
      throw new IncompatibleModuleError(valid.module_id, valid.version);
    }
    this.knownManagedModules.add(valid.module_id);
    // Sync state locally as well
    const disabled = await this.getDisabledModules();
    const set = new Set(disabled);
    set.delete(id);
    const key = `lattice:disabled_modules:${encodeURIComponent(this.config.backend_url)}:${encodeURIComponent(this.config.tenant_id)}`;
    await this.platform.storage.setItem(key, JSON.stringify(Array.from(set)));
    return valid;
  }

  /**
   * Subscribes to realtime updates for workspace module installations.
   */
  subscribeWorkspaceModules(callback: (event: any) => void): () => void {
    let unsubscribed = false;
    if (typeof (globalThis as any).EventSource !== "undefined") {
      this.pb
        .collection("workspace_modules")
        .subscribe("*", (e) => {
          if (!unsubscribed) {
            callback(e);
          }
        })
        .catch((err) => {
          console.warn("Realtime subscription to workspace_modules failed:", err);
        });
    }
    return () => {
      unsubscribed = true;
      if (typeof (globalThis as any).EventSource !== "undefined") {
        this.pb.collection("workspace_modules").unsubscribe("*").catch(() => {});
      }
    };
  }

  /**
   * Retrieves list of disabled module IDs for this tenant workspace.
   */
  async getDisabledModules(): Promise<string[]> {
    const disabled = new Set<string>();
    try {
      const key = `lattice:disabled_modules:${encodeURIComponent(this.config.backend_url)}:${encodeURIComponent(this.config.tenant_id)}`;
      const raw = await this.platform.storage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const id of parsed) {
            disabled.add(id);
          }
        }
      }
    } catch {
      // Fallback
    }

    if (this.isAuthenticated) {
      try {
        const serverModules = await this.getWorkspaceModules();
        for (const sm of serverModules) {
          if (sm && sm.module_id) {
            if (sm.compatible === false || !sm.installed || !sm.enabled) {
              disabled.add(sm.module_id);
            } else {
              disabled.delete(sm.module_id);
            }
          }
        }
      } catch {
        // Fallback gracefully if server is unreachable
      }

      // Also query workspace_modules directly for unmanaged module status
      try {
        const records = await this.pb.collection("workspace_modules").getFullList({ requestKey: null });
        for (const rec of records) {
          if (rec.module_id) {
            if (rec.enabled === false) {
              disabled.add(rec.module_id);
            } else if (rec.enabled === true) {
              disabled.delete(rec.module_id);
            }
          }
        }
      } catch {
        // Fallback gracefully
      }
    }

    return Array.from(disabled);
  }

  /**
   * Checks whether a module is currently enabled.
   */
  async isModuleEnabled(moduleId: string): Promise<boolean> {
    if (this.isAuthenticated) {
      try {
        const serverMod = await this.getWorkspaceModule(moduleId);
        if (serverMod && serverMod.module_id && typeof serverMod.enabled === "boolean") {
          return Boolean(serverMod.installed && serverMod.enabled);
        }
      } catch (err) {
        const mapped = mapBackendModuleError(err, moduleId);
        if (mapped instanceof IncompatibleModuleError || mapped instanceof ContractError) {
          throw mapped;
        }
        // Fallback to local storage if module retrieval fails due to offline/network error
      }
    }
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

    let isManaged = this.knownManagedModules.has(moduleId) || moduleId === "customer_job_tracking";
    let compatibilityVerified = false;
    let lookupError: unknown = null;

    if (enabled) {
      try {
        const serverMod = await this.getWorkspaceModule(moduleId);
        if (serverMod) {
          isManaged = true;
          this.knownManagedModules.add(moduleId);
          if (serverMod.compatible === false) {
            throw new IncompatibleModuleError(moduleId, serverMod.version, serverMod.compatibility_error);
          }
          compatibilityVerified = true;
        }
      } catch (err) {
        if (err instanceof IncompatibleModuleError || err instanceof ContractError) {
          throw err;
        }
        lookupError = err;
      }

      if (!compatibilityVerified) {
        try {
          const serverModules = await this.getWorkspaceModules();
          const target = serverModules.find((m) => m.module_id === moduleId);
          if (target) {
            isManaged = true;
            this.knownManagedModules.add(moduleId);
            if (target.compatible === false) {
              throw new IncompatibleModuleError(moduleId, target.version, target.compatibility_error);
            }
            compatibilityVerified = true;
            lookupError = null;
          }
        } catch (err) {
          if (err instanceof IncompatibleModuleError || err instanceof ContractError) {
            throw err;
          }
          if (!lookupError) {
            lookupError = err;
          }
        }
      }

      if (isManaged && !compatibilityVerified) {
        throw lookupError ?? new Error(`Unable to verify compatibility for managed module "${moduleId}"`);
      }
    } else {
      if (!isManaged) {
        try {
          const serverModules = await this.getWorkspaceModules();
          if (serverModules.some((m) => m.module_id === moduleId)) {
            isManaged = true;
            this.knownManagedModules.add(moduleId);
          }
        } catch {
          // Fallback
        }
      }
    }

    if (isManaged) {
      await this.pb.send<WorkspaceModuleInstallation>(`/v1/workspace/modules/${encodeURIComponent(moduleId)}`, {
        method: "PUT",
        body: { enabled },
        requestKey: null,
      });
    } else {
      // Persist workspace-wide module status in workspace_modules collection
      const existing = await this.pb
        .collection("workspace_modules")
        .getFirstListItem(this.filter("module_id = {:id}", { id: moduleId }), { requestKey: null })
        .catch(() => null);

      if (existing) {
        await this.pb.collection("workspace_modules").update(existing.id, {
          enabled,
        });
      } else {
        await this.pb.collection("workspace_modules").create({
          module_id: moduleId,
          enabled,
          version: "1.0.0",
          mapping: {},
        });
      }
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
    const [schemas, pages, managedModules] = await Promise.all([
      this.getSchemas().catch(() => [] as SchemaDefinition[]),
      this.getPages().catch(() => [] as PageDefinition[]),
      this.getWorkspaceModules().catch(() => []),
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

    // 5. Managed workspace modules from server catalog
    for (const mm of managedModules) {
      modules.push({
        id: mm.module_id,
        name: mm.name,
        description: mm.compatibility_error
          ? `${mm.description || "Managed workspace module"} (${mm.compatibility_error})`
          : (mm.description || "Managed workspace module"),
        icon: mm.icon || "📦",
        enabled: Boolean(mm.compatible !== false && mm.installed && mm.enabled),
        dataset_id: mm.mapping?.job_dataset,
        compatible: mm.compatible !== false,
        compatibility_error: mm.compatibility_error,
      });
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
