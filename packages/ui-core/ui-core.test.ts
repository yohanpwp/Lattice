import React from "react";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import {
  columnsFor,
  defaultDashboard,
  displayValue,
  forgetWorkspace,
  isClientComputable,
  loadDashboardLayout,
  loadSavedWorkspace,
  normalizeWorkspaceUrl,
  parseMetric,
  rowLabel,
  saveWorkspace,
  sortWidgets,
  assertAppConfig,
  assertDashboardLayout,
  assertFeatures,
  assertPluginManifest,
  assertEventEnvelope,
  assertSchemaDefinition,
  assertPageDefinition,
  ContractError,
  buildListOptions,
  perPageFor,
  resolvePlatform,
  SchemaNavigation,
  SchemaRecordModal,
  CreateSchemaModal,
  ConfirmModal,
  DynamicPageView,
  TableView,
  KanbanView,
  MasterDetailView,
  SchemaView,
  FileCell,
  WorkspaceSetupForm,
  AcceptInviteForm,
  WorkspaceMembersModal,
  WorkspaceModulesModal,
  CustomerJobTrackingSetupModal,
  CustomerJobTrackingView,
  PageEditorModal,
  DashboardEditorModal,
  isDashboardDraftDirty,
  dashboardEditorDraftReducer,
  type DashboardEditorDraftState,
  jobModalDraftReducer,
  buildJobCreatePayload,
  type JobModalDraftState,
  isAbortError,
  CJT_JOBS_REQUEST_KEY,
  CJT_CUSTOMER_LIST_REQUEST_KEY,
  CJT_PICKER_REQUEST_KEY,
  DashboardPage,
  type DataClient,
} from "./index";
import type { SchemaDefinition, PageDefinition, DashboardLayout } from "@lattice/types";
import { createMemoryStorage } from "@lattice/sdk";

describe("workspace URL normalization and storage", () => {
  it("normalizes standard https domains", () => {
    const res = normalizeWorkspaceUrl("acme.app.example.com");
    expect(res).toEqual({ ok: true, url: "https://acme.app.example.com" });
  });

  it("normalizes localhost and ports to http", () => {
    const res = normalizeWorkspaceUrl("localhost:8090");
    expect(res).toEqual({ ok: true, url: "http://localhost:8090" });
  });

  it("rejects http for non-local domains", () => {
    const res = normalizeWorkspaceUrl("http://insecure.example.com");
    expect(res.ok).toBe(false);
  });

  it("rejects credentials in URL", () => {
    const res = normalizeWorkspaceUrl("https://user:pass@example.com");
    expect(res.ok).toBe(false);
  });

  it("saves, loads, and forgets workspace in storage", async () => {
    const storage = createMemoryStorage();
    expect(await loadSavedWorkspace(storage)).toBeNull();

    await saveWorkspace(storage, "https://acme.app.example.com");
    expect(await loadSavedWorkspace(storage)).toBe("https://acme.app.example.com");

    await forgetWorkspace(storage);
    expect(await loadSavedWorkspace(storage)).toBeNull();
  });

  it("resolves platform with strict precedence over storage prop", async () => {
    const platformStorage = createMemoryStorage();
    const fallbackStorage = createMemoryStorage();
    const platform = { storage: platformStorage };

    // When both platform and storage are passed, platform strictly wins
    const resolved = resolvePlatform(platform, fallbackStorage);
    expect(resolved).toBe(platform);
    expect(resolved.storage).toBe(platformStorage);

    // Persistence goes to platform.storage
    await saveWorkspace(resolved.storage, "https://tenant.example.com");
    expect(await loadSavedWorkspace(platformStorage)).toBe("https://tenant.example.com");
    expect(await loadSavedWorkspace(fallbackStorage)).toBeNull();

    // When only storage is passed, wraps into platform adapter
    const storageOnly = resolvePlatform(undefined, fallbackStorage);
    expect(storageOnly.storage).toBe(fallbackStorage);

    // When neither is passed, defaults to web storage
    const defaultPlatform = resolvePlatform(undefined, undefined);
    expect(defaultPlatform.storage).toBeDefined();
  });
});

describe("metrics parsing and computability", () => {
  it("parses count metric", () => {
    const metric = parseMetric("count");
    expect(metric).toEqual({ type: "count" });
    expect(isClientComputable(metric)).toBe(true);
  });

  it("parses default empty metric as count", () => {
    const metric = parseMetric();
    expect(metric).toEqual({ type: "count" });
    expect(isClientComputable(metric)).toBe(true);
  });

  it("parses server aggregate metrics", () => {
    const sumMetric = parseMetric("sum:revenue");
    expect(sumMetric).toEqual({ type: "sum", field: "revenue" });
    expect(isClientComputable(sumMetric)).toBe(false);

    const avgMetric = parseMetric("avg:rating");
    expect(avgMetric).toEqual({ type: "avg", field: "rating" });
    expect(isClientComputable(avgMetric)).toBe(false);
  });

  it("throws on invalid metrics", () => {
    expect(() => parseMetric("invalid:field")).toThrow();
  });
});

describe("formatting and column helpers", () => {
  it("formats display values", () => {
    expect(displayValue(null)).toBe("");
    expect(displayValue(undefined)).toBe("");
    expect(displayValue(true)).toBe("true");
    expect(displayValue(false)).toBe("false");
    expect(displayValue(42)).toBe("42");
    expect(displayValue("hello")).toBe("hello");
    expect(displayValue({ foo: "bar" })).toBe('{"foo":"bar"}');
  });

  it("extracts and orders columns with id first", () => {
    const items = [
      { name: "First", id: "1", role: "admin" },
      { id: "2", status: "active" },
    ];
    const columns = columnsFor(items);
    expect(columns[0]).toBe("id");
    expect(columns).toContain("name");
    expect(columns).toContain("role");
    expect(columns).toContain("status");
  });

  it("respects explicit fields argument", () => {
    const items = [{ id: "1", name: "Alice", email: "a@b.com" }];
    expect(columnsFor(items, ["name", "email"])).toEqual(["name", "email"]);
  });

  it("determines row label from conventional keys", () => {
    expect(rowLabel({ name: "My Project", id: "123" })).toBe("My Project");
    expect(rowLabel({ title: "My Title", id: "123" })).toBe("My Title");
    expect(rowLabel({ label: "My Label", id: "123" })).toBe("My Label");
    expect(rowLabel({ id: "123" })).toBe("123");
    expect(rowLabel({})).toBe("â€”");
  });
});

describe("layout and dashboard loading", () => {
  it("sorts widgets by row y then column x", () => {
    const widgets = [
      { id: "w2", type: "kpi" as const, collection: "a", x: 6, y: 1, w: 3, h: 2 },
      { id: "w1", type: "kpi" as const, collection: "a", x: 0, y: 0, w: 3, h: 2 },
      { id: "w3", type: "kpi" as const, collection: "a", x: 2, y: 1, w: 3, h: 2 },
    ];
    const sorted = sortWidgets(widgets);
    expect(sorted.map((w) => w.id)).toEqual(["w1", "w3", "w2"]);
  });

  it("generates default dashboard layout", () => {
    const defaultLayout = defaultDashboard(["users", "orders"]);
    expect(defaultLayout.id).toBe("default");
    expect(defaultLayout.layout.length).toBe(2);
    expect(defaultLayout.layout[0]?.type).toBe("kpi");
    expect(defaultLayout.layout[0]?.collection).toBe("users");
    expect(defaultLayout.layout[1]?.collection).toBe("orders");
  });

  it("loads saved dashboard layout when present and valid", async () => {
    const fakeClient: DataClient = {
      collection: () => ({
        getList: async () => ({
          items: [
            {
              id: "rec1",
              name: "main",
              layout: {
                id: "custom",
                name: "Custom",
                layout: [{ id: "w1", type: "kpi", collection: "items", x: 0, y: 0, w: 3, h: 2 }],
              },
            },
          ],
          totalItems: 1,
        }),
      }),
      filter: (raw) => raw,
    };

    const res = await loadDashboardLayout(fakeClient, ["items"]);
    expect(res.source).toBe("saved");
    expect(res.layout.id).toBe("custom");
  });

  it("falls back to default when collection returns 404", async () => {
    const fakeClient: DataClient = {
      collection: () => ({
        getList: async () => {
          const err = new Error("Not found") as Error & { status: number };
          err.status = 404;
          throw err;
        },
      }),
      filter: (raw) => raw,
    };

    const res = await loadDashboardLayout(fakeClient, ["orders"]);
    expect(res.source).toBe("default");
    expect(res.warning).toBeUndefined();
  });

  it("falls back to default with warning when saved layout is invalid", async () => {
    const fakeClient: DataClient = {
      collection: () => ({
        getList: async () => ({
          items: [{ id: "rec1", name: "main", layout: "not-a-valid-layout" }],
          totalItems: 1,
        }),
      }),
      filter: (raw) => raw,
    };

    const res = await loadDashboardLayout(fakeClient, ["orders"]);
    expect(res.source).toBe("default");
    expect(res.warning).toContain("invalid");
  });
});

describe("query options", () => {
  it("builds query options safely with filter binding", () => {
    const widget = {
      id: "w1",
      type: "table" as const,
      collection: "users",
      x: 0,
      y: 0,
      w: 6,
      h: 4,
      props: {
        filter: "status = {:status}",
        params: { status: "active" },
        sort: "-created",
        fields: ["name", "email"],
      },
    };

    const options = buildListOptions(widget, (raw, params) => `${raw}:${JSON.stringify(params)}`);
    expect(options.filter).toBe('status = {:status}:{"status":"active"}');
    expect(options.sort).toBe("-created");
    expect(options.fields).toBe("id,name,email");
    expect(perPageFor("table")).toBe(10);
    expect(perPageFor("kpi")).toBe(1);
  });
});

