export interface Metric {
  type: "count" | "sum" | "avg" | "min" | "max";
  field?: string;
}

/**
 * Parses a metric descriptor from widget properties (e.g., "count", "sum:total", "avg:rating").
 */
export function parseMetric(raw?: string): Metric {
  if (!raw || raw === "count") {
    return { type: "count" };
  }

  const parts = raw.split(":");
  const kind = parts[0];
  const field = parts[1];

  if (parts.length === 2 && field && ["sum", "avg", "min", "max"].includes(kind!)) {
    return {
      type: kind as Metric["type"],
      field,
    };
  }

  throw new Error(`Invalid metric: ${raw}`);
}

/**
 * Returns true if the client can compute the metric without a specialized backend aggregate endpoint.
 */
export function isClientComputable(metric: Metric): boolean {
  return metric.type === "count";
}
