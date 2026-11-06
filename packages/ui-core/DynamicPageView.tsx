import type { PageDefinition, SchemaDefinition } from "@lattice/types";
import type { ProductClient } from "@lattice/sdk";
import { TableView } from "./TableView";
import { KanbanView } from "./KanbanView";
import { MasterDetailView } from "./MasterDetailView";
import { Dashboard } from "./Dashboard";

export interface DynamicPageViewProps {
  client: ProductClient;
  page: PageDefinition;
  schemas: SchemaDefinition[];
  initialRecords?: Array<Record<string, unknown>>;
  onEditPage?: (page: PageDefinition) => void;
}

export function DynamicPageView({ client, page, schemas, initialRecords, onEditPage }: DynamicPageViewProps) {
  const primarySchema = schemas.find((s) => s.schema_id === page.collection);

  const renderViewContent = () => {
    switch (page.view_type) {
      case "table":
        return <TableView client={client} page={page} schema={primarySchema} initialRecords={initialRecords} />;

      case "kanban":
        return <KanbanView client={client} page={page} schema={primarySchema} />;

      case "master_detail":
        return (
          <MasterDetailView
            client={client}
            page={page}
            masterSchema={primarySchema}
            allSchemas={schemas}
          />
        );

      case "dashboard":
        return (
          <Dashboard
            client={client}
            layout={{
              id: page.page_id,
              name: page.name,
              layout: (page.config?.widgets as unknown as Parameters<typeof Dashboard>[0]["layout"]["layout"]) ?? [],
            }}
          />
        );

      default:
        return (
          <div className="lattice-alert-error" role="alert">
            Unsupported view type: {(page as { view_type?: string }).view_type}
          </div>
        );
    }
  };

  return (
    <div className="lattice-page-container">
      {client.isOwnerOrAdmin && onEditPage && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "var(--yp-surface-subtle, #f1f5f9)",
            border: "1px solid var(--yp-border, #cbd5e1)",
            padding: "0.5rem 1rem",
            borderRadius: "6px",
            marginBottom: "1rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ fontSize: "1.2rem" }}>{page.icon || "📄"}</span>
            <strong>{page.name}</strong>
            <span className="yp-muted" style={{ fontSize: "0.85rem" }}>
              (ID: <code>{page.page_id}</code>, Dataset: <code>{page.collection}</code>)
            </span>
            {page.published === false && (
              <span className="lattice-badge lattice-badge--pill" style={{ background: "#fef3c7", color: "#92400e" }}>
                Unpublished Draft
              </span>
            )}
          </div>
          <button
            type="button"
            className="lattice-btn-secondary"
            style={{ padding: "0.25rem 0.65rem", fontSize: "0.85rem" }}
            onClick={() => onEditPage(page)}
          >
            ⚙️ Edit Page Settings
          </button>
        </div>
      )}
      {renderViewContent()}
    </div>
  );
}