describe("generated validators", () => {
  it("validates valid and invalid AppConfig", () => {
    const validConfig = {
      version: 1,
      tenant_id: "tenant_dev",
      backend_url: "https://acme.app.example.com",
      realtime_url: "https://acme.app.example.com/api/realtime",
      app_key: "pk_dev_000000",
      schema_version: "opaque_id",
      min_client_version: "0.1.0",
      features: ["feature_a"],
      collections: ["orders"],
    };
    expect(assertAppConfig(validConfig)).toEqual(validConfig);

    expect(() => assertAppConfig({ version: "not-a-number" })).toThrowError(ContractError);
  });

  it("validates Features and DashboardLayout", () => {
    const validFeatures = {
      features: {
        dark_mode: { enabled: true },
      },
    };
    expect(assertFeatures(validFeatures)).toEqual(validFeatures);

    const validDashboard = {
      id: "d1",
      name: "Dashboard 1",
      layout: [{ id: "w1", type: "kpi", collection: "orders", x: 0, y: 0, w: 3, h: 2 }],
    };
    expect(assertDashboardLayout(validDashboard)).toEqual(validDashboard);

    const validManifest = {
      name: "payments",
      version: "1.0.0",
      interface_version: 1,
      license: "MIT",
    };
    expect(assertPluginManifest(validManifest)).toEqual(validManifest);

    const validEvent = {
      version: 1,
      id: "018f4a12-8e7c-7d9a-9c4b-2f3e4a5b6c7d",
      type: "order.created",
      occurred_at: "2026-10-05T12:00:00Z",
      tenant_id: "tenant_dev",
      data: { order_id: 123 },
    };
    expect(assertEventEnvelope(validEvent)).toEqual(validEvent);
  });
});

