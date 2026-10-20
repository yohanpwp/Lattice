import type { PageDefinition, SchemaDefinition } from "@lattice/types";

export interface SchemaNavigationProps {
  pages?: PageDefinition[];
  schemas: SchemaDefinition[];
  activeTab: string;
  onSelectTab: (tabId: string) => void;
}

export function SchemaNavigation({
  pages = [],
  schemas,
  activeTab,
  onSelectTab,
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
            <span className="lattice-tab-label">{page.name}</span>
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
      </div>
    </nav>
  );
}
