import type { Widget } from "@lattice/types";
import { isClientComputable, parseMetric } from "./metrics";
import type { DataClient } from "./query";
import { columnsFor, displayValue, rowLabel } from "./format";
import { useWidgetData, type WidgetData } from "./useWidgetData";

interface WidgetProps {
  client: DataClient;
  widget: Widget;
}

function Status({ data }: { data: Exclude<WidgetData, { status: "ready" }> }) {
  if (data.status === "loading") {
    return <p className="yp-muted">Loading…</p>;
  }
  return (
    <p className="yp-error" role="alert">
      {data.message}
    </p>
  );
}

export function KpiWidget({ client, widget }: WidgetProps) {
  const data = useWidgetData(client, widget);

  let metric;
  try {
    metric = parseMetric(widget.props?.metric);
  } catch {
    return <p className="yp-error">Invalid metric</p>;
  }

  if (!isClientComputable(metric)) {
    return <p className="yp-muted">This metric needs a server aggregate, which is not available yet.</p>;
  }
  if (data.status !== "ready") return <Status data={data} />;

  return <p className="yp-kpi">{data.page.totalItems.toLocaleString()}</p>;
}

export function TableWidget({ client, widget }: WidgetProps) {
  const data = useWidgetData(client, widget);
  if (data.status !== "ready") return <Status data={data} />;

  const { items } = data.page;
  if (items.length === 0) return <p className="yp-muted">No records.</p>;

  const columns = columnsFor(items, widget.props?.fields);
  return (
    <div className="yp-scroll">
      <table className="yp-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={displayValue(item.id) || index}>
              {columns.map((column) => (
                <td key={column}>{displayValue(item[column])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ListWidget({ client, widget }: WidgetProps) {
  const data = useWidgetData(client, widget);
  if (data.status !== "ready") return <Status data={data} />;

  const { items } = data.page;
  if (items.length === 0) return <p className="yp-muted">No records.</p>;

  return (
    <ul className="yp-list">
      {items.map((item, index) => (
        <li key={displayValue(item.id) || index}>{rowLabel(item)}</li>
      ))}
    </ul>
  );
}

/** Shown for widget types a platform has not implemented yet (chart, form). */
export function UnsupportedWidget({ widget }: { widget: Widget }) {
  return <p className="yp-muted">“{widget.type}” widgets are not supported yet.</p>;
}

export function WidgetRenderer({ client, widget }: WidgetProps) {
  switch (widget.type) {
    case "kpi":
      return <KpiWidget client={client} widget={widget} />;
    case "table":
      return <TableWidget client={client} widget={widget} />;
    case "list":
      return <ListWidget client={client} widget={widget} />;
    default:
      return <UnsupportedWidget widget={widget} />;
  }
}
