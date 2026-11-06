import { useEffect, useRef, useState } from "react";
import type { DashboardLayout, SchemaDefinition, Widget } from "@lattice/types";
import type { ProductClient } from "@lattice/sdk";
import { Dashboard } from "./Dashboard";

export interface DashboardConflict {
  layout: DashboardLayout;
  revision?: number;
}

export function toDashboardConflict(
  c: DashboardConflict | DashboardLayout | null | undefined
): DashboardConflict | null {
  if (!c) return null;
  if ("layout" in c && c.layout && typeof c.layout === "object") {
    return c as DashboardConflict;
  }
  return { layout: c as DashboardLayout };
}

export interface DashboardEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  client: ProductClient;
  schemas: SchemaDefinition[];
  currentLayout: DashboardLayout;
  currentRevision?: number;
  /** The canonical dashboard record name used to load, save, and recover from conflicts.
   *  Kept separate from layout.id so that "default" / "main" identity confusion is impossible.
   *  Defaults to "main" when omitted. */
  dashboardName?: string;
  onSave: (layout: DashboardLayout, options?: { expectedRevision?: number }) => Promise<void>;
  initialIncomingConflict?: DashboardConflict | DashboardLayout | null;
}

export interface DashboardEditorDraftState {
  baselineLayout: DashboardLayout;
  layoutName: string;
  widgets: Widget[];
  incomingConflict: DashboardLayout | null;
}

export type DashboardEditorDraftAction =
  | { type: "INIT"; layout: DashboardLayout }
  | { type: "SET_NAME"; name: string }
  | { type: "SET_WIDGETS"; widgets: Widget[] }
  | { type: "INCOMING_LAYOUT_UPDATE"; incomingLayout: DashboardLayout }
  | { type: "RESOLVE_LOAD_SERVER" }
  | { type: "RESOLVE_KEEP_DRAFT" };

export function isDashboardDraftDirty(baseline: DashboardLayout, name: string, widgets: Widget[]): boolean {
  const baseName = baseline.name || "Workspace Overview";
  const baseWidgetsStr = JSON.stringify(baseline.layout || []);
  const currentWidgetsStr = JSON.stringify(widgets || []);
  return name !== baseName || baseWidgetsStr !== currentWidgetsStr;
}

export function dashboardEditorDraftReducer(
  state: DashboardEditorDraftState,
  action: DashboardEditorDraftAction
): DashboardEditorDraftState {
  switch (action.type) {
    case "INIT":
      return {
        baselineLayout: action.layout,
        layoutName: action.layout.name || "Workspace Overview",
        widgets: action.layout.layout ? JSON.parse(JSON.stringify(action.layout.layout)) : [],
        incomingConflict: null,
      };
    case "SET_NAME":
      return {
        ...state,
        layoutName: action.name,
      };
    case "SET_WIDGETS":
      return {
        ...state,
        widgets: action.widgets,
      };
    case "INCOMING_LAYOUT_UPDATE": {
      const baselineStr = JSON.stringify(state.baselineLayout);
      const incomingStr = JSON.stringify(action.incomingLayout);
      if (baselineStr === incomingStr) {
        return state;
      }
      const isDirty = isDashboardDraftDirty(state.baselineLayout, state.layoutName, state.widgets);
      if (!isDirty) {
        return {
          baselineLayout: action.incomingLayout,
          layoutName: action.incomingLayout.name || "Workspace Overview",
          widgets: action.incomingLayout.layout ? JSON.parse(JSON.stringify(action.incomingLayout.layout)) : [],
          incomingConflict: null,
        };
      }
      return {
        ...state,
        incomingConflict: action.incomingLayout,
      };
    }
    case "RESOLVE_LOAD_SERVER": {
      if (!state.incomingConflict) return state;
      return {
        baselineLayout: state.incomingConflict,
        layoutName: state.incomingConflict.name || "Workspace Overview",
        widgets: state.incomingConflict.layout ? JSON.parse(JSON.stringify(state.incomingConflict.layout)) : [],
        incomingConflict: null,
      };
    }
    case "RESOLVE_KEEP_DRAFT":
      return {
        ...state,
        baselineLayout: state.incomingConflict ?? state.baselineLayout,
        incomingConflict: null,
      };
    default:
      return state;
  }
}

