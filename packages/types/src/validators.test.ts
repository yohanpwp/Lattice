import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ContractError,
  assertAppConfig,
  assertDashboardLayout,
  assertEventEnvelope,
  assertFeatures,
  assertPluginManifest,
} from "./index";

const validConfig = {
  version: 1,
  tenant_id: "tenant_dev",
  backend_url: "https://acme.app.example.com",
  realtime_url: "https://acme.app.example.com/api/realtime",
  app_key: "pk_dev_000000",
  schema_version: "20260101_01",
  min_client_version: "0.1.0",
  features: ["payments"],
  collections: ["orders"],
};

describe("shared TypeScript and Go contract fixtures", () => {
  const cases = [
    ["app-config", assertAppConfig],
    ["features", assertFeatures],
    ["dashboard-layout", assertDashboardLayout],
    ["plugin-manifest", assertPluginManifest],
    ["event-envelope", assertEventEnvelope],
  ] as const;

  for (const [schema, validate] of cases) {
    for (const kind of ["valid", "invalid"] as const) {
      const dir = new URL(`../../../fixtures/contracts/${kind}/`, import.meta.url);
      const fixtures = readdirSync(dir).filter((name) => name === `${schema}.json` || name.startsWith(`${schema}-`));
      for (const fixture of fixtures) {
        it(`${kind} ${schema} fixture ${fixture} matches the shared contract`, () => {
          const value = JSON.parse(readFileSync(new URL(fixture, dir), "utf8"));
          if (kind === "valid") expect(() => validate(value)).not.toThrow();
          else expect(() => validate(value)).toThrow(ContractError);
        });
      }
    }
  }
});

describe("AppConfig", () => {
  it("accepts a valid config", () => {
    expect(assertAppConfig(validConfig).tenant_id).toBe("tenant_dev");
  });

  it("rejects missing and unknown fields", () => {
    const { tenant_id: _omit, ...missing } = validConfig;
    expect(() => assertAppConfig(missing)).toThrow(ContractError);
    expect(() => assertAppConfig({ ...validConfig, secret: "x" })).toThrow(ContractError);
  });

  it("rejects non-http URLs and bad versions", () => {
    expect(() => assertAppConfig({ ...validConfig, backend_url: "ftp://x" })).toThrow();
    expect(() => assertAppConfig({ ...validConfig, min_client_version: "1.0" })).toThrow();
  });

  it("matches the backend example tenant config (cross-layer contract test)", () => {
    const raw = readFileSync(new URL("../../../backend/tenant.example.json", import.meta.url), "utf8");
    expect(() => assertAppConfig(JSON.parse(raw))).not.toThrow();
  });
});

describe("DashboardLayout", () => {
  const layout = {
    id: "main",
    name: "Main",
    layout: [
      {
        id: "w1",
        type: "kpi",
        collection: "orders",
        x: 0,
        y: 0,
        w: 4,
        h: 2,
        props: { metric: "sum:total", filter: "author = {:me}", params: { me: "abc" } },
      },
    ],
  };

  it("accepts a valid layout", () => {
    expect(assertDashboardLayout(layout).layout).toHaveLength(1);
  });

  it("rejects props outside the whitelist", () => {
    const bad = structuredClone(layout);
    (bad.layout[0]!.props as Record<string, unknown>).evil = "1";
    expect(() => assertDashboardLayout(bad)).toThrow(ContractError);
  });

  it("rejects injection-looking sort/field values and unknown widget types", () => {
    const badSort = structuredClone(layout);
    badSort.layout[0]!.props = { sort: "-created; drop" } as never;
    expect(() => assertDashboardLayout(badSort)).toThrow();

    const badType = structuredClone(layout);
    badType.layout[0]!.type = "iframe";
    expect(() => assertDashboardLayout(badType)).toThrow();
  });
});

describe("Features, PluginManifest, EventEnvelope", () => {
  it("validates features", () => {
    expect(() =>
      assertFeatures({ features: { payments: { enabled: true, options: { default_provider: "omise" } } } }),
    ).not.toThrow();
    expect(() => assertFeatures({ features: { payments: {} } })).toThrow();
  });

  it("validates plugin manifests", () => {
    const manifest = {
      name: "payments",
      version: "0.1.0",
      interface_version: 1,
      license: "Proprietary",
      requires: ["outbox"],
      permissions: ["collections:payment_ledger", "events:emit"],
    };
    expect(() => assertPluginManifest(manifest)).not.toThrow();
    expect(() => assertPluginManifest({ ...manifest, interface_version: 0 })).toThrow();
    expect(() => assertPluginManifest({ ...manifest, name: "Payments!" })).toThrow();
  });

  it("validates event envelopes", () => {
    const evt = {
      id: "evt_1",
      type: "payment.succeeded",
      version: 1,
      occurred_at: "2026-10-02T10:00:00Z",
      tenant_id: "tenant_dev",
      data: { order_id: "o1" },
    };
    expect(() => assertEventEnvelope(evt)).not.toThrow();
    expect(() => assertEventEnvelope({ ...evt, version: 0 })).toThrow();
  });
});
