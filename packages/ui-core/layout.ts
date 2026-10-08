import type { DashboardLayout, Widget } from "@lattice/types";

/**
 * Sorts widgets in standard top-to-bottom, left-to-right grid order.
 */
export function sortWidgets(widgets: readonly Widget[]): Widget[] {
  return [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Builds a default dashboard layout containing one count KPI widget per collection.
 */
export function defaultDashboard(collections: readonly string[]): DashboardLayout {
  const layout: Widget[] = collections.map((col, index) => {
    const colIndex = index % 4;
    const rowIndex = Math.floor(index / 4);
    return {
      id: `default-kpi-${col}`,
      type: "kpi",
      collection: col,
      x: colIndex * 3,
      y: rowIndex * 2,
      w: 3,
      h: 2,
      props: {
        metric: "count",
      },
    };
  });

  return {
    id: "default",
    name: "Default Dashboard",
    layout,
  };
}