describe("schema navigation and validation", () => {
  const sampleSchema: SchemaDefinition = {
    schema_id: "inventory",
    name: "à¸„à¸¥à¸±à¸‡à¸ªà¸´à¸™à¸„à¹‰à¸²",
    description: "Warehouse inventory stock",
    icon: "ðŸ“¦",
    fields: [
      { name: "sku", label: "SKU Code", type: "text", required: true },
      { name: "stock", label: "In Stock", type: "number", required: true },
      { name: "status", label: "Status", type: "select", options: ["available", "low", "empty"] },
    ],
  };

  it("validates SchemaDefinition contract assertions", () => {
    expect(assertSchemaDefinition(sampleSchema)).toEqual(sampleSchema);

    // Invalid schema_id
    expect(() =>
      assertSchemaDefinition({
        ...sampleSchema,
        schema_id: "123-invalid",
      }),
    ).toThrowError(ContractError);

    // Empty fields list
    expect(() =>
      assertSchemaDefinition({
        ...sampleSchema,
        fields: [],
      }),
    ).toThrowError(ContractError);
  });

  it("renders SchemaNavigation with dynamic pages and schema tabs without builder buttons", () => {
    const samplePage: PageDefinition = {
      page_id: "inventory-board",
      name: "Inventory Board",
      view_type: "kanban",
      collection: "inventory",
      icon: "ðŸ“Œ",
    };

    const html = renderToString(
      React.createElement(SchemaNavigation, {
        pages: [samplePage],
        schemas: [sampleSchema],
        activeTab: "inventory-board",
        onSelectTab: () => {},
      }),
    );

    expect(html).toContain("Dashboard Overview");
    expect(html).toContain("Inventory Board");
    expect(html).toContain("ðŸ“Œ");
    expect(html).toContain("à¸„à¸¥à¸±à¸‡à¸ªà¸´à¸™à¸„à¹‰à¸²");
    expect(html).toContain("ðŸ“¦");
    // Webview navigation must NOT have + New Schema or + New Page buttons
    expect(html).not.toContain("+ New Schema");
    expect(html).not.toContain("+ New Page");
    expect(html).toContain("lattice-tab--active");
  });

  it("renders DynamicPageView with TableView and respects permission guards", () => {
    const tablePage: PageDefinition = {
      page_id: "inventory-table",
      name: "Inventory Table",
      view_type: "table",
      collection: "inventory",
    };

    const fakeClient = {
      collection: () => ({
        getList: async () => ({ items: [], totalPages: 1, totalItems: 0 }),
        subscribe: () => Promise.resolve(() => {}),
        unsubscribe: () => Promise.resolve(),
      }),
      filter: (raw: string) => raw,
    } as unknown as import("@lattice/sdk").ProductClient;

    // 1. When can_create is false, "+ Add Record" must NOT be rendered
    const readOnlySchema: SchemaDefinition = {
      ...sampleSchema,
      can_create: false,
      can_update: false,
      can_delete: false,
    };

    const readOnlyHtml = renderToString(
      React.createElement(DynamicPageView, {
        client: fakeClient,
        page: tablePage,
        schemas: [readOnlySchema],
      }),
    );

    expect(readOnlyHtml).toContain("Inventory Table");
    expect(readOnlyHtml).toContain("Table View");
    expect(readOnlyHtml).not.toContain("+ Add Record");
    expect(readOnlyHtml).not.toContain("Actions");

    // 2. When can_create is true, "+ Add Record" is rendered
    const writableSchema: SchemaDefinition = {
      ...sampleSchema,
      can_create: true,
      can_update: true,
      can_delete: true,
    };

    const writableHtml = renderToString(
      React.createElement(DynamicPageView, {
        client: fakeClient,
        page: tablePage,
        schemas: [writableSchema],
        initialRecords: [{ id: "rec1", sku: "SKU-001", stock: 10, status: "available" }],
      }),
    );

    expect(writableHtml).toContain("+ Add Record");
    expect(writableHtml).toContain("Actions");
    expect(writableHtml).toContain("Edit");
    expect(writableHtml).toContain("Delete");
  });

  it("renders KanbanView with lanes according to select options and respects permissions", () => {
    const kanbanPage: PageDefinition = {
      page_id: "inventory-kanban",
      name: "Inventory Workflow",
      view_type: "kanban",
      collection: "inventory",
      config: {
        groupByField: "status",
      },
    };

    const fakeClient = {
      collection: () => ({
        getList: async () => ({ items: [], totalPages: 1, totalItems: 0 }),
        subscribe: () => Promise.resolve(() => {}),
        unsubscribe: () => Promise.resolve(),
      }),
      filter: (raw: string) => raw,
    } as unknown as import("@lattice/sdk").ProductClient;

    const schemaWithPermissions: SchemaDefinition = {
      ...sampleSchema,
      can_create: true,
      can_update: false,
      can_delete: false,
    };

    const html = renderToString(
      React.createElement(DynamicPageView, {
        client: fakeClient,
        page: kanbanPage,
        schemas: [schemaWithPermissions],
      }),
    );

    expect(html).toContain("Inventory Workflow");
    expect(html).toContain("Kanban View");
    expect(html).toContain("available");
    expect(html).toContain("low");
    expect(html).toContain("empty");
    // With can_create: true, column + buttons are visible
    expect(html).toContain("+ Add Record");
  });

  it("renders MasterDetailView with master panel and relation section", () => {
    const masterDetailPage: PageDefinition = {
      page_id: "customers-detail",
      name: "Customer Orders",
      view_type: "master_detail",
      collection: "inventory",
      config: {
        detailCollection: "inventory",
        relationField: "inventory_id",
      },
    };

    const fakeClient = {
      collection: () => ({
        getList: async () => ({ items: [], totalPages: 1, totalItems: 0 }),
        subscribe: () => Promise.resolve(() => {}),
        unsubscribe: () => Promise.resolve(),
      }),
      filter: (raw: string) => raw,
    } as unknown as import("@lattice/sdk").ProductClient;

    const html = renderToString(
      React.createElement(DynamicPageView, {
        client: fakeClient,
        page: masterDetailPage,
        schemas: [sampleSchema],
      }),
    );

    expect(html).toContain("Customer Orders");
    expect(html).toContain("Master-Detail View");
    expect(html).toContain("lattice-master-list-panel");
    expect(html).toContain("lattice-detail-panel");
  });

  it("dynamically renders SchemaRecordModal matching schema fields and types", () => {
    const html = renderToString(
      React.createElement(SchemaRecordModal, {
        schema: sampleSchema,
        isOpen: true,
        onClose: () => {},
        onSave: async () => {},
      }),
    );

    // Checks that inputs are rendered for all editable fields
    expect(html).toContain("SKU Code");
    expect(html).toContain("In Stock");
    expect(html).toContain("Status");
    // Checks that select options from the contract are rendered
    expect(html).toContain('value="available"');
    expect(html).toContain('value="low"');
    expect(html).toContain('value="empty"');
    // Checks that required field indicator is present
    expect(html).toContain("lattice-req");
  });

  it("dynamically renders optional field additions in SchemaRecordModal and TableView when schema definition changes", () => {
    // 1. Initial schema definition without optional field
    const initialModalHtml = renderToString(
      React.createElement(SchemaRecordModal, {
        schema: sampleSchema,
        isOpen: true,
        onClose: () => {},
        onSave: async () => {},
      }),
    );
    expect(initialModalHtml).not.toContain("Special Instructions");
    expect(initialModalHtml).not.toContain('id="field-notes"');

    // 2. Updated schema session (after owner adds optional field "notes" and client synchronizes/navigates)
    const updatedSchemaWithNotes: SchemaDefinition = {
      ...sampleSchema,
      fields: [
        ...sampleSchema.fields,
        { name: "notes", label: "Special Instructions", type: "text", required: false },
      ],
    };

    const updatedModalHtml = renderToString(
      React.createElement(SchemaRecordModal, {
        schema: updatedSchemaWithNotes,
        isOpen: true,
        onClose: () => {},
        onSave: async () => {},
      }),
    );
    expect(updatedModalHtml).toContain("Special Instructions");
    expect(updatedModalHtml).toContain('id="field-notes"');

    // 3. TableView on second client immediately reflects the new column without manual code change
    const mockClient = {
      hasDatasetPermission: () => true,
      collection: () => ({
        getList: async () => ({ items: [], totalPages: 1, totalItems: 0 }),
      }),
    } as unknown as Parameters<typeof TableView>[0]["client"];

    const pageDef: PageDefinition = {
      page_id: "inventory_page",
      name: "Inventory",
      view_type: "table",
      collection: "inventory",
    };

    const tableHtml = renderToString(
      React.createElement(TableView, {
        client: mockClient,
        page: pageDef,
        schema: updatedSchemaWithNotes,
        initialRecords: [{ id: "rec_1", sku: "SKU-001", stock: 5, notes: "Handle with care" }],
      }),
    );
    expect(tableHtml).toContain("Special Instructions");
    expect(tableHtml).toContain("Handle with care");
  });

  it("renders CreateSchemaModal dialog and field definitions builder", () => {
    const html = renderToString(
      React.createElement(CreateSchemaModal, {
        isOpen: true,
        onClose: () => {},
        onCreate: async () => {},
      }),
    );

    expect(html).toContain("Create New Dynamic Schema");
    expect(html).toContain("Schema ID (Table identifier)");
    expect(html).toContain("Dataset Fields Definition");
    expect(html).toContain("+ Add Field");
  });

  it("renders ConfirmModal with custom title, message, and danger action", () => {
    const html = renderToString(
      React.createElement(ConfirmModal, {
        isOpen: true,
        title: "Delete Inventory Item",
        message: "Are you sure you want to delete this record? This cannot be undone.",
        confirmLabel: "Delete Now",
        confirmVariant: "danger",
        onConfirm: () => {},
        onCancel: () => {},
      }),
    );

    expect(html).toContain("Delete Inventory Item");
    expect(html).toContain("Are you sure you want to delete this record?");
    expect(html).toContain("Delete Now");
    expect(html).toContain("lattice-btn-danger");
    expect(html).toContain("Cancel");
  });

  it("renders WorkspaceSetupForm with operator secret and owner registration fields", () => {
    const mockClient = {
      config: { tenant_id: "tenant_dev" },
      setupWorkspace: async () => {},
      login: async () => {},
    } as unknown as Parameters<typeof WorkspaceSetupForm>[0]["client"];

    const html = renderToString(
      React.createElement(WorkspaceSetupForm, {
        client: mockClient,
      }),
    );

    expect(html).toContain("Setup your workspace");
    expect(html).toContain("Operator setup secret");
    expect(html).toContain("Owner email");
    expect(html).toContain("Complete setup");
  });

  it("renders WorkspaceMembersModal with team dialog structure", () => {
    const mockClient = {
      isOwner: true,
      getWorkspaceUsers: async () => [],
    } as unknown as Parameters<typeof WorkspaceMembersModal>[0]["client"];

    const html = renderToString(
      React.createElement(WorkspaceMembersModal, {
        isOpen: true,
        onClose: () => {},
        client: mockClient,
        schemas: [sampleSchema],
      }),
    );

    expect(html).toContain("Workspace Team &amp; Access Control");
    expect(html).toContain("+ Invite Member");
  });

  it("renders SchemaNavigation with New Dataset button when canCreateSchema is true", () => {
    const html = renderToString(
      React.createElement(SchemaNavigation, {
        schemas: [sampleSchema],
        activeTab: "dashboard",
        onSelectTab: () => {},
        canCreateSchema: true,
        onCreateSchemaClick: () => {},
      }),
    );

    expect(html).toContain("New Dataset");
  });

  it("renders AcceptInviteForm with invite token, name, and password fields", () => {
    const mockClient = {
      config: { tenant_id: "tenant_dev" },
      acceptInvitation: async () => ({ email: "user@example.com" }),
      login: async () => {},
    } as unknown as Parameters<typeof AcceptInviteForm>[0]["client"];

    const html = renderToString(
      React.createElement(AcceptInviteForm, {
        client: mockClient,
        initialToken: "inv_tok_12345",
      }),
    );

    expect(html).toContain("Accept Invitation");
    expect(html).toContain("Invitation Token");
    expect(html).toContain("Your Full Name");
    expect(html).toContain("Accept &amp; Sign In");
    expect(html).toContain("inv_tok_12345");
  });

  it("renders CreateSchemaModal with Assignee Field selector", () => {
    const html = renderToString(
      React.createElement(CreateSchemaModal, {
        isOpen: true,
        onClose: () => {},
        onCreate: async () => {},
      }),
    );

    expect(html).toContain("Assignee Field (Optional)");
    expect(html).toContain("None (No assigned record scoping)");
    expect(html).toContain("Designating an assignee field enables");
  });

  it("renders CreateSchemaModal with relation target selection from available schemas", () => {
    const html = renderToString(
      React.createElement(CreateSchemaModal, {
        isOpen: true,
        onClose: () => {},
        onCreate: async () => {},
        schemas: [
          sampleSchema,
          {
            schema_id: "customers",
            name: "Customer Directory",
            fields: [{ name: "name", type: "text" }],
          },
        ],
        initialFields: [
          { name: "title", label: "Title", type: "text" },
          { name: "client", label: "Client", type: "relation", target: "customers" },
        ],
      }),
    );

    expect(html).toContain("Create New Dynamic Schema");
    expect(html).toContain("Target Collection");
    expect(html).toContain("Available Collections");
    expect(html).toContain("users (Workspace Users / Team)");
    expect(html).toContain("customers (Customer Directory)");
  });

  it("renders SchemaNavigation conditionally showing or hiding Dashboard tab", () => {
    // 1. With showDashboard: true (default)
    const withDash = renderToString(
      React.createElement(SchemaNavigation, {
        schemas: [sampleSchema],
        activeTab: "dashboard",
        onSelectTab: () => {},
        showDashboard: true,
      }),
    );
    expect(withDash).toContain("Dashboard Overview");

    // 2. With showDashboard: false (when dashboard module is disabled)
    const withoutDash = renderToString(
      React.createElement(SchemaNavigation, {
        schemas: [sampleSchema],
        activeTab: sampleSchema.schema_id,
        onSelectTab: () => {},
        showDashboard: false,
      }),
    );
    expect(withoutDash).not.toContain("Dashboard Overview");
    expect(withoutDash).toContain(sampleSchema.name);
  });

  it("renders WorkspaceModulesModal with module list, type chips, and status badges", () => {
    const modulesList = [
      {
        id: "dashboard",
        name: "Dashboard & Analytics",
        icon: "ðŸ“Š",
        enabled: true,
      },
      {
        id: "customers",
        name: "Customers Directory",
        icon: "ðŸ‘¥",
        dataset_id: "customers",
        page_ids: ["cust_table"],
        enabled: true,
      },
      {
        id: "feature_billing",
        name: "Feature: Billing",
        icon: "âš¡",
        feature_flag: "billing",
        enabled: false,
      },
    ];

    const mockClient = {
      config: { tenant_id: "tenant_dev", features: ["billing"] },
      isOwnerOrAdmin: true,
      currentUserRole: "owner",
      getModules: async () => modulesList,
      getDisabledModules: async () => ["feature_billing"],
      setModuleEnabled: async () => {},
    } as unknown as Parameters<typeof WorkspaceModulesModal>[0]["client"];

    const html = renderToString(
      React.createElement(WorkspaceModulesModal, {
        isOpen: true,
        onClose: () => {},
        client: mockClient,
        initialModules: modulesList,
      }),
    );

    expect(html).toContain("Workspace Modules &amp; Capabilities");
    expect(html).toContain("Total Modules");
    expect(html).toContain("Search modules by name, dataset, or tagâ€¦");
    expect(html).toContain("Datasets");
    expect(html).toContain("Features");
    expect(html).toContain("Close");
    expect(html).toContain("Dashboard &amp; Analytics");
    expect(html).toContain("Customers Directory");
    expect(html).toContain("Feature: Billing");
  });

  it("renders WorkspaceModulesModal with incompatible module showing incompatible badge, disabled button, and no Enable button", () => {
    const mockClient = {
      config: { tenant_id: "tenant_dev" },
      isOwnerOrAdmin: true,
      currentUserRole: "owner",
      getModules: async () => [],
      getDisabledModules: async () => [],
      setModuleEnabled: async () => {},
    } as unknown as Parameters<typeof WorkspaceModulesModal>[0]["client"];

    const sampleModules = [
      {
        id: "customer_job_tracking",
        name: "Customer & Job Tracking",
        icon: "ðŸ’¼",
        enabled: true,
        compatible: true,
      },
      {
        id: "future_module",
        name: "Future Module V2",
        icon: "ðŸš€",
        enabled: false,
        compatible: false,
        compatibility_error: 'incompatible module version: version "2.0.0" is not supported (supported major version: 1)',
      },
      {
        id: "standard_disabled_mod",
        name: "Inventory Tracking",
        icon: "ðŸ“¦",
        enabled: false,
        compatible: true,
      },
    ];

    const html = renderToString(
      React.createElement(WorkspaceModulesModal, {
        isOpen: true,
        onClose: () => {},
        client: mockClient,
        initialModules: sampleModules,
      }),
    );

    const cleanHtml = html.replace(/<!-- -->/g, "");
    // Summary metrics include Incompatible count
    expect(cleanHtml).toContain("Incompatible");
    expect(cleanHtml).toContain("lattice-status-badge--incompatible");
    expect(cleanHtml).toContain("âœ•</span> Incompatible");

    // Incompatible module action button is disabled and labeled Incompatible, NOT Enable
    expect(cleanHtml).toContain('disabled=""');
    expect(cleanHtml).toContain(
      'title="incompatible module version: version &quot;2.0.0&quot; is not supported (supported major version: 1)"',
    );
    expect(cleanHtml).toContain(">Incompatible</button>");

    // Standard disabled module still shows Enable button
    expect(cleanHtml).toContain(">Enable</button>");

    // Active module shows Disable button
    expect(cleanHtml).toContain(">Disable</button>");
  });

  it("renders SchemaView sorting correctly when created field is absent", () => {
    const mockClient = {
      hasDatasetPermission: () => true,
      filter: () => "",
      collection: () => ({
        getList: async () => ({ items: [], totalPages: 1, totalItems: 0 }),
        subscribe: () => Promise.resolve(() => {}),
        unsubscribe: () => Promise.resolve(),
      }),
      isOwnerOrAdmin: true,
    } as unknown as Parameters<typeof SchemaView>[0]["client"];

    // Schema without 'created' field
    const schemaWithoutCreated: SchemaDefinition = {
      schema_id: "customers",
      name: "Customers",
      fields: [
        { name: "customer_name", label: "Customer Name", type: "text", required: true },
        { name: "tier", label: "Tier", type: "select", options: ["standard", "vip"] },
      ],
    };

    const html = renderToString(
      React.createElement(SchemaView, {
        client: mockClient,
        schema: schemaWithoutCreated,
      }),
    );

    expect(html).toContain("Customers");
    expect(html).toContain("recordsâ€¦");
    expect(html).toContain("+ Add Field");
    expect(html).toContain("+ Add Record");
  });

  it("renders SchemaRecordModal displaying auto-assignment banner for assigned members", () => {
    const mockMemberClient = {
      isOwnerOrAdmin: false,
      currentUserRole: "member",
      getDatasetScope: (id: string) => (id === "jobs" ? "assigned" : "all"),
      currentUserId: "member_123",
      authStore: {
        record: {
          id: "member_123",
          name: "Alice Member",
          email: "alice@example.com",
          role: "member",
          permissions: {
            jobs: { read: true, create: true, update: true, delete: false, scope: "assigned" },
          },
        },
      },
    } as unknown as Parameters<typeof SchemaRecordModal>[0]["client"];

    const jobsSchema: SchemaDefinition = {
      schema_id: "jobs",
      name: "Jobs",
      assignee_field: "assigned_user",
      fields: [
        { name: "title", label: "Job Title", type: "text", required: true },
        { name: "assigned_user", label: "Assigned Member", type: "relation", target: "users", required: true },
      ],
    };

    const html = renderToString(
      React.createElement(SchemaRecordModal, {
        client: mockMemberClient,
        schema: jobsSchema,
        isOpen: true,
        onClose: () => {},
        onSave: async () => {},
      }),
    );

    expect(html).toContain("Add New Jobs");
    expect(html).toContain("Job Title");
    expect(html).toContain("Assigned to you:");
    expect(html).toContain("Alice Member");
    expect(html).toContain("automatically be assigned to your account");
  });

  it("renders RelationPicker with target schema display fields support", () => {
    const mockClient = {
      filter: (tmpl: string) => tmpl,
      collection: () => ({
        getList: async () => ({
          items: [
            { id: "cust_1", name: "Acme Corp", email: "contact@acme.com" },
            { id: "cust_2", name: "Beta LLC", email: "contact@beta.com" },
          ],
          totalPages: 1,
          totalItems: 2,
        }),
      }),
      getSchema: async () => ({
        schema_id: "customers",
        name: "Customers",
        fields: [
          { name: "name", label: "Company Name", type: "text" },
          { name: "email", label: "Email", type: "email" },
        ],
      }),
    } as unknown as Parameters<typeof SchemaRecordModal>[0]["client"];

    const customersSchema: SchemaDefinition = {
      schema_id: "customers",
      name: "Customers",
      fields: [
        { name: "name", label: "Company Name", type: "text", required: true },
        { name: "email", label: "Email", type: "email" },
      ],
    };

    const jobsSchema: SchemaDefinition = {
      schema_id: "jobs",
      name: "Jobs",
      fields: [
        { name: "title", label: "Job Title", type: "text", required: true },
        { name: "customer", label: "Customer", type: "relation", target: "customers" },
      ],
    };

    const html = renderToString(
      React.createElement(SchemaRecordModal, {
        client: mockClient,
        schema: jobsSchema,
        schemas: [customersSchema, jobsSchema],
        isOpen: true,
        onClose: () => {},
        onSave: async () => {},
      }),
    );

    expect(html).toContain("Search customersâ€¦");
    expect(html).toContain("Dataset");
    expect(html).toContain("Enter ID manually");
    expect(html).toContain("Customer");
  });

  it("renders CustomerJobTrackingSetupModal with suggested and custom options", () => {
    const mockClient = {
      isOwnerOrAdmin: true,
      setupWorkspaceModule: async () => {},
    } as unknown as Parameters<typeof CustomerJobTrackingSetupModal>[0]["client"];

    const html = renderToString(
      React.createElement(CustomerJobTrackingSetupModal, {
        client: mockClient,
        schemas: [],
        isOpen: true,
        onClose: () => {},
      }),
    );

    expect(html).toContain("Configure Customer &amp; Job Tracking");
    expect(html).toContain("Create Suggested Datasets (Recommended)");
    expect(html).toContain("Map Existing Datasets");
    expect(html).toContain("Customers");
    expect(html).toContain("Jobs");
    expect(html).toContain("Team Access &amp; Isolation Rules");
    expect(html).toContain("Save &amp; Enable Module");
  });

  it("renders CustomerJobTrackingSetupModal custom mapping mode with field dropdowns and pre-selected datasets", () => {
    const mockClient = {
      isOwnerOrAdmin: true,
      setupWorkspaceModule: async () => {},
    } as unknown as Parameters<typeof CustomerJobTrackingSetupModal>[0]["client"];

    const customSchemas: SchemaDefinition[] = [
      {
        schema_id: "client_directory",
        name: "Client Directory",
        fields: [
          { name: "client_name", label: "Client Name", type: "text", required: true },
          { name: "contact_number", label: "Contact Number", type: "text", required: false },
        ],
      },
      {
        schema_id: "work_orders",
        name: "Work Orders",
        assignee_field: "assigned_tech",
        fields: [
          { name: "summary", label: "Summary", type: "text", required: true },
          { name: "client_link", label: "Client", type: "relation", required: true, target: "client_directory" },
          { name: "current_state", label: "State", type: "select", required: true, options: ["Open", "In progress", "Done"] },
          { name: "assigned_tech", label: "Assigned Tech", type: "relation", required: true, target: "users" },
        ],
      },
    ];

    const html = renderToString(
      React.createElement(CustomerJobTrackingSetupModal, {
        client: mockClient,
        schemas: customSchemas,
        initialMode: "custom",
        initialCustomerDataset: "client_directory",
        initialJobDataset: "work_orders",
        isOpen: true,
        onClose: () => {},
      }),
    );

    const cleanHtml = html.replace(/<!-- -->/g, "");
    expect(cleanHtml).toContain("1. Customer Dataset");
    expect(cleanHtml).toContain("Client Directory (client_directory)");
    expect(cleanHtml).toContain("Client Name (text)");
    expect(cleanHtml).toContain("Contact Number (text)");
    expect(cleanHtml).toContain("2. Job Dataset");
    expect(cleanHtml).toContain("Work Orders (work_orders)");
    expect(cleanHtml).toContain("Summary (text)");
    expect(cleanHtml).toContain("Client â†’ client_directory");
    expect(cleanHtml).toContain("Assigned Tech â†’ users");
    expect(cleanHtml).toContain("Team Access &amp; Isolation Rules");
  });

  it("renders CustomerJobTrackingSetupModal with actionable error banner on validation failure", () => {
    const mockClient = {
      isOwnerOrAdmin: true,
      setupWorkspaceModule: async () => {},
    } as unknown as Parameters<typeof CustomerJobTrackingSetupModal>[0]["client"];

    const html = renderToString(
      React.createElement(CustomerJobTrackingSetupModal, {
        client: mockClient,
        schemas: [],
        initialError: 'incompatible mapping: relation field "client_link" must target "client_directory"',
        isOpen: true,
        onClose: () => {},
      }),
    );

    expect(html).toContain("lattice-alert-error");
    expect(html).toContain('incompatible mapping: relation field &quot;client_link&quot; must target &quot;client_directory&quot;');
  });

  it("renders CustomerJobTrackingSetupModal recovery card on partial provisioning failure showing preserved datasets and retry guidance", () => {
    const mockClient = {
      isOwnerOrAdmin: true,
      setupWorkspaceModule: async () => {},
    } as unknown as Parameters<typeof CustomerJobTrackingSetupModal>[0]["client"];

    const html = renderToString(
      React.createElement(CustomerJobTrackingSetupModal, {
        client: mockClient,
        schemas: [],
        initialError: "Failed to provision jobs collection: disk error",
        initialCreatedDatasets: ["customers"],
        isOpen: true,
        onClose: () => {},
      }),
    );

    const cleanHtml = html.replace(/<!-- -->/g, "");
    expect(cleanHtml).toContain("âš ï¸ Setup Interrupted");
    expect(cleanHtml).toContain("Why setup stopped:");
    expect(cleanHtml).toContain("Failed to provision jobs collection: disk error");
    expect(cleanHtml).toContain("Datasets preserved in workspace:");
    expect(cleanHtml).toContain("<code>customers</code> (created and ready)");
    expect(cleanHtml).toContain("Safe to retry:</strong> Existing datasets will be reused without creating duplicates.");
    expect(cleanHtml).toContain("ðŸ”„ Retry Setup");
  });

  it("renders CustomerJobTrackingSetupModal recovery card on rule protection failure carrying created datasets and blocked operations", () => {
    const mockClient = {
      isOwnerOrAdmin: true,
      setupWorkspaceModule: async () => {},
    } as unknown as Parameters<typeof CustomerJobTrackingSetupModal>[0]["client"];

    const html = renderToString(
      React.createElement(CustomerJobTrackingSetupModal, {
        client: mockClient,
        schemas: [],
        initialError: "incompatible rules on customers dataset",
        initialCreatedDatasets: ["customers", "jobs"],
        initialBlockedOperations: ["view", "list"],
        isOpen: true,
        onClose: () => {},
      }),
    );

    const cleanHtml = html.replace(/<!-- -->/g, "");
    expect(cleanHtml).toContain("âš ï¸ Setup Interrupted");
    expect(cleanHtml).toContain("Why setup stopped:");
    expect(cleanHtml).toContain("incompatible rules on customers dataset");
    expect(cleanHtml).toContain("Datasets preserved in workspace:");
    expect(cleanHtml).toContain("<code>customers</code> (created and ready)");
    expect(cleanHtml).toContain("<code>jobs</code> (created and ready)");
    expect(cleanHtml).toContain("Blocked operations:</strong> view, list");
    expect(cleanHtml).toContain("Safe to retry:</strong> Existing datasets will be reused without creating duplicates.");
    expect(cleanHtml).toContain("ðŸ”„ Retry Setup");
  });

  it("renders CustomerJobTrackingSetupModal recovery card on installation save failure carrying created datasets", () => {
    const mockClient = {
      isOwnerOrAdmin: true,
      setupWorkspaceModule: async () => {},
    } as unknown as Parameters<typeof CustomerJobTrackingSetupModal>[0]["client"];

    const html = renderToString(
      React.createElement(CustomerJobTrackingSetupModal, {
        client: mockClient,
        schemas: [],
        initialError: "failed to save installation record to workspace_modules",
        initialCreatedDatasets: ["customers", "jobs"],
        isOpen: true,
        onClose: () => {},
      }),
    );

    const cleanHtml = html.replace(/<!-- -->/g, "");
    expect(cleanHtml).toContain("âš ï¸ Setup Interrupted");
    expect(cleanHtml).toContain("Why setup stopped:");
    expect(cleanHtml).toContain("failed to save installation record to workspace_modules");
    expect(cleanHtml).toContain("Datasets preserved in workspace:");
    expect(cleanHtml).toContain("<code>customers</code> (created and ready)");
    expect(cleanHtml).toContain("<code>jobs</code> (created and ready)");
    expect(cleanHtml).toContain("Safe to retry:</strong> Existing datasets will be reused without creating duplicates.");
    expect(cleanHtml).toContain("ðŸ”„ Retry Setup");
  });

  it("renders SchemaNavigation with Jobs & Customers tab when enabled", () => {
    const htmlEnabled = renderToString(
      React.createElement(SchemaNavigation, {
        schemas: [],
        activeTab: "customer_job_tracking",
        onSelectTab: () => {},
        showCustomerJobTracking: true,
      }),
    );
    expect(htmlEnabled).toContain("Jobs &amp; Customers");
    expect(htmlEnabled).toContain("lattice-tab--active");

    const htmlDisabled = renderToString(
      React.createElement(SchemaNavigation, {
        schemas: [],
        activeTab: "dashboard",
        onSelectTab: () => {},
        showCustomerJobTracking: false,
      }),
    );
    expect(htmlDisabled).not.toContain("Jobs &amp; Customers");
  });

  it("renders CustomerJobTrackingView with segmented tabs and filters", () => {
    const mockClient = {
      isOwnerOrAdmin: false,
      currentUserId: "member_1",
      currentUserEmail: "member@example.com",
      getWorkspaceModule: async () => null,
      collection: () => ({
        getList: async () => ({ items: [], totalPages: 1, totalItems: 0 }),
        subscribe: () => Promise.resolve(() => {}),
        unsubscribe: () => Promise.resolve(),
      }),
    } as unknown as Parameters<typeof CustomerJobTrackingView>[0]["client"];

    const html = renderToString(
      React.createElement(CustomerJobTrackingView, {
        client: mockClient,
        schemas: [],
      }),
    );

    const cleanHtml = html.replace(/<!-- -->/g, "");
    expect(cleanHtml).toContain("Customer &amp; Job Tracking");
    expect(cleanHtml).toContain("Jobs (0)");
    expect(cleanHtml).toContain("Customers (0)");
    expect(cleanHtml).toContain("+ New Job");
  });

  it("renders WorkspaceMembersModal with member list, status chips, permissions summary, and active invitations", () => {
    const mockClient = {
      isOwner: true,
      isOwnerOrAdmin: true,
      getWorkspaceUsers: async () => [],
      getWorkspaceInvitations: async () => [],
    } as unknown as Parameters<typeof WorkspaceMembersModal>[0]["client"];

    const sampleUsers = [
      {
        id: "owner_1",
        name: "Alice Owner",
        email: "owner@example.com",
        role: "owner" as const,
        disabled: false,
      },
      {
        id: "tech_1",
        name: "Tech One",
        email: "tech1@example.com",
        role: "member" as const,
        disabled: false,
        permissions: {
          customers: { read: true, create: false, update: false, delete: false, scope: "all" as const },
          jobs: { read: true, create: true, update: true, delete: false, scope: "assigned" as const },
        },
      },
      {
        id: "tech_2",
        name: "Tech Two",
        email: "tech2@example.com",
        role: "member" as const,
        disabled: true,
        permissions: {
          customers: { read: true, create: false, update: false, delete: false, scope: "all" as const },
          jobs: { read: true, create: true, update: true, delete: false, scope: "assigned" as const },
        },
      },
    ];

    const sampleInvitations = [
      {
        id: "inv_pending_1",
        email: "tech3@example.com",
        role: "member" as const,
        expires_at: "2026-12-31T23:59:59Z",
      },
    ];

    const html = renderToString(
      React.createElement(WorkspaceMembersModal, {
        client: mockClient,
        schemas: [
          { schema_id: "customers", name: "Customers", fields: [{ name: "name", type: "text" }] },
          { schema_id: "jobs", name: "Jobs", assignee_field: "assignee", fields: [{ name: "title", type: "text" }] },
        ],
        isOpen: true,
        onClose: () => {},
        initialUsers: sampleUsers,
        initialPendingInvitations: sampleInvitations,
        initialGeneratedInviteToken: "inv_tok_secret_pilot_999",
      }),
    );

    const cleanHtml = html.replace(/<!-- -->/g, "");
    expect(cleanHtml).toContain("Workspace Team &amp; Access Control");
    expect(cleanHtml).toContain("Invitation Token Ready");
    expect(cleanHtml).toContain("inv_tok_secret_pilot_999");
    expect(cleanHtml).toContain("Copy Token");

    // Owner protection
    expect(cleanHtml).toContain("Alice Owner");
    expect(cleanHtml).toContain("Full Access");
    expect(cleanHtml).toContain("Protected");

    // Member 1 active and permissions
    expect(cleanHtml).toContain("Tech One");
    expect(cleanHtml).toContain("Active");
    expect(cleanHtml).toContain("customers:");
    expect(cleanHtml).toContain("jobs:");
    expect(cleanHtml).toContain("(assigned)");

    // Member 2 disabled
    expect(cleanHtml).toContain("Tech Two");
    expect(cleanHtml).toContain("Disabled");
    expect(cleanHtml).toContain(">Enable</button>");

    // Pending invitation
    expect(cleanHtml).toContain("tech3@example.com");
    expect(cleanHtml).toContain("Reissue");
    expect(cleanHtml).toContain("Revoke");
  });

  it("renders WorkspaceMembersModal invite form with Customer & Job Tracking preset and permissions matrix", () => {
    const mockClient = {
      isOwner: true,
      isOwnerOrAdmin: true,
      getWorkspaceUsers: async () => [],
      getWorkspaceInvitations: async () => [],
    } as unknown as Parameters<typeof WorkspaceMembersModal>[0]["client"];

    const html = renderToString(
      React.createElement(WorkspaceMembersModal, {
        client: mockClient,
        schemas: [
          { schema_id: "customers", name: "Customers", fields: [{ name: "name", type: "text" }] },
          { schema_id: "jobs", name: "Jobs", assignee_field: "assignee", fields: [{ name: "title", type: "text" }] },
        ],
        isOpen: true,
        onClose: () => {},
        initialShowInviteForm: true,
      }),
    );

    const cleanHtml = html.replace(/<!-- -->/g, "");
    expect(cleanHtml).toContain("Invite New Member or Admin");
    expect(cleanHtml).toContain("Member Email");
    expect(cleanHtml).toContain("Customer &amp; Job Tracking Member Preset");
    expect(cleanHtml).toContain("Effective Access:</strong> Members with assigned scope can only view and update records assigned to their user ID.");
    expect(cleanHtml).toContain("Assignee: assignee");
  });

  it("renders AcceptInviteForm with token, name and password fields", () => {
    const mockClient = {
      config: { tenant_id: "tenant_pilot" },
      acceptInvitation: async () => ({ email: "tech1@example.com" }),
      login: async () => {},
    } as unknown as Parameters<typeof AcceptInviteForm>[0]["client"];

    const html = renderToString(
      React.createElement(AcceptInviteForm, {
        client: mockClient,
        initialToken: "inv_tok_pilot_123",
      }),
    );

    const cleanHtml = html.replace(/<!-- -->/g, "");
    expect(cleanHtml).toContain("Accept Invitation");
    expect(cleanHtml).toContain("tenant_pilot");
    expect(cleanHtml).toContain("value=\"inv_tok_pilot_123\"");
    expect(cleanHtml).toContain("Your Full Name");
    expect(cleanHtml).toContain("Password (min 8 chars)");
    expect(cleanHtml).toContain("Confirm Password");
    expect(cleanHtml).toContain("Accept &amp; Sign In");
  });

  it("CustomerJobTrackingView renders server-side search input, pagination controls and assignee picker for owners", () => {
    const mockClient = {
      isOwnerOrAdmin: true,
      currentUserId: "owner_1",
      currentUserEmail: "owner@example.com",
      getWorkspaceModule: async () => ({
        module_id: "customer_job_tracking",
        installed: true,
        enabled: true,
      }),
      getWorkspaceUsers: async () => [
        { id: "owner_1", name: "Alice Owner", email: "alice@example.com", role: "owner" },
        { id: "member_2", name: "Bob Member", email: "bob@example.com", role: "member" },
      ],
      filter: (expr: string, params: any) => `${expr} [${JSON.stringify(params)}]`,
      collection: () => ({
        getList: async () => ({ items: [], totalPages: 1, totalItems: 0 }),
        subscribe: () => Promise.resolve(() => {}),
        unsubscribe: () => Promise.resolve(),
      }),
    } as unknown as Parameters<typeof CustomerJobTrackingView>[0]["client"];

    const html = renderToString(
      React.createElement(CustomerJobTrackingView, {
        client: mockClient,
        schemas: [],
      }),
    );

    const cleanHtml = html.replace(/<!-- -->/g, "");
    expect(cleanHtml).toContain("Search jobs by titleâ€¦");
    expect(cleanHtml).toContain("Showing page 1 of 1 (0 total jobs)");
    expect(cleanHtml).toContain("Previous");
    expect(cleanHtml).toContain("Next");
    // Status filters do not render misleading partial-page counts
    expect(cleanHtml).toContain(">All</button>");
    expect(cleanHtml).toContain(">Open</button>");
    expect(cleanHtml).toContain(">In progress</button>");
    expect(cleanHtml).toContain(">Done</button>");
  });

  it("CustomerJobTrackingView omits phone input and filtering when mapping has no phone field", () => {
    const mockClient = {
      isOwnerOrAdmin: false,
      currentUserId: "member_1",
      currentUserEmail: "member@example.com",
      getWorkspaceModule: async () => ({
        module_id: "customer_job_tracking",
        installed: true,
        enabled: true,
        mapping: {
          customer_dataset: "clients",
          customer_name_field: "full_name",
          // explicitly no customer_phone_field
          job_dataset: "jobs",
          job_title_field: "title",
          job_customer_field: "customer",
          job_status_field: "status",
          job_assignee_field: "assignee",
        },
      }),
      collection: () => ({
        getList: async () => ({ items: [], totalPages: 1, totalItems: 0 }),
        subscribe: () => Promise.resolve(() => {}),
        unsubscribe: () => Promise.resolve(),
      }),
    } as unknown as Parameters<typeof CustomerJobTrackingView>[0]["client"];

    const html = renderToString(
      React.createElement(CustomerJobTrackingView, {
        client: mockClient,
        schemas: [],
        initialSegment: "customers",
      }),
    );

    const cleanHtml = html.replace(/<!-- -->/g, "");
    expect(cleanHtml).toContain('placeholder="Search customers by nameâ€¦"');
    expect(cleanHtml).not.toContain('placeholder="Search customers by name or phoneâ€¦"');
    expect(cleanHtml).not.toContain("Phone (Optional)");
  });

  it("CustomerJobTrackingView defines distinct requestKeys for independent customer list, picker, and job requests", () => {
    expect(CJT_JOBS_REQUEST_KEY).toBeDefined();
    expect(CJT_CUSTOMER_LIST_REQUEST_KEY).toBeDefined();
    expect(CJT_PICKER_REQUEST_KEY).toBeDefined();

    const keys = [CJT_JOBS_REQUEST_KEY, CJT_CUSTOMER_LIST_REQUEST_KEY, CJT_PICKER_REQUEST_KEY];
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(3);
    expect(CJT_CUSTOMER_LIST_REQUEST_KEY).not.toBe(CJT_PICKER_REQUEST_KEY);
    expect(CJT_JOBS_REQUEST_KEY).not.toBe(CJT_CUSTOMER_LIST_REQUEST_KEY);
  });

  it("isAbortError distinguishes genuine cancellations from ordinary response errors", () => {
    // PocketBase response error with isAbort: false (should NOT be treated as cancellation)
    const pb403 = { status: 403, isAbort: false, message: "Forbidden" };
    expect(isAbortError(pb403)).toBe(false);

    const pb500 = { status: 500, isAbort: false, message: "Server error" };
    expect(isAbortError(pb500)).toBe(false);

    const netErr = new Error("Network request failed");
    expect(isAbortError(netErr)).toBe(false);

    // Genuine aborts
    const pbAbort = { status: 0, isAbort: true, message: "Request cancelled" };
    expect(isAbortError(pbAbort)).toBe(true);

    const domAbort = new Error("The user aborted a request.");
    domAbort.name = "AbortError";
    expect(isAbortError(domAbort)).toBe(true);
  });

  it("CustomerJobTrackingView marks phone field as required in form when mapped phone is required", () => {
    const mockClient = {
      isOwnerOrAdmin: false,
      currentUserId: "member_1",
      currentUserEmail: "member@example.com",
      getWorkspaceModule: async () => ({
        installed: true,
        enabled: true,
        mapping: {
          customer_dataset: "customers",
          customer_name_field: "name",
          customer_phone_field: "phone",
          job_dataset: "jobs",
          job_title_field: "title",
          job_customer_field: "customer",
          job_status_field: "status",
          job_assignee_field: "assignee",
        },
      }),
      collection: () => ({
        getList: async () => ({ items: [], totalPages: 1, totalItems: 0 }),
        subscribe: () => Promise.resolve(() => {}),
        unsubscribe: () => Promise.resolve(),
      }),
    } as unknown as Parameters<typeof CustomerJobTrackingView>[0]["client"];

    const customerSchemaWithRequiredPhone: SchemaDefinition = {
      schema_id: "customers",
      name: "Customers",
      fields: [
        { name: "name", label: "Name", type: "text", required: true },
        { name: "phone", label: "Phone", type: "text", required: true },
      ],
    };

    const html = renderToString(
      React.createElement(CustomerJobTrackingView, {
        client: mockClient,
        schemas: [customerSchemaWithRequiredPhone],
        initialSegment: "customers",
        initialCustomerPhoneField: "phone",
        initialCreateCustModalOpen: true,
      }),
    );

    const cleanHtml = html.replace(/<!-- -->/g, "");
    expect(cleanHtml).toContain('<label style="font-size:0.85rem;font-weight:600">Phone</label>');
    expect(cleanHtml).not.toContain("Phone (Optional)");
    expect(cleanHtml).toContain('<input type="tel" required=""');
  });

  it("DashboardPage excludes customer_job_tracking module tab from not-found card", () => {
    const mockClient = {
      isOwnerOrAdmin: true,
      currentUserRole: "owner",
      currentUserId: "owner_1",
      currentUserEmail: "owner@example.com",
      config: {
        backend_url: "https://acme.app.example.com",
        tenant_id: "acme",
        features: [],
        collections: {},
      },
      getSchemas: async () => [],
      getPages: async () => [],
      getDisabledModules: async () => [],
      getWorkspaceModules: async () => [
        { module_id: "customer_job_tracking", installed: true, enabled: true },
      ],
      getWorkspaceModule: async () => ({
        module_id: "customer_job_tracking",
        installed: true,
        enabled: true,
      }),
      getWorkspaceUsers: async () => [],
      hasDatasetPermission: () => true,
      collection: () => ({
        getList: async () => ({ items: [], totalPages: 1, totalItems: 0 }),
        subscribe: () => Promise.resolve(() => {}),
        unsubscribe: () => Promise.resolve(),
      }),
      subscribeWorkspaceModules: () => () => {},
    } as unknown as Parameters<typeof DashboardPage>[0]["client"];

    const html = renderToString(
      React.createElement(DashboardPage, {
        client: mockClient,
        onSignOut: () => {},
      }),
    );

    expect(html).not.toContain('Page or Schema &quot;customer_job_tracking&quot; not found.');
    expect(html).not.toContain('Page or Schema "customer_job_tracking" not found.');
  });

  it("CustomerJobTrackingView renders phone workflow: job cards with status update actions and assigned display", () => {
    const mockClient = {
      isOwnerOrAdmin: false,
      currentUserId: "member_1",
      currentUserEmail: "member@example.com",
      getWorkspaceModule: async () => null,
      collection: () => ({
        getList: async () => ({ items: [], totalPages: 1, totalItems: 0 }),
        subscribe: () => Promise.resolve(() => {}),
        unsubscribe: () => Promise.resolve(),
      }),
    } as unknown as Parameters<typeof CustomerJobTrackingView>[0]["client"];

    const sampleJobs = [
      {
        id: "job_1",
        title: "Boiler Maintenance",
        status: "Open",
        customer: "cust_1",
        assignee: "member_1",
      },
    ];

    const html = renderToString(
      React.createElement(CustomerJobTrackingView, {
        client: mockClient,
        schemas: [],
        initialLoadingJobs: false,
        initialJobs: sampleJobs,
      }),
    );

    const cleanHtml = html.replace(/<!-- -->/g, "");
    expect(cleanHtml).toContain("Boiler Maintenance");
    expect(cleanHtml).toContain("Assignee: <strong>You</strong>");
    expect(cleanHtml).toContain("In progress");
    expect(cleanHtml).toContain("Done");
  });

  it("CustomerJobTrackingView renders expanded customer relation name and tel link", () => {
    const mockClient = {
      isOwnerOrAdmin: false,
      currentUserId: "member_1",
      currentUserEmail: "member@example.com",
      getWorkspaceModule: async () => null,
      collection: () => ({
        getList: async () => ({ items: [], totalPages: 1, totalItems: 0 }),
        subscribe: () => Promise.resolve(() => {}),
        unsubscribe: () => Promise.resolve(),
      }),
    } as unknown as Parameters<typeof CustomerJobTrackingView>[0]["client"];

    const sampleJobs = [
      {
        id: "job_1",
        title: "Emergency Pipe Repair",
        status: "In progress",
        customer: "cust_100",
        assignee: "member_1",
        expand: {
          customer: {
            id: "cust_100",
            name: "Apex Hospital",
            phone: "+1-555-0199",
          },
        },
      },
    ];

    const html = renderToString(
      React.createElement(CustomerJobTrackingView, {
        client: mockClient,
        schemas: [],
        initialLoadingJobs: false,
        initialJobs: sampleJobs,
        initialCustomerPhoneField: "phone",
      }),
    );

    const cleanHtml = html.replace(/<!-- -->/g, "");
    expect(cleanHtml).toContain("Emergency Pipe Repair");
    expect(cleanHtml).toContain("ðŸ‘¤ Apex Hospital");
    expect(cleanHtml).toContain('href="tel:+1-555-0199"');
    expect(cleanHtml).toContain("ðŸ“ž +1-555-0199");
  });

  it("CustomerJobTrackingView renders empty state and loading state correctly", () => {
    const mockClient = {
      isOwnerOrAdmin: false,
      currentUserId: "member_1",
      getWorkspaceModule: async () => null,
      collection: () => ({
        getList: async () => ({ items: [], totalPages: 1, totalItems: 0 }),
        subscribe: () => Promise.resolve(() => {}),
        unsubscribe: () => Promise.resolve(),
      }),
    } as unknown as Parameters<typeof CustomerJobTrackingView>[0]["client"];

    // Loading state
    const loadingHtml = renderToString(
      React.createElement(CustomerJobTrackingView, {
        client: mockClient,
        initialLoadingJobs: true,
      }),
    );
    expect(loadingHtml).toContain("Loading jobsâ€¦");

    // Empty state
    const emptyHtml = renderToString(
      React.createElement(CustomerJobTrackingView, {
        client: mockClient,
        initialLoadingJobs: false,
        initialJobs: [],
      }),
    );
    expect(emptyHtml).toContain("No jobs found.");
    expect(emptyHtml).toContain("+ Create First Job");
  });

  it("CustomerJobTrackingView renders connection and access error banners with retry action", () => {
    const mockClient = {
      isOwnerOrAdmin: false,
      currentUserId: "member_1",
      getWorkspaceModule: async () => null,
      collection: () => ({
        getList: async () => ({ items: [], totalPages: 1, totalItems: 0 }),
        subscribe: () => Promise.resolve(() => {}),
        unsubscribe: () => Promise.resolve(),
      }),
    } as unknown as Parameters<typeof CustomerJobTrackingView>[0]["client"];

    const html = renderToString(
      React.createElement(CustomerJobTrackingView, {
        client: mockClient,
        initialError: "Connection lost. Please check network connection.",
      }),
    );

    expect(html).toContain("Access Alert:");
    expect(html).toContain("Connection lost. Please check network connection.");
    expect(html).toContain("Retry");
  });

  it("CustomerJobTrackingView hides assignee dropdown for regular members in job creation modal", () => {
    const mockClient = {
      isOwnerOrAdmin: false,
      currentUserId: "member_1",
      currentUserEmail: "member1@example.com",
      getWorkspaceModule: async () => null,
      collection: () => ({
        getList: async () => ({ items: [], totalPages: 1, totalItems: 0 }),
        subscribe: () => Promise.resolve(() => {}),
        unsubscribe: () => Promise.resolve(),
      }),
    } as unknown as Parameters<typeof CustomerJobTrackingView>[0]["client"];

    const html = renderToString(
      React.createElement(CustomerJobTrackingView, {
        client: mockClient,
        initialCreateJobModalOpen: true,
      }),
    );

    const cleanHtml = html.replace(/<!-- -->/g, "");
    expect(cleanHtml).toContain("New Job");
    expect(cleanHtml).toContain("Assignee:");
    expect(cleanHtml).toContain("Automatically assigned");
    expect(cleanHtml).not.toContain('<select value="member_1">');
  });

  it("CustomerJobTrackingView renders typed controls for extra optional fields (select, bool, date, relation, number, file)", () => {
    const jobSchemaWithTypedExtras: SchemaDefinition = {
      schema_id: "jobs",
      name: "Jobs",
      assignee_field: "assignee",
      fields: [
        { name: "title", label: "Title", type: "text", required: true },
        { name: "customer", label: "Customer", type: "relation", required: true, target: "customers" },
        { name: "status", label: "Status", type: "select", required: true, options: ["Open", "In progress", "Done"] },
        { name: "assignee", label: "Assignee", type: "relation", required: true, target: "users" },
        { name: "priority", label: "Priority", type: "select", required: false, options: ["Low", "Medium", "High"] },
        { name: "urgent", label: "Is Urgent", type: "bool", required: false },
        { name: "due_date", label: "Due Date", type: "date", required: false },
        { name: "estimated_hours", label: "Estimated Hours", type: "number", required: false },
        { name: "attachment", label: "Work Order PDF", type: "file", required: false },
      ],
    };

    const mockClient = {
      isOwnerOrAdmin: false,
      currentUserId: "member_1",
      currentUserEmail: "member1@example.com",
      getWorkspaceModule: async () => null,
      collection: () => ({
        getList: async () => ({ items: [], totalPages: 1, totalItems: 0 }),
        subscribe: () => Promise.resolve(() => {}),
        unsubscribe: () => Promise.resolve(),
      }),
    } as unknown as Parameters<typeof CustomerJobTrackingView>[0]["client"];

    const html = renderToString(
      React.createElement(CustomerJobTrackingView, {
        client: mockClient,
        schemas: [jobSchemaWithTypedExtras],
        initialCreateJobModalOpen: true,
        initialJobs: [
          {
            id: "job_1",
            title: "Emergency Pipe Fix",
            customer: "cust_1",
            status: "Open",
            assignee: "member_1",
            priority: "High",
            urgent: true,
            estimated_hours: 4.5,
            attachment: "work_order_123.pdf",
          },
        ],
      }),
    );

    const cleanHtml = html.replace(/<!-- -->/g, "");
    // Check select dropdown rendered for priority
    expect(cleanHtml).toContain('id="cjt-field-priority"');
    expect(cleanHtml).toContain('<option value="High">High</option>');
    // Check checkbox rendered for urgent
    expect(cleanHtml).toContain('id="cjt-field-urgent"');
    expect(cleanHtml).toContain('type="checkbox"');
    // Check date input rendered for due_date
    expect(cleanHtml).toContain('id="cjt-field-due_date"');
    expect(cleanHtml).toContain('type="date"');
    // Check number input rendered for estimated_hours
    expect(cleanHtml).toContain('id="cjt-field-estimated_hours"');
    expect(cleanHtml).toContain('type="number"');
    // Check file input rendered for attachment
    expect(cleanHtml).toContain('id="cjt-field-attachment"');
    expect(cleanHtml).toContain('type="file"');
    // Check job card renders boolean as "Yes" and file with paperclip icon
    expect(cleanHtml).toContain("Is Urgent:</strong> Yes");
    expect(cleanHtml).toContain("Priority:</strong> High");
    expect(cleanHtml).toContain("Work Order PDF:</strong> ðŸ“Ž work_order_123.pdf");
  });

  it("clears draft values and attached files when create-job modal is cancelled/closed and reopened, preventing leaked attachments on next submission", () => {
    const extraJobFields = [
      { name: "priority", label: "Priority", type: "select" as const, required: false },
      { name: "attachment", label: "Work Order File", type: "file" as const, required: false },
    ];

    // Initial state
    let state: JobModalDraftState = {
      isOpen: false,
      title: "",
      customerId: "cust_1",
      status: "Open",
      assigneeId: "member_1",
      extraFieldValues: {},
      error: null,
      pending: false,
    };

    // 1. Member opens the modal
    state = jobModalDraftReducer(state, { type: "OPEN", customerId: "cust_1" });
    expect(state.isOpen).toBe(true);
    expect(state.title).toBe("");
    expect(state.extraFieldValues).toEqual({});

    // 2. Member enters title and selects a draft file attachment
    state = jobModalDraftReducer(state, { type: "SET_TITLE", title: "Pipe repair draft" });
    const mockFile = new File(["sample content"], "blueprint.pdf", { type: "application/pdf" });
    state = jobModalDraftReducer(state, { type: "SET_EXTRA_FIELD", fieldName: "attachment", value: mockFile });
    expect(state.title).toBe("Pipe repair draft");
    expect(state.extraFieldValues.attachment).toBe(mockFile);

    // 3. Member decides to cancel and closes the modal
    state = jobModalDraftReducer(state, { type: "CLOSE" });
    expect(state.isOpen).toBe(false);
    expect(state.title).toBe("");
    expect(state.extraFieldValues).toEqual({});
    expect(state.extraFieldValues.attachment).toBeUndefined();

    // 4. Member re-opens the modal for a different job
    state = jobModalDraftReducer(state, { type: "OPEN", customerId: "cust_1" });
    expect(state.isOpen).toBe(true);
    expect(state.title).toBe("");
    expect(state.extraFieldValues).toEqual({});
    expect(state.extraFieldValues.attachment).toBeUndefined();

    // 5. Member enters title without selecting any file attachment and submits
    state = jobModalDraftReducer(state, { type: "SET_TITLE", title: "Routine Sink Inspection" });
    const payloadWithoutAttachment = buildJobCreatePayload({
      title: state.title,
      customerId: state.customerId,
      status: state.status,
      assigneeId: state.assigneeId,
      extraJobFields,
      extraFieldValues: state.extraFieldValues,
    });

    expect(payloadWithoutAttachment.title).toBe("Routine Sink Inspection");
    expect(payloadWithoutAttachment.customer).toBe("cust_1");
    expect(payloadWithoutAttachment.status).toBe("Open");
    expect(payloadWithoutAttachment.assignee).toBe("member_1");
    // Verify crucial invariant: previously cancelled attachment is NOT present in submission payload
    expect(payloadWithoutAttachment.attachment).toBeUndefined();

    // 6. When member explicitly selects a file on submission attempt, it IS included
    state = jobModalDraftReducer(state, { type: "SET_EXTRA_FIELD", fieldName: "attachment", value: mockFile });
    const payloadWithAttachment = buildJobCreatePayload({
      title: state.title,
      customerId: state.customerId,
      status: state.status,
      assigneeId: state.assigneeId,
      extraJobFields,
      extraFieldValues: state.extraFieldValues,
    });
    expect(payloadWithAttachment.attachment).toBe(mockFile);
  });

  it("CustomerJobTrackingView renders selected file label only when file is currently attached in draft", () => {
    const jobSchemaWithAttachment: SchemaDefinition = {
      schema_id: "jobs",
      name: "Jobs",
      assignee_field: "assignee",
      fields: [
        { name: "title", label: "Title", type: "text", required: true },
        { name: "customer", label: "Customer", type: "relation", required: true, target: "customers" },
        { name: "status", label: "Status", type: "select", required: true, options: ["Open", "In progress", "Done"] },
        { name: "assignee", label: "Assignee", type: "relation", required: true, target: "users" },
        { name: "attachment", label: "Work Order File", type: "file", required: false },
      ],
    };

    const mockClient = {
      isOwnerOrAdmin: false,
      currentUserId: "member_1",
      currentUserEmail: "member1@example.com",
      getWorkspaceModule: async () => null,
      collection: () => ({
        getList: async () => ({ items: [], totalPages: 1, totalItems: 0 }),
        subscribe: () => Promise.resolve(() => {}),
        unsubscribe: () => Promise.resolve(),
      }),
    } as unknown as Parameters<typeof CustomerJobTrackingView>[0]["client"];

    const mockFile = new File(["content"], "invoice-scan.pdf", { type: "application/pdf" });

    // Render with file in draft
    const htmlWithFile = renderToString(
      React.createElement(CustomerJobTrackingView, {
        client: mockClient,
        schemas: [jobSchemaWithAttachment],
        initialCreateJobModalOpen: true,
        initialExtraFieldValues: { attachment: mockFile },
      }),
    ).replace(/<!-- -->/g, "");
    expect(htmlWithFile).toContain("Selected: invoice-scan.pdf");

    // Render fresh modal without file in draft
    const htmlWithoutFile = renderToString(
      React.createElement(CustomerJobTrackingView, {
        client: mockClient,
        schemas: [jobSchemaWithAttachment],
        initialCreateJobModalOpen: true,
      }),
    ).replace(/<!-- -->/g, "");
    expect(htmlWithoutFile).not.toContain("Selected: invoice-scan.pdf");
    expect(htmlWithoutFile).not.toContain("Selected:");
  });
});

