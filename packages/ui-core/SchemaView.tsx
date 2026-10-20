import { useCallback, useEffect, useState } from "react";
import type { FieldDefinition, SchemaDefinition } from "@lattice/types";
import type { ProductClient } from "@lattice/sdk";
import { SchemaRecordModal } from "./SchemaRecordModal";
import { ConfirmModal } from "./ConfirmModal";

export interface SchemaViewProps {
  client: ProductClient;
  schema: SchemaDefinition;
  onDeleteSchema?: (schemaId: string) => Promise<void>;
}

export function SchemaView({ client, schema, onDeleteSchema }: SchemaViewProps) {
  const [records, setRecords] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(20);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [sortField, setSortField] = useState<string>("created");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  const [modalOpen, setModalOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<Record<string, unknown> | null>(null);
  const [recordToDelete, setRecordToDelete] = useState<Record<string, unknown> | null>(null);
  const [deleteSchemaConfirm, setDeleteSchemaConfirm] = useState(false);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sortParam = sortDirection === "desc" ? `-${sortField}` : sortField;
      const res = await client.collection(schema.schema_id).getList(page, perPage, {
        sort: sortParam,
        requestKey: null,
      });
      setRecords(res.items as unknown as Array<Record<string, unknown>>);
      setTotalPages(res.totalPages || 1);
      setTotalItems(res.totalItems || 0);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load collection records");
    } finally {
      setLoading(false);
    }
  }, [client, schema.schema_id, page, perPage, sortField, sortDirection]);

  useEffect(() => {
    loadRecords();

    // Subscribe to PocketBase realtime updates for this collection
    let unsubscribed = false;
    client
      .collection(schema.schema_id)
      .subscribe("*", () => {
        if (!unsubscribed) {
          loadRecords();
        }
      })
      .catch(() => {
        // Realtime subscription optional if offline
      });

    return () => {
      unsubscribed = true;
      try {
        client.collection(schema.schema_id).unsubscribe("*").catch(() => {});
      } catch {
        // ignore
      }
    };
  }, [client, schema.schema_id, loadRecords]);

  // Reset page when schema changes
  useEffect(() => {
    setPage(1);
    setSearchQuery("");
  }, [schema.schema_id]);

  function handleSort(fieldName: string) {
    if (sortField === fieldName) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(fieldName);
      setSortDirection("asc");
    }
  }

  async function handleSaveRecord(data: Record<string, unknown>) {
    if (editingRecord && editingRecord.id) {
      await client.collection(schema.schema_id).update(String(editingRecord.id), data);
    } else {
      await client.collection(schema.schema_id).create(data);
    }
    await loadRecords();
  }

  async function handleConfirmDeleteRecord() {
    if (!recordToDelete || !recordToDelete.id) return;
    try {
      await client.collection(schema.schema_id).delete(String(recordToDelete.id));
      setRecordToDelete(null);
      await loadRecords();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete record");
    }
  }

  async function handleConfirmDeleteSchema() {
    if (!onDeleteSchema) return;
    try {
      await onDeleteSchema(schema.schema_id);
      setDeleteSchemaConfirm(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete schema");
    }
  }

  const displayFields = schema.fields.filter((f) => !f.system && f.name !== "id");

  const filteredRecords = records.filter((rec) => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    return displayFields.some((f) => {
      const val = rec[f.name];
      if (val === null || val === undefined) return false;
      return String(val).toLowerCase().includes(query);
    });
  });

  return (
    <section className="lattice-schema-view" aria-label={schema.name}>
      <header className="lattice-schema-header">
        <div className="lattice-schema-title-area">
          <div className="lattice-schema-icon-large">{schema.icon || "📁"}</div>
          <div>
            <h1 className="lattice-schema-heading">{schema.name}</h1>
            <p className="lattice-schema-id-badge">
              <code>{schema.schema_id}</code>
              {schema.description && <span className="lattice-schema-desc">— {schema.description}</span>}
            </p>
          </div>
        </div>

        <div className="lattice-schema-toolbar">
          <div className="lattice-search-box">
            <input
              type="search"
              placeholder={`Search ${schema.name}…`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
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

          {onDeleteSchema && (
            <button
              type="button"
              className="lattice-btn-secondary lattice-btn-danger-outline"
              onClick={() => setDeleteSchemaConfirm(true)}
              title="Delete schema"
            >
              🗑 Delete Schema
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
        <p className="yp-muted lattice-center-text">Loading {schema.name} records…</p>
      ) : filteredRecords.length === 0 ? (
        <div className="lattice-empty-card">
          <p className="lattice-empty-title">No records found</p>
          <p className="yp-muted">
            {records.length === 0
              ? `This collection is empty. Click "+ Add Record" to insert your first record according to the schema.`
              : `No records match "${searchQuery}".`}
          </p>
          {records.length === 0 && (
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
                <th scope="col" style={{ width: "130px", textAlign: "right" }}>
                  Actions
                </th>
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
                    <td style={{ textAlign: "right" }}>
                      <div className="lattice-table-actions">
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
                        <button
                          type="button"
                          className="lattice-btn-table lattice-btn-table-danger"
                          onClick={() => setRecordToDelete(item)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
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
                <label htmlFor="per-page">Per page: </label>
                <select
                  id="per-page"
                  value={perPage}
                  onChange={(e) => {
                    setPerPage(Number(e.target.value));
                    setPage(1);
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
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
              >
                ◀ Previous
              </button>
              <span className="lattice-page-number">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                className="lattice-btn-secondary lattice-btn-sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
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

      {/* Delete Schema Confirmation Modal */}
      <ConfirmModal
        isOpen={deleteSchemaConfirm}
        title={`Delete Schema: ${schema.name}`}
        message={`Are you sure you want to delete schema "${schema.name}" (${schema.schema_id})? All records in this collection will be permanently deleted.`}
        confirmLabel="Permanently Delete Schema"
        confirmVariant="danger"
        onConfirm={handleConfirmDeleteSchema}
        onCancel={() => setDeleteSchemaConfirm(false)}
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
