import type { CSSProperties } from "react";
import type { DashboardLayout } from "@lattice/types";
import { sortWidgets } from "./layout";
import type { DataClient } from "./query";
import { WidgetRenderer } from "./widgets";

interface DashboardProps {
  client: DataClient;
  layout: DashboardLayout;
}

/**
 * Renders a layout on a 12-column grid. Placement uses CSS variables so the
 * stylesheet can stack widgets in one column on narrow screens.
 */
export function Dashboard({ client, layout }: DashboardProps) {
  if (layout.layout.length === 0) {
    return <p className="yp-muted">Nothing to show yet.</p>;
  }

  return (
    <div className="yp-grid" role="list" aria-label={layout.name}>
      {sortWidgets(layout.layout).map((widget) => {
        const style = {
          "--yp-col": `${widget.x + 1} / span ${widget.w}`,
          "--yp-row": `${widget.y + 1} / span ${widget.h}`,
        } as CSSProperties;

        return (
          <section key={widget.id} role="listitem" className={`yp-widget yp-widget--${widget.type}`} style={style}>
            <h3 className="yp-widget-title">{widget.collection}</h3>
            <WidgetRenderer client={client} widget={widget} />
          </section>
        );
      })}
    </div>
  );
}