describe("Admin Workspace: Page & Dashboard Management", () => {
  const sampleSchema: SchemaDefinition = {
    schema_id: "projects",
    name: "Projects",
    fields: [
      { name: "title", label: "Title", type: "text", required: true },
      { name: "budget", label: "Budget", type: "number" },
      { name: "status", label: "Status", type: "select", options: ["Active", "Completed"] },
    ],
  };

  const mockClient = {
    isOwnerOrAdmin: true,
    hasDatasetPermission: () => true,
    collection: () => ({
      getList: async () => ({ items: [], totalPages: 1, totalItems: 0 }),
      subscribe: () => Promise.resolve(() => {}),
      unsubscribe: () => Promise.resolve(),
    }),
  } as unknown as Parameters<typeof PageEditorModal>[0]["client"];

  it("renders PageEditorModal for creating and editing pages with publishing toggle", () => {
    // 1. Create mode
    const createHtml = renderToString(
      React.createElement(PageEditorModal, {
        isOpen: true,
        onClose: () => {},
        client: mockClient,
        schemas: [sampleSchema],
        onSave: async () => {},
      })
    );
    expect(createHtml).toContain("Create Custom Page");
    expect(createHtml).toContain("Page Name");
    expect(createHtml).toContain("Page Identifier (slug)");
    expect(createHtml).toContain("Publish Page to Workspace");
    expect(createHtml).toContain("Navigation Sort Order");

    // 2. Edit mode
    const editHtml = renderToString(
      React.createElement(PageEditorModal, {
        isOpen: true,
        onClose: () => {},
        client: mockClient,
        schemas: [sampleSchema],
        page: {
          page_id: "projects-table",
          name: "Projects Table",
          view_type: "table",
          collection: "projects",
          published: false,
          nav_order: 5,
        },
        onSave: async () => {},
        onDelete: async () => {},
      })
    );
    expect(editHtml).toContain("Edit Page: Projects Table");
    expect(editHtml).toContain("Delete Page");
  });

  it("renders DashboardEditorModal with widget configuration and preview", () => {
    const rawHtml = renderToString(
      React.createElement(DashboardEditorModal, {
        isOpen: true,
        onClose: () => {},
        client: mockClient,
        schemas: [sampleSchema],
        currentLayout: {
          id: "main",
          name: "Workspace Overview",
          layout: [
            {
              id: "w1",
              type: "kpi",
              collection: "projects",
              x: 0,
              y: 0,
              w: 4,
              h: 2,
              props: { metric: "count" },
            },
          ],
        },
        onSave: async () => {},
      })
    );
    const html = rawHtml.replace(/<!-- -->/g, "");
    expect(html).toContain("Customize Workspace Dashboard");
    expect(html).toContain("Configure Widgets (1)");
    expect(html).toContain("Preview Layout");
    expect(html).toContain("KPI Summary Card");
    expect(html).toContain("Recent Records Table");
  });

  it("DashboardEditorModal preserves draft on live updates and displays conflict resolution controls", () => {
    const initialLayout = {
      id: "main",
      name: "Workspace Overview",
      layout: [
        {
          id: "w1",
          type: "kpi" as const,
          collection: "projects",
          x: 0,
          y: 0,
          w: 4,
          h: 2,
          props: { metric: "count" },
        },
      ],
    };

    const serverUpdatedLayout = {
      id: "main",
      name: "Workspace Overview - Remote Admin Update",
      layout: [
        {
          id: "w1",
          type: "kpi" as const,
          collection: "projects",
          x: 0,
          y: 0,
          w: 6,
          h: 3,
          props: { metric: "count" },
        },
        {
          id: "w2",
          type: "table" as const,
          collection: "projects",
          x: 6,
          y: 0,
          w: 6,
          h: 4,
          props: { limit: 5 },
        },
      ],
    };

    // 1. Reducer test: Not dirty -> incoming update seamlessly replaces layout
    let state: DashboardEditorDraftState = dashboardEditorDraftReducer(
      {
        baselineLayout: initialLayout,
        layoutName: "Workspace Overview",
        widgets: initialLayout.layout,
        incomingConflict: null,
      },
      { type: "INCOMING_LAYOUT_UPDATE", incomingLayout: serverUpdatedLayout }
    );
    expect(state.incomingConflict).toBeNull();
    expect(state.layoutName).toBe("Workspace Overview - Remote Admin Update");
    expect(state.widgets.length).toBe(2);

    // 2. Reducer test: Dirty draft -> incoming update triggers conflict and preserves user's draft
    state = dashboardEditorDraftReducer(state, { type: "SET_NAME", name: "My Unsaved Custom Dashboard" });
    expect(isDashboardDraftDirty(state.baselineLayout, state.layoutName, state.widgets)).toBe(true);

    const concurrentServerLayout = {
      id: "main",
      name: "Third Party Saved Layout",
      layout: [],
    };
    state = dashboardEditorDraftReducer(state, {
      type: "INCOMING_LAYOUT_UPDATE",
      incomingLayout: concurrentServerLayout,
    });
    // Draft name and widgets remain untouched
    expect(state.layoutName).toBe("My Unsaved Custom Dashboard");
    expect(state.widgets.length).toBe(2);
    // Conflict is recorded
    expect(state.incomingConflict).toEqual(concurrentServerLayout);

    // 3. Reducer test: Keep My Draft updates baseline to acknowledged server version without changing user's draft
    const keptState = dashboardEditorDraftReducer(state, { type: "RESOLVE_KEEP_DRAFT" });
    expect(keptState.incomingConflict).toBeNull();
    expect(keptState.layoutName).toBe("My Unsaved Custom Dashboard");
    expect(keptState.baselineLayout).toEqual(concurrentServerLayout);

    // Later edits with the same server layout active do NOT re-trigger the conflict
    const stateEditedAfterKeep = dashboardEditorDraftReducer(keptState, {
      type: "SET_NAME",
      name: "My Unsaved Custom Dashboard - Later Modification",
    });
    const stateReevaluated = dashboardEditorDraftReducer(stateEditedAfterKeep, {
      type: "INCOMING_LAYOUT_UPDATE",
      incomingLayout: concurrentServerLayout,
    });
    expect(stateReevaluated.incomingConflict).toBeNull();

    // A subsequent, different remote layout arriving later DOES trigger a new conflict
    const newerServerLayout = {
      id: "main",
      name: "Fourth Version Remote",
      layout: [],
    };
    const stateSubsequentConflict = dashboardEditorDraftReducer(stateReevaluated, {
      type: "INCOMING_LAYOUT_UPDATE",
      incomingLayout: newerServerLayout,
    });
    expect(stateSubsequentConflict.incomingConflict).toEqual(newerServerLayout);

    // 4. Reducer test: Load Server Version overwrites with incoming layout
    const loadedState = dashboardEditorDraftReducer(state, { type: "RESOLVE_LOAD_SERVER" });
    expect(loadedState.incomingConflict).toBeNull();
    expect(loadedState.layoutName).toBe("Third Party Saved Layout");
    expect(loadedState.widgets.length).toBe(0);

    // 5. Component render test: Render modal when incomingConflict is active
    const conflictHtml = renderToString(
      React.createElement(DashboardEditorModal, {
        isOpen: true,
        onClose: () => {},
        client: mockClient,
        schemas: [sampleSchema],
        currentLayout: initialLayout,
        initialIncomingConflict: concurrentServerLayout,
        onSave: async () => {},
      })
    ).replace(/<!-- -->/g, "");

    expect(conflictHtml).toContain("Live Update Detected:");
    expect(conflictHtml).toContain("Another session saved changes to this dashboard layout. Your current draft is preserved.");
    expect(conflictHtml).toContain("Load Server Version");
    expect(conflictHtml).toContain("Keep My Draft");
    expect(conflictHtml).toContain("Resolve live update above before saving.");
    expect(conflictHtml).toMatch(/<button[^>]*disabled[^>]*>Save &amp; Publish Dashboard<\/button>/);
  });

  it("DashboardEditorModal passes expectedRevision on save and handles 409 conflict gracefully", async () => {
    let passedOptions: { expectedRevision?: number } | undefined;
    const savePromise = async (_layout: DashboardLayout, options?: { expectedRevision?: number }) => {
      passedOptions = options;
      const err = new Error("Conflict detected");
      (err as any).status = 409;
      throw err;
    };

    const initialLayout: DashboardLayout = {
      id: "main",
      name: "Initial Dashboard",
      layout: [],
    };

    const html = renderToString(
      React.createElement(DashboardEditorModal, {
        isOpen: true,
        onClose: () => {},
        client: mockClient,
        schemas: [sampleSchema],
        currentLayout: initialLayout,
        currentRevision: 3,
        onSave: savePromise,
      })
    ).replace(/<!-- -->/g, "");

    expect(html).toContain("Customize Workspace Dashboard");
    expect(html).toContain("Initial Dashboard");
  });

  it("DashboardEditorModal resolves realtime conflict using incoming revision directly without spurious increment", async () => {
    let savedExpectedRevision: number | undefined;
    const savePromise = async (_layout: DashboardLayout, options?: { expectedRevision?: number }) => {
      savedExpectedRevision = options?.expectedRevision;
    };

    const initialLayout: DashboardLayout = {
      id: "main",
      name: "My Unsaved Local Draft",
      layout: [
        {
          id: "w1",
          type: "table" as const,
          collection: "orders",
          x: 0,
          y: 0,
          w: 6,
          h: 4,
          props: {},
        },
      ],
    };

    const concurrentServerLayout: DashboardLayout = {
      id: "main",
      name: "Remote Concurrent Layout",
      layout: [],
    };

    // Render modal with an initial incoming conflict carrying revision 2
    const htmlWithConflict = renderToString(
      React.createElement(DashboardEditorModal, {
        isOpen: true,
        onClose: () => {},
        client: mockClient,
        schemas: [sampleSchema],
        currentLayout: initialLayout,
        currentRevision: 1, // original baseline was 1
        initialIncomingConflict: {
          layout: concurrentServerLayout,
          revision: 2, // server advanced to revision 2
        },
        onSave: savePromise,
      })
    ).replace(/<!-- -->/g, "");

    expect(htmlWithConflict).toContain("Live Update Detected:");
    expect(htmlWithConflict).toContain("Keep My Draft");
    expect(htmlWithConflict).toContain("Load Server Version");
  });

  it("SchemaNavigation displays draft badges for unpublished pages and New Page action for admins", () => {
    const publishedPage: PageDefinition = {
      page_id: "p1",
      name: "Public Page",
      view_type: "table",
      collection: "projects",
      published: true,
    };
    const draftPage: PageDefinition = {
      page_id: "p2",
      name: "Draft Board",
      view_type: "kanban",
      collection: "projects",
      published: false,
    };

    const html = renderToString(
      React.createElement(SchemaNavigation, {
        pages: [publishedPage, draftPage],
        schemas: [sampleSchema],
        activeTab: "p1",
        onSelectTab: () => {},
        canCreatePage: true,
        onCreatePageClick: () => {},
        canCreateSchema: true,
        onCreateSchemaClick: () => {},
      })
    );
    expect(html).toContain("Public Page");
    expect(html).toContain("Draft Board");
    expect(html).toContain("Draft");
    expect(html).toContain("New Page");
    expect(html).toContain("New Dataset");
  });

  it("SchemaView provides confirmed dataset deletion with dependent page warnings", () => {
    const dependentPage: PageDefinition = {
      page_id: "proj-page",
      name: "Project Tracker",
      view_type: "table",
      collection: "projects",
    };

    const html = renderToString(
      React.createElement(SchemaView, {
        client: mockClient,
        schema: sampleSchema,
        schemas: [sampleSchema],
        pages: [dependentPage],
        onDeleteSchema: async () => {},
      })
    );
    expect(html).toContain("Delete Dataset");
  });

  it("FileCell renders actionable file download trigger with filename and download icon", () => {
    let tokenRequested = false;
    let urlBuilt = false;
    const mockFileClient = {
      pb: {
        files: {
          getToken: async () => {
            tokenRequested = true;
            return "mock_file_token_xyz";
          },
          getURL: (record: Record<string, unknown>, filename: string, options?: { token?: string }) => {
            urlBuilt = true;
            expect(options?.token).toBe("mock_file_token_xyz");
            return `/api/files/projects/${record.id}/${filename}?token=${options?.token}`;
          },
        },
      },
    } as unknown as Parameters<typeof FileCell>[0]["client"];

    const html = renderToString(
      React.createElement(FileCell, {
        client: mockFileClient,
        record: { id: "rec_123", collectionName: "projects" },
        filename: "spec_sheet.pdf",
      })
    );

    expect(html).toContain("spec_sheet.pdf");
    expect(html).toContain("lattice-file-download-btn");
    expect(html).toContain("â¬‡");
  });
});
