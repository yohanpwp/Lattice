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
}

export function DynamicPageView({ client, page, schemas, initialRecords }: DynamicPageViewProps) {
  const primarySchema = schemas.find((s) => s.schema_id === page.collection);

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
}
