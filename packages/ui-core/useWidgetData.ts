import { useEffect, useState } from "react";
import type { Widget } from "@lattice/types";
import { buildListOptions, perPageFor, type DataClient, type ListPage } from "./query";

export type WidgetData =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; page: ListPage };

export function useWidgetData(client: DataClient, widget: Widget): WidgetData {
  const [data, setData] = useState<WidgetData>({ status: "loading" });

  useEffect(() => {
    let ignore = false;
    setData({ status: "loading" });

    async function fetchData() {
      try {
        const options = buildListOptions(widget, (raw, params) => client.filter(raw, params));
        const perPage = perPageFor(widget.type);
        const page = await client.collection(widget.collection).getList(1, perPage, options);
        if (!ignore) {
          setData({ status: "ready", page });
        }
      } catch (err) {
        if (!ignore) {
          const message = err instanceof Error ? err.message : "Failed to load data";
          setData({ status: "error", message });
        }
      }
    }

    void fetchData();

    return () => {
      ignore = true;
    };
  }, [client, widget]);

  return data;
}
