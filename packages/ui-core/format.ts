/**
 * Formatting and extraction helpers for widget views (tables, lists, KPI).
 */

export function displayValue(val: unknown): string {
  if (val === null || val === undefined) {
    return "";
  }
  if (typeof val === "boolean") {
    return val ? "true" : "false";
  }
  if (typeof val === "object") {
    return JSON.stringify(val);
  }
  return String(val);
}

export function columnsFor(
  items: ReadonlyArray<Record<string, unknown>>,
  fields?: readonly string[],
): string[] {
  if (fields && fields.length > 0) {
    return [...new Set(fields)];
  }

  const set = new Set<string>();
  for (const item of items) {
    for (const key of Object.keys(item)) {
      set.add(key);
    }
  }

  const columns = Array.from(set);
  const idIndex = columns.indexOf("id");
  if (idIndex > 0) {
    columns.splice(idIndex, 1);
    columns.unshift("id");
  }
  return columns;
}

export function rowLabel(item: Record<string, unknown>): string {
  for (const key of ["name", "title", "label", "id"]) {
    const val = item[key];
    if (val !== undefined && val !== null && String(val).trim() !== "") {
      return String(val);
    }
  }

  const firstVal = Object.values(item).find((v) => v !== undefined && v !== null);
  if (firstVal !== undefined) {
    return displayValue(firstVal);
  }
  return "—";
}
