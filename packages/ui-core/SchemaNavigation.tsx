import type { PageDefinition, SchemaDefinition } from "@lattice/types";

export interface SchemaNavigationProps {
  pages?: PageDefinition[];
  schemas: SchemaDefinition[];
  activeTab: string;
  onSelectTab: (tabId: string) => void;
  canCreateSchema?: boolean;
  onCreateSchemaClick?: () => void;
  canCreatePage?: boolean;
  onCreatePageClick?: () => void;
  showDashboard?: boolean;
  showCustomerJobTracking?: boolean;
}

export function SchemaNavigation({
  pages = [],
  schemas,
  activeTab,
  onSelectTab,
  canCreateSchema = false,
  onCreateSchemaClick,
  canCreatePage = false,
  onCreatePageClick,
  showDashboard = true,
  showCustomerJobTracking = false,
}: SchemaNavigationProps) {
  function getPageIcon(page: PageDefinition): string {
    if (page.icon) return page.icon;
    switch (page.view_type) {
      case "kanban":
        return "📌";
      case "master_detail":
        return "📂";
      case "dashboard":
        return "📈";
      case "table":
      default:
        return "📋";
    }
  }

  return (
    <nav className="lattice-nav" aria-label="Application Navigation">
      <div className="lattice-nav-tabs" role="tablist">
        {showDashboard && (
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
        )}

        {showCustomerJobTracking && (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "customer_job_tracking"}
            className={`lattice-tab ${activeTab === "customer_job_tracking" ? "lattice-tab--active" : ""}`}
            onClick={() => onSelectTab("customer_job_tracking")}
          >
            <span className="lattice-tab-icon">📋</span>
            <span className="lattice-tab-label">Jobs &amp; Customers</span>
          </button>
        )}

        {pages.map((page) => (
          <button
            key={page.page_id}
            type="button"
            role="tab"
            aria-selected={activeTab === page.page_id}
            className={`lattice-tab ${activeTab === page.page_id ? "lattice-tab--active" : ""}`}
            onClick={() => onSelectTab(page.page_id)}
          >
            <span className="lattice-tab-icon">{getPageIcon(page)}</span>
            <span className="lattice-tab-label">
              {page.name}
              {page.published === false && (
                <span className="lattice-badge lattice-badge--pill" style={{ marginLeft: "0.35rem", fontSize: "0.7rem", opacity: 0.8 }}>
                  Draft
                </span>
              )}
            </span>
          </button>
        ))}

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

        <div style={{ marginLeft: "auto", display: "flex", gap: "0.5rem" }}>
          {canCreatePage && onCreatePageClick && (
            <button
              type="button"
              className="lattice-tab lattice-tab--action"
              style={{ border: "1px dashed var(--yp-border, #cbd5e1)", borderRadius: "4px" }}
              onClick={onCreatePageClick}
            >
              <span className="lattice-tab-icon">➕</span>
              <span className="lattice-tab-label">New Page</span>
            </button>
          )}

          {canCreateSchema && onCreateSchemaClick && (
            <button
              type="button"
              className="lattice-tab lattice-tab--action"
              style={{ border: "1px dashed var(--yp-border, #cbd5e1)", borderRadius: "4px" }}
              onClick={onCreateSchemaClick}
            >
              <span className="lattice-tab-icon">➕</span>
              <span className="lattice-tab-label">New Dataset</span>
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}
