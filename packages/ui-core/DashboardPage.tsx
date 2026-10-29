import { useCallback, useEffect, useState } from "react";
import type { PageDefinition, SchemaDefinition } from "@lattice/types";
import type { ProductClient } from "@lattice/sdk";
import { loadDashboardLayout, type LoadedLayout } from "./dashboardLoader";
import { Dashboard } from "./Dashboard";
import { SchemaNavigation } from "./SchemaNavigation";
import { SchemaView } from "./SchemaView";
import { DynamicPageView } from "./DynamicPageView";
import { CreateSchemaModal } from "./CreateSchemaModal";
import { WorkspaceMembersModal } from "./WorkspaceMembersModal";
import { WorkspaceModulesModal } from "./WorkspaceModulesModal";

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
  const [disabledModules, setDisabledModules] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<string>("dashboard");
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [createSchemaModalOpen, setCreateSchemaModalOpen] = useState(false);
  const [membersModalOpen, setMembersModalOpen] = useState(false);
  const [modulesModalOpen, setModulesModalOpen] = useState(false);

  const fetchSchemas = useCallback(async () => {
    try {
      const list = await client.getSchemas();
      setSchemas(list);
    } catch {
      // Fallback gracefully if schemas endpoint unavailable or offline
    }
  }, [client]);

  const handleSchemaUpdated = useCallback(
    (updated: SchemaDefinition) => {
      setSchemas((prev) =>
        prev.map((s) => (s.schema_id === updated.schema_id ? updated : s)),
      );
      void fetchSchemas();
    },
    [fetchSchemas],
  );

  const fetchPages = useCallback(async () => {
    try {
      const list = await client.getPages();
      setPages(list);
    } catch {
      // Fallback gracefully if app_pages collection does not exist or user offline
    }
  }, [client]);

  const fetchDisabledModules = useCallback(async () => {
    try {
      const list = await client.getDisabledModules();
      setDisabledModules(list);
    } catch {
      // Fallback gracefully if offline
    }
  }, [client]);

  useEffect(() => {
    let ignore = false;
    loadDashboardLayout(client, client.config.collections).then((result) => {
      if (!ignore) setLoaded(result);
    });

    Promise.all([fetchSchemas(), fetchPages(), fetchDisabledModules()]).finally(() => {
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
  }, [client, fetchSchemas, fetchPages, fetchDisabledModules]);

  const isOwnerOrAdmin = client.isOwnerOrAdmin;
  const isDashboardEnabled = !disabledModules.includes("dashboard");

  const baseSchemas = isOwnerOrAdmin
    ? schemas
    : schemas.filter((s) => client.hasDatasetPermission(s.schema_id, "read"));
  const visibleSchemas = baseSchemas.filter((s) => !disabledModules.includes(s.schema_id));

  const basePages = isOwnerOrAdmin
    ? pages
    : pages.filter((p) => client.hasDatasetPermission(p.collection, "read"));
  const visiblePages = basePages.filter((p) => {
    if (disabledModules.includes(p.collection)) return false;
    if (disabledModules.includes(`page_${p.page_id}`)) return false;
    return true;
  });

  // If the active tab points to a disabled module, fall back to another visible tab
  useEffect(() => {
    if (activeTab === "dashboard" && !isDashboardEnabled) {
      const firstSchema = visibleSchemas[0]?.schema_id;
      const firstPage = visiblePages[0]?.page_id;
      if (firstSchema) setActiveTab(firstSchema);
      else if (firstPage) setActiveTab(firstPage);
    }
  }, [activeTab, isDashboardEnabled, visibleSchemas, visiblePages]);

  const selectedPage = visiblePages.find((p) => p.page_id === activeTab);
  const selectedSchema = visibleSchemas.find((s) => s.schema_id === activeTab);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <strong>{client.config.tenant_id}</strong>
          <span className={`lattice-role-chip lattice-role-chip--${client.currentUserRole || "member"}`} style={{ marginLeft: "0.5rem" }}>
            {(client.currentUserRole || "member").toUpperCase()}
          </span>
          {client.config.features.map((feature) => (
            <span key={feature} className="app-chip">
              {feature}
            </span>
          ))}
        </div>
        <div className="app-actions">
          {isOwnerOrAdmin && (
            <>
              <button type="button" className="lattice-btn-secondary" onClick={() => setModulesModalOpen(true)}>
                Modules
              </button>
              <button type="button" className="lattice-btn-secondary" onClick={() => setMembersModalOpen(true)}>
                Manage Team
              </button>
            </>
          )}
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
        pages={visiblePages}
        schemas={visibleSchemas}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        canCreateSchema={isOwnerOrAdmin}
        onCreateSchemaClick={() => setCreateSchemaModalOpen(true)}
        showDashboard={isDashboardEnabled}
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
            {isOwnerOrAdmin && schemas.length === 0 && (
              <div className="lattice-empty-card" style={{ marginTop: "1rem" }}>
                <h3>Welcome to your workspace!</h3>
                <p className="yp-muted">Start by defining your business datasets (schemas) for your team.</p>
                <button
                  type="button"
                  className="lattice-btn-primary"
                  style={{ marginTop: "0.75rem" }}
                  onClick={() => setCreateSchemaModalOpen(true)}
                >
                  ➕ Create First Dataset
                </button>
              </div>
            )}
          </>
        )}

        {activeTab !== "dashboard" && selectedPage && (
          <DynamicPageView client={client} page={selectedPage} schemas={schemas} />
        )}

        {activeTab !== "dashboard" && !selectedPage && selectedSchema && (
          <SchemaView
            client={client}
            schema={selectedSchema}
            schemas={schemas}
            onSchemaUpdated={handleSchemaUpdated}
          />
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

      <CreateSchemaModal
        isOpen={createSchemaModalOpen}
        onClose={() => setCreateSchemaModalOpen(false)}
        schemas={schemas}
        onCreate={async (def) => {
          await client.createSchema(def);
          setCreateSchemaModalOpen(false);
          await fetchSchemas();
          setActiveTab(def.schema_id);
        }}
      />

      <WorkspaceMembersModal
        isOpen={membersModalOpen}
        onClose={() => setMembersModalOpen(false)}
        client={client}
        schemas={schemas}
      />

      <WorkspaceModulesModal
        isOpen={modulesModalOpen}
        onClose={() => setModulesModalOpen(false)}
        client={client}
        schemas={schemas}
        pages={pages}
        onModulesChanged={fetchDisabledModules}
      />
    </div>
  );
}
