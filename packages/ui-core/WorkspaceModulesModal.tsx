import { useCallback, useEffect, useState } from "react";
import type { PageDefinition, SchemaDefinition, WorkspaceModule } from "@lattice/types";
import type { ProductClient } from "@lattice/sdk";

export interface WorkspaceModulesModalProps {
  isOpen: boolean;
  onClose: () => void;
  client: ProductClient;
  schemas?: SchemaDefinition[];
  pages?: PageDefinition[];
  onModulesChanged?: () => void;
}

export function WorkspaceModulesModal({
  isOpen,
  onClose,
  client,
  schemas = [],
  pages = [],
  onModulesChanged,
}: WorkspaceModulesModalProps) {
  const [modules, setModules] = useState<WorkspaceModule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<"all" | "dataset" | "features" | "views">("all");
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const loadModules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await client.getModules();
      setModules(list);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load workspace modules");
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (isOpen) {
      loadModules();
      setSearchQuery("");
      setFilterType("all");
    }
  }, [isOpen, loadModules]);

  if (!isOpen) return null;

  async function handleToggle(moduleId: string, enable: boolean) {
    setTogglingId(moduleId);
    setError(null);
    try {
      await client.setModuleEnabled(moduleId, enable);
      await loadModules();
      onModulesChanged?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : `Failed to ${enable ? "enable" : "disable"} module`);
    } finally {
      setTogglingId(null);
    }
  }

  const isOwnerOrAdmin = client.isOwnerOrAdmin;

  const filteredModules = modules.filter((mod) => {
    // Type filter
    if (filterType === "dataset" && !mod.dataset_id) return false;
    if (filterType === "features" && !mod.feature_flag && mod.id !== "dashboard") return false;
    if (filterType === "views" && !mod.id.startsWith("page_")) return false;

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      const matchName = mod.name.toLowerCase().includes(q);
      const matchDesc = (mod.description || "").toLowerCase().includes(q);
      const matchId = mod.id.toLowerCase().includes(q);
      const matchDataset = (mod.dataset_id || "").toLowerCase().includes(q);
      return matchName || matchDesc || matchId || matchDataset;
    }

    return true;
  });

  const activeCount = modules.filter((m) => m.enabled).length;
  const disabledCount = modules.filter((m) => !m.enabled).length;

  function getModuleTypeBadge(mod: WorkspaceModule) {
    if (mod.dataset_id) {
      return <span className="lattice-role-chip lattice-role-chip--member">Dataset</span>;
    }
    if (mod.id === "dashboard") {
      return <span className="lattice-role-chip lattice-role-chip--owner">Core</span>;
    }
    if (mod.feature_flag) {
      return <span className="lattice-role-chip lattice-role-chip--admin">Feature</span>;
    }
    return <span className="app-chip">Custom View</span>;
  }

  return (
    <div className="lattice-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="modules-modal-title">
      <div className="lattice-modal lattice-modal-lg" style={{ maxWidth: "860px" }}>
        <div className="lattice-modal-header">
          <div>
            <h2 id="modules-modal-title">Workspace Modules &amp; Capabilities</h2>
            <p className="yp-muted" style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
              Configure active modules, datasets, and custom pages for workspace members.
            </p>
          </div>
          <button type="button" className="lattice-modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="lattice-modal-body" style={{ padding: "1.25rem 1.5rem" }}>
          {error && (
            <div className="app-notice" style={{ borderColor: "#dc2626", background: "#fef2f2", color: "#b91c1c" }}>
              {error}
            </div>
          )}

          {/* Metrics summary banner */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              background: "var(--lattice-bg)",
              border: "1px solid var(--lattice-border)",
              borderRadius: "6px",
              padding: "0.75rem 1rem",
              marginBottom: "1rem",
              gap: "1rem",
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", gap: "1.5rem", alignItems: "center" }}>
              <div>
                <span className="yp-muted" style={{ fontSize: "0.75rem", textTransform: "uppercase" }}>Total Modules</span>
                <div style={{ fontWeight: 700, fontSize: "1.1rem" }}>{modules.length}</div>
              </div>
              <div>
                <span className="yp-muted" style={{ fontSize: "0.75rem", textTransform: "uppercase" }}>Active</span>
                <div style={{ fontWeight: 700, fontSize: "1.1rem", color: "#16a34a" }}>{activeCount}</div>
              </div>
              {disabledCount > 0 && (
                <div>
                  <span className="yp-muted" style={{ fontSize: "0.75rem", textTransform: "uppercase" }}>Disabled</span>
                  <div style={{ fontWeight: 700, fontSize: "1.1rem", color: "#ea580c" }}>{disabledCount}</div>
                </div>
              )}
            </div>

            <span className="yp-muted" style={{ fontSize: "0.8rem", maxWidth: "340px" }}>
              Disabling a module hides its navigation tab and views for all members.
            </span>
          </div>

          {/* Search and Category Filter Toolbar */}
          <div
            style={{
              display: "flex",
              gap: "0.75rem",
              marginBottom: "1rem",
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: 1, minWidth: "220px" }}>
              <input
                type="text"
                placeholder="Search modules by name, dataset, or tag…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "0.5rem 0.75rem",
                  fontSize: "0.875rem",
                  borderRadius: "6px",
                  border: "1px solid var(--lattice-border)",
                }}
              />
            </div>
            <div style={{ display: "flex", gap: "0.4rem" }}>
              <button
                type="button"
                className={filterType === "all" ? "lattice-btn-primary" : "lattice-btn-secondary"}
                style={{ padding: "0.4rem 0.75rem", fontSize: "0.8rem" }}
                onClick={() => setFilterType("all")}
              >
                All ({modules.length})
              </button>
              <button
                type="button"
                className={filterType === "dataset" ? "lattice-btn-primary" : "lattice-btn-secondary"}
                style={{ padding: "0.4rem 0.75rem", fontSize: "0.8rem" }}
                onClick={() => setFilterType("dataset")}
              >
                Datasets ({modules.filter((m) => m.dataset_id).length})
              </button>
              <button
                type="button"
                className={filterType === "features" ? "lattice-btn-primary" : "lattice-btn-secondary"}
                style={{ padding: "0.4rem 0.75rem", fontSize: "0.8rem" }}
                onClick={() => setFilterType("features")}
              >
                Features ({modules.filter((m) => m.feature_flag || m.id === "dashboard").length})
              </button>
            </div>
          </div>

          {/* Modules List Table */}
          {loading ? (
            <p className="yp-muted" style={{ textAlign: "center", padding: "2rem" }}>
              Loading workspace modules…
            </p>
          ) : filteredModules.length === 0 ? (
            <div className="lattice-empty-card" style={{ padding: "2rem", textAlign: "center" }}>
              <p className="yp-muted">No modules match your current filter.</p>
            </div>
          ) : (
            <div className="lattice-table-container">
              <table className="lattice-table" aria-label="Workspace modules">
                <thead>
                  <tr>
                    <th>Module</th>
                    <th>Type</th>
                    <th>Resources Mapped</th>
                    <th>Status</th>
                    <th style={{ textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredModules.map((mod) => {
                    const isToggling = togglingId === mod.id;
                    return (
                      <tr key={mod.id} style={{ opacity: mod.enabled ? 1 : 0.65 }}>
                        <td>
                          <div style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem" }}>
                            <span style={{ fontSize: "1.25rem", lineHeight: 1 }}>{mod.icon || "📦"}</span>
                            <div>
                              <strong style={{ display: "block", fontSize: "0.9rem" }}>{mod.name}</strong>
                              {mod.description && (
                                <span className="yp-muted" style={{ fontSize: "0.78rem" }}>
                                  {mod.description}
                                </span>
                              )}
                              <span
                                style={{
                                  display: "inline-block",
                                  fontSize: "0.72rem",
                                  color: "var(--lattice-muted)",
                                  fontFamily: "monospace",
                                  marginTop: "0.15rem",
                                }}
                              >
                                ID: {mod.id}
                              </span>
                            </div>
                          </div>
                        </td>
                        <td>{getModuleTypeBadge(mod)}</td>
                        <td>
                          {mod.dataset_id && (
                            <div style={{ fontSize: "0.8rem" }}>
                              <strong>Dataset:</strong> <code>{mod.dataset_id}</code>
                            </div>
                          )}
                          {mod.page_ids && mod.page_ids.length > 0 && (
                            <div style={{ fontSize: "0.75rem", color: "var(--lattice-muted)", marginTop: "0.2rem" }}>
                              {mod.page_ids.length} page(s): {mod.page_ids.join(", ")}
                            </div>
                          )}
                          {!mod.dataset_id && (!mod.page_ids || mod.page_ids.length === 0) && (
                            <span className="yp-muted" style={{ fontSize: "0.75rem" }}>
                              {mod.feature_flag ? `Flag: ${mod.feature_flag}` : "Global workspace"}
                            </span>
                          )}
                        </td>
                        <td>
                          {mod.enabled ? (
                            <span
                              className="lattice-status-badge lattice-status-badge--active"
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.3rem",
                                fontSize: "0.75rem",
                                fontWeight: 600,
                                color: "#16a34a",
                              }}
                            >
                              <span style={{ fontSize: "0.7rem" }}>●</span> Active
                            </span>
                          ) : (
                            <span
                              className="lattice-status-badge lattice-status-badge--disabled"
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.3rem",
                                fontSize: "0.75rem",
                                fontWeight: 600,
                                color: "#9ca3af",
                              }}
                            >
                              <span style={{ fontSize: "0.7rem" }}>○</span> Disabled
                            </span>
                          )}
                        </td>
                        <td style={{ textAlign: "right" }}>
                          {isOwnerOrAdmin ? (
                            mod.enabled ? (
                              <button
                                type="button"
                                className="lattice-btn-secondary"
                                style={{
                                  padding: "0.3rem 0.6rem",
                                  fontSize: "0.78rem",
                                  color: "#b45309",
                                  borderColor: "#fcd34d",
                                }}
                                disabled={isToggling}
                                onClick={() => handleToggle(mod.id, false)}
                              >
                                {isToggling ? "Updating…" : "Disable"}
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="lattice-btn-primary"
                                style={{
                                  padding: "0.3rem 0.6rem",
                                  fontSize: "0.78rem",
                                }}
                                disabled={isToggling}
                                onClick={() => handleToggle(mod.id, true)}
                              >
                                {isToggling ? "Updating…" : "Enable"}
                              </button>
                            )
                          ) : (
                            <span className="yp-muted" style={{ fontSize: "0.75rem" }}>
                              Admin only
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="lattice-modal-footer">
          <button type="button" className="lattice-btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
