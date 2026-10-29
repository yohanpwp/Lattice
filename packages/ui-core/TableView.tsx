import { useCallback, useEffect, useRef, useState } from "react";
import type { FieldDefinition, PageDefinition, SchemaDefinition } from "@lattice/types";
import type { ProductClient } from "@lattice/sdk";
import { SchemaRecordModal } from "./SchemaRecordModal";
import { ConfirmModal } from "./ConfirmModal";

export interface TableViewProps {
  client: ProductClient;
  page: PageDefinition;
  schema?: SchemaDefinition;
  initialRecords?: Array<Record<string, unknown>>;
}

export function TableView({ client, page, schema, initialRecords }: TableViewProps) {
  if (!schema) {
    return (
      <div className="lattice-alert-error" role="alert">
        Collection "{page.collection}" is not defined or could not be found.
      </div>
    );
  }

  const schemaId = schema.schema_id;
  const config = page.config ?? {};
  const [records, setRecords] = useState<Array<Record<string, unknown>>>(initialRecords ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [perPage, setPerPage] = useState(config.perPage || 20);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);

  const sortString = config.defaultSort || "-created";
  const initialSort = sortString.startsWith("-") ? sortString.slice(1) : sortString;
  const initialDirection = sortString.startsWith("-") ? "desc" : "asc";

  const [sortField, setSortField] = useState<string>(initialSort);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">(initialDirection);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<Record<string, unknown> | null>(null);
  const [recordToDelete, setRecordToDelete] = useState<Record<string, unknown> | null>(null);

  // Determine which columns to display
  const allDisplayFields = schema.fields.filter((f) => !f.system && f.name !== "id");
  const displayFields =
    Array.isArray(config.columns) && config.columns.length > 0
      ? config.columns
          .map((colName) => allDisplayFields.find((f) => f.name === colName))
          .filter((f): f is FieldDefinition => Boolean(f))
      : allDisplayFields;
  const searchableFields = displayFields.filter((f) =>
    ["text", "email", "url", "select"].includes(f.type),
  );

  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(searchQuery);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 200);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const canCreate = schema.can_create !== false && config.allowCreate !== false;
  const canUpdate = schema.can_update !== false && config.allowEdit !== false;
  const canDelete = schema.can_delete !== false && config.allowDelete !== false;
  const hasActions = canUpdate || canDelete;

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sortParam = sortDirection === "desc" ? `-${sortField}` : sortField;
      const options: Record<string, unknown> = {
        sort: sortParam,
        requestKey: null,
      };

      const trimmed = debouncedSearchQuery.trim();
      let searchFilter = "";
      if (trimmed && searchableFields.length > 0) {
        const clauses = searchableFields.map((f) => `${f.name} ~ {:q}`).join(" || ");
        searchFilter = client.filter(clauses, { q: trimmed });
      }

      if (config.defaultFilter && searchFilter) {
        options.filter = `(${config.defaultFilter}) && (${searchFilter})`;
      } else if (config.defaultFilter) {
        options.filter = config.defaultFilter;
      } else if (searchFilter) {
        options.filter = searchFilter;
      }

      const res = await client.collection(schemaId).getList(pageNumber, perPage, options);
      setRecords(res.items as unknown as Array<Record<string, unknown>>);
      setTotalPages(res.totalPages || 1);
      setTotalItems(res.totalItems || 0);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load collection records");
    } finally {
      setLoading(false);
    }
  }, [client, schemaId, pageNumber, perPage, sortField, sortDirection, config.defaultFilter, debouncedSearchQuery, searchableFields]);

  const loadRecordsRef = useRef(loadRecords);
  loadRecordsRef.current = loadRecords;

  useEffect(() => {
    loadRecords();
  }, [loadRecords]);

  useEffect(() => {
    let unsubscribed = false;
    client
      .collection(schemaId)
      .subscribe("*", () => {
        if (!unsubscribed) {
          loadRecordsRef.current();
        }
      })
      .catch(() => {});

    return () => {
      unsubscribed = true;
      try {
        client.collection(schemaId).unsubscribe("*").catch(() => {});
      } catch {}
    };
  }, [client, schemaId]);

  const filteredRecords = records;

  function handleSort(field: string) {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
    setPageNumber(1);
  }

  async function handleSaveRecord(data: Record<string, unknown>) {
    if (editingRecord && editingRecord.id) {
      if (!canUpdate) return;
      await client.collection(schemaId).update(String(editingRecord.id), data);
    } else {
      if (!canCreate) return;
      await client.collection(schemaId).create(data);
    }
    await loadRecords();
  }

  async function handleConfirmDeleteRecord() {
    if (!canDelete || !recordToDelete || !recordToDelete.id) return;
    try {
      await client.collection(schemaId).delete(String(recordToDelete.id));
      setRecordToDelete(null);
      await loadRecords();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete record");
    }
  }

  return (
    <section className="lattice-schema-view" aria-label={page.name}>
      <header className="lattice-schema-header">
        <div className="lattice-schema-title-area">
          <div className="lattice-schema-icon-large">{page.icon || "📋"}</div>
          <div>
            <h1 className="lattice-schema-heading">{page.name}</h1>
            <p className="lattice-schema-id-badge">
              <code>{schema.schema_id}</code>
              <span className="lattice-badge lattice-badge--pill" style={{ marginLeft: "0.5rem" }}>
                Table View
              </span>
              {page.description && <span className="lattice-schema-desc">— {page.description}</span>}
            </p>
          </div>
        </div>

        <div className="lattice-schema-toolbar">
          <div className="lattice-search-box">
            <input
              type="search"
              placeholder={`Search in ${page.name}…`}
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPageNumber(1);
              }}
              className="lattice-input lattice-search-input"
            />
          </div>

          <button
            type="button"
            className="lattice-btn-secondary"
            onClick={loadRecords}
            title="Refresh records"
          >
            🔄 Refresh
          </button>

          {canCreate && (
            <button
              type="button"
              className="lattice-btn-primary"
              onClick={() => {
                setEditingRecord(null);
                setModalOpen(true);
              }}
            >
              + Add Record
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="lattice-alert-error" role="alert">
          {error}
        </div>
      )}

      {loading && records.length === 0 ? (
        <p className="yp-muted lattice-center-text">Loading {page.name} records…</p>
      ) : filteredRecords.length === 0 ? (
        <div className="lattice-empty-card">
          <p className="lattice-empty-title">No records found</p>
          <p className="yp-muted">
            {records.length === 0
              ? canCreate
                ? `This collection is empty. Click "+ Add Record" to insert your first record.`
                : `This collection is empty.`
              : `No records match "${searchQuery}".`}
          </p>
          {records.length === 0 && canCreate && (
            <button
              type="button"
              className="lattice-btn-primary"
              style={{ marginTop: "1rem" }}
              onClick={() => {
                setEditingRecord(null);
                setModalOpen(true);
              }}
            >
              + Add Record
            </button>
          )}
        </div>
      ) : (
        <div className="lattice-table-wrapper">
          <table className="lattice-table">
            <thead>
              <tr>
                {displayFields.map((field) => {
                  const isSorted = sortField === field.name;
                  return (
                    <th
                      key={field.name}
                      scope="col"
                      className="lattice-th-sortable"
                      onClick={() => handleSort(field.name)}
                      title={`Sort by ${field.label || field.name}`}
                    >
                      <span className="lattice-th-content">
                        {field.label || field.name}
                        {isSorted && (
                          <span className="lattice-sort-indicator">
                            {sortDirection === "asc" ? " ▲" : " ▼"}
                          </span>
                        )}
                      </span>
                    </th>
                  );
                })}
                {hasActions && (
                  <th scope="col" style={{ width: "130px", textAlign: "right" }}>
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {filteredRecords.map((item, idx) => {
                const itemId = String(item.id || idx);
                return (
                  <tr key={itemId}>
                    {displayFields.map((field) => (
                      <td key={field.name}>{renderCellValue(item[field.name], field)}</td>
                    ))}
                    {hasActions && (
                      <td style={{ textAlign: "right" }}>
                        <div className="lattice-table-actions">
                          {canUpdate && (
                            <button
                              type="button"
                              className="lattice-btn-table"
                              onClick={() => {
                                setEditingRecord(item);
                                setModalOpen(true);
                              }}
                            >
                              Edit
                            </button>
                          )}
                          {canDelete && (
                            <button
                              type="button"
                              className="lattice-btn-table lattice-btn-table-danger"
                              onClick={() => setRecordToDelete(item)}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>

          <footer className="lattice-table-footer">
            <div className="lattice-table-info">
              <span>
                Showing {filteredRecords.length} records (Total: {totalItems})
              </span>
              <div className="lattice-per-page-select">
                <label htmlFor="table-per-page">Per page: </label>
                <select
                  id="table-per-page"
                  value={perPage}
                  onChange={(e) => {
                    setPerPage(Number(e.target.value));
                    setPageNumber(1);
                  }}
                  className="lattice-input-select-sm"
                >
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                </select>
              </div>
            </div>

            <div className="lattice-pagination-controls">
              <button
                type="button"
                className="lattice-btn-secondary lattice-btn-sm"
                onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
                disabled={pageNumber <= 1}
              >
                ◀ Previous
              </button>
              <span className="lattice-page-number">
                Page {pageNumber} of {totalPages}
              </span>
              <button
                type="button"
                className="lattice-btn-secondary lattice-btn-sm"
                onClick={() => setPageNumber((p) => Math.min(totalPages, p + 1))}
                disabled={pageNumber >= totalPages}
              >
                Next ▶
              </button>
            </div>
          </footer>
        </div>
      )}

      {/* Record Modal */}
      <SchemaRecordModal
        client={client}
        schema={schema}
        record={editingRecord}
        isOpen={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditingRecord(null);
        }}
        onSave={handleSaveRecord}
      />

      {/* Delete Record Confirmation Modal */}
      <ConfirmModal
        isOpen={Boolean(recordToDelete)}
        title="Delete Record"
        message={`Are you sure you want to delete this record (${recordToDelete?.id || ""})? This action cannot be undone.`}
        confirmLabel="Delete Record"
        confirmVariant="danger"
        onConfirm={handleConfirmDeleteRecord}
        onCancel={() => setRecordToDelete(null)}
      />
    </section>
  );
}

function renderCellValue(value: unknown, field: FieldDefinition) {
  if (value === null || value === undefined || value === "") {
    return <span className="lattice-cell-null">—</span>;
  }

  if (field.type === "bool") {
    return (
      <span className={`lattice-badge ${value ? "lattice-badge--success" : "lattice-badge--muted"}`}>
        {value ? "Yes" : "No"}
      </span>
    );
  }

  if (field.type === "select") {
    return <span className="lattice-badge lattice-badge--pill">{String(value)}</span>;
  }

  if (field.type === "relation") {
    return <span className="lattice-badge lattice-badge--relation">{String(value)}</span>;
  }

  if (field.type === "number") {
    return typeof value === "number" ? value.toLocaleString() : String(value);
  }

  if (field.type === "json") {
    return (
      <code className="lattice-code-inline">
        {typeof value === "object" ? JSON.stringify(value) : String(value)}
      </code>
    );
  }

  return String(value);
}