export function DashboardEditorModal({
  isOpen,
  onClose,
  client,
  schemas,
  currentLayout,
  currentRevision,
  dashboardName = "main",
  onSave,
  initialIncomingConflict,
}: DashboardEditorModalProps) {
  const [layoutName, setLayoutName] = useState(currentLayout.name || "Workspace Overview");
  const [widgets, setWidgets] = useState<Widget[]>(currentLayout.layout || []);
  const [activeTab, setActiveTab] = useState<"widgets" | "preview">("widgets");

  // New widget form state
  const [newType, setNewType] = useState<Widget["type"]>("kpi");
  const [newCollection, setNewCollection] = useState(schemas[0]?.schema_id || "");
  const [newMetric, setNewMetric] = useState("count");
  const [newWidth, setNewWidth] = useState(4);
  const [newHeight, setNewHeight] = useState(2);
  const [newFields, setNewFields] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const baselineLayoutRef = useRef<DashboardLayout>(currentLayout);
  const currentRevisionRef = useRef<number | undefined>(currentRevision);
  const wasOpenRef = useRef<boolean>(false);
  const [incomingConflict, setIncomingConflict] = useState<DashboardConflict | null>(() =>
    toDashboardConflict(initialIncomingConflict)
  );

  useEffect(() => {
    if (typeof currentRevision === "number" && !incomingConflict) {
      currentRevisionRef.current = currentRevision;
    }
  }, [currentRevision, incomingConflict]);

  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      setIncomingConflict(null);
      setError(null);
      return;
    }

    if (!wasOpenRef.current) {
      // Modal just opened: initialize from currentLayout baseline
      wasOpenRef.current = true;
      baselineLayoutRef.current = currentLayout;
      currentRevisionRef.current = currentRevision;
      setLayoutName(currentLayout.name || "Workspace Overview");
      setWidgets(currentLayout.layout ? JSON.parse(JSON.stringify(currentLayout.layout)) : []);
      setNewCollection(schemas[0]?.schema_id || "");
      setError(null);
      setIncomingConflict(toDashboardConflict(initialIncomingConflict));
      setActiveTab("widgets");
      return;
    }

    // Modal was already open: check if prop changed due to an external live update
    const baselineStr = JSON.stringify(baselineLayoutRef.current);
    const newPropStr = JSON.stringify(currentLayout);
    if (baselineStr !== newPropStr) {
      // Check if user has made local edits relative to the baseline
      const isDirty = isDashboardDraftDirty(baselineLayoutRef.current, layoutName, widgets);

      if (!isDirty) {
        // User has not made edits: safely update to latest layout from server
        baselineLayoutRef.current = currentLayout;
        if (typeof currentRevision === "number") {
          currentRevisionRef.current = currentRevision;
        }
        setLayoutName(currentLayout.name || "Workspace Overview");
        setWidgets(currentLayout.layout ? JSON.parse(JSON.stringify(currentLayout.layout)) : []);
        setIncomingConflict(null);
      } else {
        // User has active uncommitted edits: preserve draft and surface live conflict with incoming revision
        setIncomingConflict({
          layout: currentLayout,
          revision: currentRevision,
        });
      }
    }
  }, [isOpen, currentLayout, currentRevision, schemas, layoutName, widgets, initialIncomingConflict]);

  const selectedSchema = schemas.find((s) => s.schema_id === newCollection);
  const availableFields = selectedSchema?.fields || [];

  if (!isOpen) return null;

  function handleAddWidget() {
    if (!newCollection) {
      setError("Please select a target dataset for the widget.");
      return;
    }

    const id = `widget_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    
    // Calculate reasonable x, y based on existing widgets
    const yOffset = widgets.reduce((maxY, w) => Math.max(maxY, (w.y || 0) + (w.h || 2)), 0);

    const widget: Widget = {
      id,
      type: newType,
      collection: newCollection,
      x: 0,
      y: yOffset,
      w: Math.min(12, Math.max(1, newWidth)),
      h: Math.max(1, newHeight),
      props: {},
    };

    if (newType === "kpi") {
      widget.props = { metric: newMetric || "count" };
    } else if (newType === "table") {
      widget.props = {
        fields: newFields.length > 0 ? newFields : availableFields.slice(0, 4).map((f) => f.name),
      };
    }

    setWidgets((prev) => [...prev, widget]);
    setNewFields([]);
    setError(null);
  }

  function handleRemoveWidget(widgetId: string) {
    setWidgets((prev) => prev.filter((w) => w.id !== widgetId));
  }

  function handleUpdateWidgetWidth(widgetId: string, delta: number) {
    setWidgets((prev) =>
      prev.map((w) => {
        if (w.id === widgetId) {
          const nextW = Math.min(12, Math.max(1, w.w + delta));
          return { ...w, w: nextW };
        }
        return w;
      })
    );
  }

  async function handleSave() {
    setError(null);
    if (incomingConflict !== null) {
      setError("Please resolve the live update conflict before saving (choose 'Load Server Version' or 'Keep My Draft').");
      return;
    }
    if (!layoutName.trim()) {
      setError("Dashboard name is required.");
      return;
    }

    const layoutToSave: DashboardLayout = {
      id: currentLayout.id || "main",
      name: layoutName.trim(),
      layout: widgets,
    };

    setSaving(true);
    try {
      await onSave(layoutToSave, { expectedRevision: currentRevisionRef.current });
      onClose();
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 409) {
        setError(
          "Conflict detected: Another session saved changes to this dashboard layout. Your current draft is preserved. Please review or resolve below."
        );
        try {
          const latest = await client.getDashboardLayout(dashboardName);
          if (latest) {
            setIncomingConflict({
              layout: latest,
              revision: latest.revision,
            });
            if (typeof latest.revision === "number") {
              currentRevisionRef.current = latest.revision;
            }
          } else {
            setError(
              "Conflict: could not load the winning server version. Your draft is preserved. Retry saving or close and reopen to reload."
            );
          }
        } catch {
          setError(
            "Conflict: failed to fetch the winning server version. Your draft is preserved. Retry saving or close and reopen to reload."
          );
        }
      } else {
        setError(err instanceof Error ? err.message : "Failed to save dashboard layout");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="lattice-modal-overlay" role="dialog" aria-modal="true">
      <div className="lattice-modal-dialog" style={{ maxWidth: "800px" }}>
        <header className="lattice-modal-header">
          <h2>Customize Workspace Dashboard</h2>
          <button type="button" className="lattice-modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {incomingConflict && (
          <div
            className="lattice-alert-warning"
            role="alert"
            style={{
              padding: "0.75rem 1rem",
              marginBottom: "1rem",
              borderRadius: "4px",
              backgroundColor: "var(--lattice-warning-bg, #fef3c7)",
              border: "1px solid var(--lattice-warning-border, #f59e0b)",
              color: "var(--lattice-warning-text, #92400e)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "1rem",
            }}
          >
            <div>
              <strong>Live Update Detected:</strong> Another session saved changes to this dashboard layout. Your current draft is preserved.
            </div>
            <div style={{ display: "flex", gap: "0.5rem", flexShrink: 0 }}>
              <button
                type="button"
                className="lattice-btn-secondary"
                style={{ fontSize: "0.8rem", padding: "0.25rem 0.5rem" }}
                onClick={() => {
                  if (incomingConflict) {
                    baselineLayoutRef.current = incomingConflict.layout;
                    if (typeof incomingConflict.revision === "number") {
                      currentRevisionRef.current = incomingConflict.revision;
                    }
                    setLayoutName(incomingConflict.layout.name || "Workspace Overview");
                    setWidgets(incomingConflict.layout.layout ? JSON.parse(JSON.stringify(incomingConflict.layout.layout)) : []);
                    setIncomingConflict(null);
                    setError(null);
                  }
                }}
              >
                Load Server Version
              </button>
              <button
                type="button"
                className="lattice-btn-secondary"
                style={{ fontSize: "0.8rem", padding: "0.25rem 0.5rem" }}
                onClick={() => {
                  if (incomingConflict) {
                    baselineLayoutRef.current = incomingConflict.layout;
                    if (typeof incomingConflict.revision === "number") {
                      currentRevisionRef.current = incomingConflict.revision;
                    }
                    setIncomingConflict(null);
                    setError(null);
                  }
                }}
              >
                Keep My Draft
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="lattice-alert-error" role="alert">
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: "1rem", borderBottom: "1px solid var(--yp-border, #cbd5e1)", paddingBottom: "0.5rem", marginBottom: "1rem" }}>
          <button
            type="button"
            className={`lattice-tab ${activeTab === "widgets" ? "lattice-tab--active" : ""}`}
            onClick={() => setActiveTab("widgets")}
          >
            🧩 Configure Widgets ({widgets.length})
          </button>
          <button
            type="button"
            className={`lattice-tab ${activeTab === "preview" ? "lattice-tab--active" : ""}`}
            onClick={() => setActiveTab("preview")}
          >
            👁️ Preview Layout
          </button>
        </div>

        {activeTab === "preview" ? (
          <div style={{ maxHeight: "60vh", overflowY: "auto", padding: "0.5rem" }}>
            <p className="yp-muted" style={{ marginBottom: "1rem" }}>
              Previewing shared workspace dashboard as administrator:
            </p>
            <Dashboard client={client} layout={{ id: currentLayout.id || "main", name: layoutName, layout: widgets }} />
          </div>
        ) : (
          <div style={{ maxHeight: "65vh", overflowY: "auto" }}>
            <div className="lattice-form-group">
              <label htmlFor="dash-name" className="lattice-form-label">
                Dashboard Title
              </label>
              <input
                id="dash-name"
                type="text"
                className="lattice-input"
                value={layoutName}
                onChange={(e) => setLayoutName(e.target.value)}
                placeholder="e.g. Workspace Overview"
              />
            </div>

            {/* Add Widget Panel */}
            <fieldset className="lattice-fieldset" style={{ marginTop: "1rem", border: "1px solid var(--yp-border, #cbd5e1)", padding: "1rem", borderRadius: "6px" }}>
              <legend style={{ fontWeight: "bold", padding: "0 0.5rem" }}>+ Add New Widget</legend>
              <div className="lattice-form-grid">
                <div className="lattice-form-group">
                  <label htmlFor="widget-type" className="lattice-form-label">
                    Widget Type
                  </label>
                  <select
                    id="widget-type"
                    className="lattice-input"
                    value={newType}
                    onChange={(e) => setNewType(e.target.value as Widget["type"])}
                  >
                    <option value="kpi">KPI Summary Card</option>
                    <option value="table">Recent Records Table</option>
                    <option value="list">Recent Records List</option>
                  </select>
                </div>

                <div className="lattice-form-group">
                  <label htmlFor="widget-collection" className="lattice-form-label">
                    Source Dataset
                  </label>
                  <select
                    id="widget-collection"
                    className="lattice-input"
                    value={newCollection}
                    onChange={(e) => {
                      setNewCollection(e.target.value);
                      setNewFields([]);
                    }}
                  >
                    {schemas.map((s) => (
                      <option key={s.schema_id} value={s.schema_id}>
                        {s.name} ({s.schema_id})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="lattice-form-group">
                  <label htmlFor="widget-width" className="lattice-form-label">
                    Grid Width (Columns, 1-12)
                  </label>
                  <input
                    id="widget-width"
                    type="number"
                    className="lattice-input"
                    min={1}
                    max={12}
                    value={newWidth}
                    onChange={(e) => setNewWidth(parseInt(e.target.value, 10) || 4)}
                  />
                </div>

                {newType === "kpi" && (
                  <div className="lattice-form-group">
                    <label htmlFor="widget-metric" className="lattice-form-label">
                      Metric Aggregation
                    </label>
                    <select
                      id="widget-metric"
                      className="lattice-input"
                      value={newMetric}
                      onChange={(e) => setNewMetric(e.target.value)}
                    >
                      <option value="count">Count of records (total)</option>
                      {availableFields
                        .filter((f) => f.type === "number")
                        .map((f) => (
                          <optgroup key={f.name} label={`Field: ${f.label || f.name}`}>
                            <option value={`sum:${f.name}`}>Sum of {f.label || f.name}</option>
                            <option value={`avg:${f.name}`}>Average of {f.label || f.name}</option>
                          </optgroup>
                        ))}
                    </select>
                  </div>
                )}
              </div>

              {newType === "table" && availableFields.length > 0 && (
                <div className="lattice-form-group" style={{ marginTop: "0.75rem" }}>
                  <label className="lattice-form-label">Displayed Columns (select up to 6)</label>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                    {availableFields.map((f) => {
                      const isSelected = newFields.includes(f.name);
                      return (
                        <button
                          key={f.name}
                          type="button"
                          className={`lattice-chip-btn ${isSelected ? "lattice-chip-btn--active" : ""}`}
                          style={{
                            padding: "0.25rem 0.6rem",
                            borderRadius: "4px",
                            border: "1px solid",
                            borderColor: isSelected ? "var(--yp-primary, #2563eb)" : "var(--yp-border, #cbd5e1)",
                            background: isSelected ? "var(--yp-primary-bg, #eff6ff)" : "#fff",
                            cursor: "pointer",
                          }}
                          onClick={() => {
                            setNewFields((prev) =>
                              isSelected ? prev.filter((name) => name !== f.name) : [...prev, f.name]
                            );
                          }}
                        >
                          {isSelected ? "✓ " : "+ "}{f.label || f.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <button
                type="button"
                className="lattice-btn-secondary"
                style={{ marginTop: "0.75rem" }}
                onClick={handleAddWidget}
              >
                + Add Widget to Dashboard
              </button>
            </fieldset>

            {/* Configured Widgets List */}
            <div style={{ marginTop: "1.5rem" }}>
              <h3 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>Active Widgets ({widgets.length})</h3>
              {widgets.length === 0 ? (
                <p className="yp-muted">No widgets configured yet. Add one above.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {widgets.map((widget, idx) => (
                    <div
                      key={widget.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "0.75rem",
                        borderRadius: "6px",
                        border: "1px solid var(--yp-border, #cbd5e1)",
                        background: "var(--yp-card-bg, #f8fafc)",
                      }}
                    >
                      <div>
                        <strong>{idx + 1}. {widget.type.toUpperCase()}:</strong> {widget.collection}
                        <span className="yp-muted" style={{ marginLeft: "0.5rem", fontSize: "0.85rem" }}>
                          (Width: {widget.w}/12 cols, Height: {widget.h} rows)
                        </span>
                        {widget.props?.metric && (
                          <span className="lattice-badge lattice-badge--pill" style={{ marginLeft: "0.5rem" }}>
                            {widget.props.metric}
                          </span>
                        )}
                      </div>

                      <div style={{ display: "flex", gap: "0.5rem" }}>
                        <button
                          type="button"
                          className="lattice-btn-table"
                          title="Narrower"
                          disabled={widget.w <= 1}
                          onClick={() => handleUpdateWidgetWidth(widget.id, -1)}
                        >
                          - Col
                        </button>
                        <button
                          type="button"
                          className="lattice-btn-table"
                          title="Wider"
                          disabled={widget.w >= 12}
                          onClick={() => handleUpdateWidgetWidth(widget.id, 1)}
                        >
                          + Col
                        </button>
                        <button
                          type="button"
                          className="lattice-btn-table lattice-btn-table-danger"
                          onClick={() => handleRemoveWidget(widget.id)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <footer className="lattice-modal-footer" style={{ marginTop: "1.5rem" }}>
          {incomingConflict && (
            <div
              className="lattice-conflict-hint"
              style={{
                fontSize: "0.85rem",
                color: "var(--lattice-warning-text, #92400e)",
                marginRight: "auto",
                alignSelf: "center",
              }}
            >
              Resolve live update above before saving.
            </div>
          )}
          <button type="button" className="lattice-btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="lattice-btn-primary"
            onClick={handleSave}
            disabled={saving || incomingConflict !== null}
            title={incomingConflict !== null ? "Resolve the live update conflict above before saving." : undefined}
          >
            {saving ? "Saving…" : "Save & Publish Dashboard"}
          </button>
        </footer>
      </div>
    </div>
  );
}
