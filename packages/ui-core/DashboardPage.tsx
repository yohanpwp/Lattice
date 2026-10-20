import { useCallback, useEffect, useState } from "react";
import type { SchemaDefinition } from "@lattice/types";
import type { ProductClient } from "@lattice/sdk";
import { loadDashboardLayout, type LoadedLayout } from "./dashboardLoader";
import { Dashboard } from "./Dashboard";
import { SchemaNavigation } from "./SchemaNavigation";
import { SchemaView } from "./SchemaView";
import { CreateSchemaModal } from "./CreateSchemaModal";

interface DashboardPageProps {
  client: ProductClient;
  onSignOut: () => void;
  /** Present only when the app lets people switch workspace (desktop, mobile). */
  onChangeWorkspace?: () => void;
}

export function DashboardPage({ client, onSignOut, onChangeWorkspace }: DashboardPageProps) {
  const [loaded, setLoaded] = useState<LoadedLayout | null>(null);
  const [schemas, setSchemas] = useState<SchemaDefinition[]>([]);
  const [activeTab, setActiveTab] = useState<string>("dashboard");
  const [createSchemaModalOpen, setCreateSchemaModalOpen] = useState(false);
  const [loadingSchemas, setLoadingSchemas] = useState(true);

  const fetchSchemas = useCallback(async () => {
    try {
      const list = await client.getSchemas();
      setSchemas(list);
    } catch {
      // Fallback gracefully if schemas endpoint unavailable or offline
    } finally {
      setLoadingSchemas(false);
    }
  }, [client]);

  useEffect(() => {
    let ignore = false;
    loadDashboardLayout(client, client.config.collections).then((result) => {
      if (!ignore) setLoaded(result);
    });
    fetchSchemas();

    return () => {
      ignore = true;
    };
  }, [client, fetchSchemas]);

  async function handleCreateSchema(newSchema: SchemaDefinition) {
    const created = await client.createSchema(newSchema);
    await fetchSchemas();
    setActiveTab(created.schema_id);
  }

  async function handleDeleteSchema(schemaId: string) {
    await client.deleteSchema(schemaId);
    await fetchSchemas();
    setActiveTab("dashboard");
  }

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
        schemas={schemas}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onOpenCreateSchema={() => setCreateSchemaModalOpen(true)}
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

        {activeTab !== "dashboard" && selectedSchema && (
          <SchemaView client={client} schema={selectedSchema} onDeleteSchema={handleDeleteSchema} />
        )}

        {activeTab !== "dashboard" && !selectedSchema && !loadingSchemas && (
          <div className="lattice-empty-card">
            <p className="yp-muted">Schema "{activeTab}" not found.</p>
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
        onCreate={handleCreateSchema}
      />
    </div>
  );
}
