import { useEffect, useState } from "react";
import type { ProductClient } from "@lattice/sdk";
import { loadDashboardLayout, type LoadedLayout } from "./dashboardLoader";
import { Dashboard } from "./Dashboard";

interface DashboardPageProps {
  client: ProductClient;
  onSignOut: () => void;
  /** Present only when the app lets people switch workspace (desktop, mobile). */
  onChangeWorkspace?: () => void;
}

export function DashboardPage({ client, onSignOut, onChangeWorkspace }: DashboardPageProps) {
  const [loaded, setLoaded] = useState<LoadedLayout | null>(null);

  useEffect(() => {
    let ignore = false;
    loadDashboardLayout(client, client.config.collections).then((result) => {
      if (!ignore) setLoaded(result);
    });
    return () => {
      ignore = true;
    };
  }, [client]);

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

      <main>
        {!loaded && <p className="yp-muted">Loading…</p>}
        {loaded?.warning && (
          <p className="app-notice" role="status">
            {loaded.warning}
          </p>
        )}
        {loaded && <Dashboard client={client} layout={loaded.layout} />}
      </main>
    </div>
  );
}
