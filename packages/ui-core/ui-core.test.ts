import { describe, expect, it } from "vitest";
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
  ContractError,
  buildListOptions,
  perPageFor,
  ProductClient,
  type DataClient,
} from "./index";
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
    expect(rowLabel({})).toBe("—");
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

describe("ProductClient re-export", () => {
  it("exposes ProductClient from @lattice/ui-core", () => {
    expect(ProductClient).toBeDefined();
    expect(typeof ProductClient.connect).toBe("function");
  });
});
