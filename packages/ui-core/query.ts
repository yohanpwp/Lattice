import type { Widget } from "@lattice/types";

/** The subset of PocketBase list options the dashboard uses. */
export interface ListOptions {
  filter?: string;
  sort?: string;
  fields?: string;
  /** null disables PocketBase's automatic request cancellation. */
  requestKey?: string | null;
}

export interface ListPage {
  items: ReadonlyArray<Record<string, unknown>>;
  totalItems: number;
}

/**
 * What the dashboard needs from a data client. ProductClient satisfies it, and
 * tests can pass a tiny fake.
 */
export interface DataClient {
  collection(name: string): {
    getList(page: number, perPage: number, options: ListOptions): Promise<ListPage>;
  };
  filter(raw: string, params?: Record<string, unknown>): string;
}

const PER_PAGE: Record<Widget["type"], number> = {
  kpi: 1, // only totalItems is used
  table: 10,
  list: 10,
  chart: 100,
  form: 1,
};

export function perPageFor(type: Widget["type"]): number {
  return PER_PAGE[type];
}

/**
 * Builds list options from widget props. User-controlled values only reach the
 * filter through bound params (client.filter), never string concatenation.
 */
export function buildListOptions(
  widget: Widget,
  bindFilter: (raw: string, params?: Record<string, unknown>) => string,
): ListOptions {
  const props = widget.props ?? {};
  const options: ListOptions = { requestKey: null };

  if (props.filter) options.filter = bindFilter(props.filter, props.params);
  if (props.sort) options.sort = props.sort;
  if (props.fields && props.fields.length > 0) {
    // Always fetch id so rows have a stable key.
    options.fields = [...new Set(["id", ...props.fields])].join(",");
  }

  return options;
}
