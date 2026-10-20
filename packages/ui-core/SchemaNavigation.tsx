import type { SchemaDefinition } from "@lattice/types";

export interface SchemaNavigationProps {
  schemas: SchemaDefinition[];
  activeTab: string;
  onSelectTab: (tabId: string) => void;
  onOpenCreateSchema: () => void;
}

export function SchemaNavigation({
  schemas,
  activeTab,
  onSelectTab,
  onOpenCreateSchema,
}: SchemaNavigationProps) {
  return (
    <nav className="lattice-nav" aria-label="Collections and Schemas">
      <div className="lattice-nav-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "dashboard"}
          className={`lattice-tab ${activeTab === "dashboard" ? "lattice-tab--active" : ""}`}
          onClick={() => onSelectTab("dashboard")}
        >
          <span className="lattice-tab-icon">📊</span>
          <span className="lattice-tab-label">Dashboard Overview</span>
        </button>

        {schemas.map((schema) => (
          <button
            key={schema.schema_id}
            type="button"
            role="tab"
            aria-selected={activeTab === schema.schema_id}
            className={`lattice-tab ${activeTab === schema.schema_id ? "lattice-tab--active" : ""}`}
            onClick={() => onSelectTab(schema.schema_id)}
          >
            <span className="lattice-tab-icon">{schema.icon || "📁"}</span>
            <span className="lattice-tab-label">{schema.name}</span>
          </button>
        ))}
      </div>

      <div className="lattice-nav-actions">
        <button
          type="button"
          className="lattice-btn-secondary"
          onClick={onOpenCreateSchema}
          title="Create a new dynamic schema"
        >
          + New Schema
        </button>
      </div>
    </nav>
  );
}
