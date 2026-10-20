import { useCallback, useEffect, useState } from "react";
import type { PageDefinition, SchemaDefinition } from "@lattice/types";
import type { ProductClient } from "@lattice/sdk";
import { loadDashboardLayout, type LoadedLayout } from "./dashboardLoader";
import { Dashboard } from "./Dashboard";
import { SchemaNavigation } from "./SchemaNavigation";
import { SchemaView } from "./SchemaView";
import { DynamicPageView } from "./DynamicPageView";

interface DashboardPageProps {
  client: ProductClient;
  onSignOut: () => void;
  /** Present only when the app lets people switch workspace (desktop, mobile). */
  onChangeWorkspace?: () => void;
}

export function DashboardPage({ client, onSignOut, onChangeWorkspace }: DashboardPageProps) {
  const [loaded, setLoaded] = useState<LoadedLayout | null>(null);
  const [pages, setPages] = useState<PageDefinition[]>([]);
  const [schemas, setSchemas] = useState<SchemaDefinition[]>([]);
  const [activeTab, setActiveTab] = useState<string>("dashboard");
  const [loadingInitial, setLoadingInitial] = useState(true);

  const fetchSchemas = useCallback(async () => {
    try {
      const list = await client.getSchemas();
      setSchemas(list);
    } catch {
      // Fallback gracefully if schemas endpoint unavailable or offline
    }
  }, [client]);

  const fetchPages = useCallback(async () => {
    try {
      const list = await client.getPages();
      setPages(list);
    } catch {
      // Fallback gracefully if app_pages collection does not exist or user offline
    }
  }, [client]);

  useEffect(() => {
    let ignore = false;
    loadDashboardLayout(client, client.config.collections).then((result) => {
      if (!ignore) setLoaded(result);
    });

    Promise.all([fetchSchemas(), fetchPages()]).finally(() => {
      if (!ignore) setLoadingInitial(false);
    });

    // Subscribe to realtime updates on app_pages collection
    let unsubscribed = false;
    client
      .collection("app_pages")
      .subscribe("*", () => {
        if (!unsubscribed) {
          fetchPages();
        }
      })
      .catch(() => {});

    return () => {
      ignore = true;
      unsubscribed = true;
      try {
        client.collection("app_pages").unsubscribe("*").catch(() => {});
      } catch {}
    };
  }, [client, fetchSchemas, fetchPages]);

  const selectedPage = pages.find((p) => p.page_id === activeTab);
  const selectedSchema = schemas.find((s) => s.schema_id === activeTab);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <strong>{client.config.tenant_id}</strong>
          {client.config.features.map((feature) => (
            <span key={feature} className="app-chip">
              {feature}
            </span>
          ))}
        </div>
        <div className="app-actions">
          {onChangeWorkspace && (
            <button type="button" className="app-link" onClick={onChangeWorkspace}>
              Change workspace
            </button>
          )}
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <SchemaNavigation
        pages={pages}
        schemas={schemas}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
      />

      <main style={{ marginTop: "1.5rem" }}>
        {activeTab === "dashboard" && (
          <>
            {!loaded && <p className="yp-muted">Loading dashboard…</p>}
            {loaded?.warning && (
              <p className="app-notice" role="status">
                {loaded.warning}
              </p>
            )}
            {loaded && <Dashboard client={client} layout={loaded.layout} />}
          </>
        )}

        {activeTab !== "dashboard" && selectedPage && (
          <DynamicPageView client={client} page={selectedPage} schemas={schemas} />
        )}

        {activeTab !== "dashboard" && !selectedPage && selectedSchema && (
          <SchemaView client={client} schema={selectedSchema} />
        )}

        {activeTab !== "dashboard" && !selectedPage && !selectedSchema && !loadingInitial && (
          <div className="lattice-empty-card">
            <p className="yp-muted">Page or Schema "{activeTab}" not found.</p>
            <button
              type="button"
              className="lattice-btn-secondary"
              style={{ marginTop: "1rem" }}
              onClick={() => setActiveTab("dashboard")}
            >
              Back to Dashboard
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
