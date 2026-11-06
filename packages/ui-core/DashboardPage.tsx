import { useCallback, useEffect, useState } from "react";
import type { DashboardLayout, PageDefinition, SchemaDefinition } from "@lattice/types";
import type { ProductClient } from "@lattice/sdk";
import { loadDashboardLayout, type LoadedLayout } from "./dashboardLoader";
import { Dashboard } from "./Dashboard";
import { SchemaNavigation } from "./SchemaNavigation";
import { SchemaView } from "./SchemaView";
import { DynamicPageView } from "./DynamicPageView";
import { CreateSchemaModal } from "./CreateSchemaModal";
import { WorkspaceMembersModal } from "./WorkspaceMembersModal";
import { WorkspaceModulesModal } from "./WorkspaceModulesModal";
import { CustomerJobTrackingView } from "./CustomerJobTrackingView";
import { PageEditorModal } from "./PageEditorModal";
import { DashboardEditorModal } from "./DashboardEditorModal";

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
  const [managedModules, setManagedModules] = useState<
    Array<{ module_id: string; installed: boolean; enabled: boolean }>
  >([]);
  const [activeTab, setActiveTab] = useState<string>("dashboard");
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [createSchemaModalOpen, setCreateSchemaModalOpen] = useState(false);
  const [membersModalOpen, setMembersModalOpen] = useState(false);
  const [modulesModalOpen, setModulesModalOpen] = useState(false);
  const [pageEditorOpen, setPageEditorOpen] = useState(false);
  const [editingPage, setEditingPage] = useState<PageDefinition | null>(null);
  const [dashboardEditorOpen, setDashboardEditorOpen] = useState(false);

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

  const handleSavePage = useCallback(
    async (pageDef: PageDefinition) => {
      const existing = pages.find((p) => p.page_id === pageDef.page_id);
      if (existing) {
        await client.updatePage(pageDef.page_id, pageDef);
      } else {
        await client.createPage(pageDef);
      }
      await fetchPages();
      setActiveTab(pageDef.page_id);
    },
    [client, pages, fetchPages]
  );

  const handleDeletePage = useCallback(
    async (pageId: string) => {
      await client.deletePage(pageId);
      await fetchPages();
      setActiveTab("dashboard");
    },
    [client, fetchPages]
  );

  const handleDeleteSchema = useCallback(
    async (schemaId: string) => {
      await client.deleteSchema(schemaId);
      await fetchSchemas();
      await fetchPages();
      setActiveTab("dashboard");
    },
    [client, fetchSchemas, fetchPages]
  );

  const handleSaveDashboard = useCallback(
    async (layout: DashboardLayout, options?: { expectedRevision?: number }) => {
      const saved = await client.saveDashboardLayout(layout, "main", options);
      setLoaded({ layout: saved, source: "saved", revision: saved.revision });
    },
    [client]
  );

  const fetchDisabledModules = useCallback(async () => {
    try {
      const list = await client.getDisabledModules();
      setDisabledModules(list);
    } catch {
      // Fallback gracefully if offline
    }
  }, [client]);

  const fetchWorkspaceModules = useCallback(async () => {
    try {
      if (typeof client.getWorkspaceModules === "function") {
        const list = await client.getWorkspaceModules();
        setManagedModules(list);
      } else {
        console.warn("[DashboardPage] client.getWorkspaceModules is NOT a function");
      }
    } catch (err) {
      console.error("[DashboardPage] fetchWorkspaceModules error:", err);
    }
  }, [client]);

  useEffect(() => {
    let ignore = false;
    loadDashboardLayout(client, client.config.collections).then((result) => {
      if (!ignore) setLoaded(result);
    });

    Promise.all([fetchSchemas(), fetchPages(), fetchDisabledModules(), fetchWorkspaceModules()]).finally(() => {
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

    // Subscribe to realtime updates on dashboards collection for multi-session sync
    client
      .collection("dashboards")
      .subscribe("*", () => {
        if (!unsubscribed) {
          loadDashboardLayout(client, client.config.collections).then((result) => {
            if (!unsubscribed) {
              setLoaded(result);
            }
          });
        }
      })
      .catch(() => {});

    // Subscribe to realtime updates on workspace modules
    const unsubModules = client.subscribeWorkspaceModules(() => {
      if (!unsubscribed) {
        fetchWorkspaceModules();
        fetchDisabledModules();
      }
    });

    return () => {
      ignore = true;
      unsubscribed = true;
      try {
        client.collection("app_pages").unsubscribe("*").catch(() => {});
      } catch {}
      try {
        client.collection("dashboards").unsubscribe("*").catch(() => {});
      } catch {}
      unsubModules();
    };
  }, [client, fetchSchemas, fetchPages, fetchDisabledModules, fetchWorkspaceModules]);

  // Re-fetch schema definitions on tab navigation so updated fields/forms synchronize across clients
  useEffect(() => {
    if (!loadingInitial) {
      void fetchSchemas();
    }
  }, [activeTab, fetchSchemas, loadingInitial]);

  const isOwnerOrAdmin = client.isOwnerOrAdmin;
  const isDashboardEnabled = !disabledModules.includes("dashboard");
  const cjtMod = managedModules.find((m) => m.module_id === "customer_job_tracking");
  const isCustomerJobTrackingEnabled = Boolean(cjtMod?.installed && cjtMod?.enabled);


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
    if (loadingInitial) return;
    if (activeTab === "dashboard" && !isDashboardEnabled) {
      if (isCustomerJobTrackingEnabled) setActiveTab("customer_job_tracking");
      else {
        const firstSchema = visibleSchemas[0]?.schema_id;
        const firstPage = visiblePages[0]?.page_id;
        if (firstSchema) setActiveTab(firstSchema);
        else if (firstPage) setActiveTab(firstPage);
      }
    } else if (activeTab === "customer_job_tracking" && !isCustomerJobTrackingEnabled) {
      if (isDashboardEnabled) setActiveTab("dashboard");
      else {
        const firstSchema = visibleSchemas[0]?.schema_id;
        const firstPage = visiblePages[0]?.page_id;
        if (firstSchema) setActiveTab(firstSchema);
        else if (firstPage) setActiveTab(firstPage);
      }
    }
  }, [activeTab, isDashboardEnabled, isCustomerJobTrackingEnabled, visibleSchemas, visiblePages, loadingInitial]);

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
              <button
                type="button"
                className="lattice-btn-secondary"
                onClick={() => {
                  fetchSchemas();
                  setMembersModalOpen(true);
                }}
              >
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
        canCreatePage={isOwnerOrAdmin}
        onCreatePageClick={() => {
          setEditingPage(null);
          setPageEditorOpen(true);
        }}
        showDashboard={isDashboardEnabled}
        showCustomerJobTracking={isCustomerJobTrackingEnabled}
      />

      <main style={{ marginTop: "1.5rem" }}>
        {activeTab === "customer_job_tracking" && (
          <CustomerJobTrackingView client={client} schemas={schemas} />
        )}

        {activeTab === "dashboard" && (
          <>
            {isOwnerOrAdmin && loaded && (
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.75rem" }}>
                <button
                  type="button"
                  className="lattice-btn-secondary"
                  onClick={() => setDashboardEditorOpen(true)}
                >
                  ⚙️ Customize Dashboard
                </button>
              </div>
            )}
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

        {activeTab !== "dashboard" && activeTab !== "customer_job_tracking" && selectedPage && (
          <DynamicPageView
            client={client}
            page={selectedPage}
            schemas={schemas}
            onEditPage={(p) => {
              setEditingPage(p);
              setPageEditorOpen(true);
            }}
          />
        )}

        {activeTab !== "dashboard" && activeTab !== "customer_job_tracking" && !selectedPage && selectedSchema && (
          <SchemaView
            client={client}
            schema={selectedSchema}
            schemas={schemas}
            pages={pages}
            onSchemaUpdated={handleSchemaUpdated}
            onDeleteSchema={handleDeleteSchema}
          />
        )}

        {activeTab !== "dashboard" && activeTab !== "customer_job_tracking" && !selectedPage && !selectedSchema && !loadingInitial && (
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

      <PageEditorModal
        isOpen={pageEditorOpen}
        onClose={() => {
          setPageEditorOpen(false);
          setEditingPage(null);
        }}
        client={client}
        schemas={schemas}
        page={editingPage}
        onSave={handleSavePage}
        onDelete={handleDeletePage}
      />

      <DashboardEditorModal
        isOpen={dashboardEditorOpen}
        onClose={() => setDashboardEditorOpen(false)}
        client={client}
        schemas={schemas}
        currentLayout={loaded?.layout || { id: "main", name: "Workspace Overview", layout: [] }}
        currentRevision={loaded?.source === "saved" ? (loaded?.revision ?? 1) : 0}
        dashboardName="main"
        onSave={handleSaveDashboard}
      />

      <WorkspaceMembersModal
        isOpen={membersModalOpen}
        onClose={() => setMembersModalOpen(false)}
        client={client}
        schemas={schemas}
      />

      <WorkspaceModulesModal
        isOpen={modulesModalOpen}
        onClose={() => {
          setModulesModalOpen(false);
          fetchDisabledModules();
          fetchWorkspaceModules();
          fetchSchemas();
        }}
        client={client}
        schemas={schemas}
        pages={pages}
        onModulesChanged={() => {
          fetchDisabledModules();
          fetchWorkspaceModules();
          fetchSchemas();
        }}
      />
    </div>
  );
}
