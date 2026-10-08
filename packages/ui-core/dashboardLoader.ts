import { assertDashboardLayout, type DashboardLayout } from "@lattice/types";
import { defaultDashboard } from "./layout";
import type { DataClient } from "./query";

export interface LoadedLayout {
  layout: DashboardLayout;
  source: "saved" | "default";
  /** Set when a saved layout existed but could not be used. */
  warning?: string;
}

/**
 * Loads the signed-in user's saved layout from the "dashboards" collection
 * (records with `name` and a JSON `layout` field), falling back to a default
 * built from the tenant's collections.
 *
 * A missing collection or no access (404/403) silently yields the default,
 * since no layout has been saved yet. Any other failure, or a saved layout
 * that breaks the contract, yields the default plus a warning.
 */
export async function loadDashboardLayout(
  client: DataClient,
  collections: readonly string[],
  name = "main",
): Promise<LoadedLayout> {
  const fallback = defaultDashboard(collections);

  try {
    const page = await client.collection("dashboards").getList(1, 1, {
      filter: client.filter("name = {:name}", { name }),
      requestKey: null,
    });

    const record = page.items[0];
    if (!record) return { layout: fallback, source: "default" };

    try {
      return { layout: assertDashboardLayout(record.layout), source: "saved" };
    } catch {
      return {
        layout: fallback,
        source: "default",
        warning: "Your saved dashboard layout is invalid, so the default layout is shown.",
      };
    }
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    if (status === 404 || status === 403) return { layout: fallback, source: "default" };

    return {
      layout: fallback,
      source: "default",
      warning: "Could not load your saved dashboard layout, so the default layout is shown.",
    };
  }
}
