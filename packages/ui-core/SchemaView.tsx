import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FieldDefinition, SchemaDefinition } from "@lattice/types";
import type { ProductClient } from "@lattice/sdk";
import { SchemaRecordModal } from "./SchemaRecordModal";
import { ConfirmModal } from "./ConfirmModal";

export interface SchemaViewProps {
  client: ProductClient;
  schema: SchemaDefinition;
  schemas?: SchemaDefinition[];
  onSchemaUpdated?: (updated: SchemaDefinition) => void;
}

interface AddFieldModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (field: FieldDefinition) => Promise<void>;
  existingFieldNames: string[];
}

function AddFieldModal({ isOpen, onClose, onAdd, existingFieldNames }: AddFieldModalProps) {
  const [fieldName, setFieldName] = useState("");
  const [label, setLabel] = useState("");
  const [type, setType] = useState<FieldDefinition["type"]>("text");
  const [options, setOptions] = useState("");
  const [target, setTarget] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setFieldName("");
    setLabel("");
    setType("text");
    setOptions("");
    setTarget("");
    setError(null);
  }, []);

  useEffect(() => {
    if (isOpen) {
      resetForm();
    }
  }, [isOpen, resetForm]);

  if (!isOpen) return null;

  const handleClose = () => {
    resetForm();
    onClose();
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedName = fieldName.trim().toLowerCase();

    if (!trimmedName) {
      setError("Field name is required.");
      return;
    }
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(trimmedName)) {
      setError("Field name must match lowercase letters, digits, and underscores, starting with a letter.");
      return;
    }
    if (existingFieldNames.includes(trimmedName)) {
      setError(`Field name "${trimmedName}" already exists in this schema.`);
      return;
    }

    const field: FieldDefinition = {
      name: trimmedName,
      label: label.trim() || trimmedName,
      type,
      required: false, // New fields on existing datasets must be optional to preserve records
    };

    if (type === "select") {
      const opts = options.split(",").map((s) => s.trim()).filter(Boolean);
      if (opts.length === 0) {
        setError("Select field requires at least one option (comma-separated).");
        return;
      }
      field.options = opts;
    } else if (type === "relation") {
      const trimmedTarget = target.trim().toLowerCase();
      if (!trimmedTarget) {
        setError("Relation field requires a target collection name.");
        return;
      }
      field.target = trimmedTarget;
    }

    setSaving(true);
    try {
      await onAdd(field);
      resetForm();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to add field to schema");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="lattice-modal-overlay" role="dialog" aria-modal="true">
      <div className="lattice-modal-dialog">
        <header className="lattice-modal-header">
          <h2>Add Field to Schema</h2>
          <button type="button" className="lattice-modal-close" onClick={handleClose} aria-label="Close">
            ✕
          </button>
        </header>

        {error && (
          <div className="lattice-alert-error" role="alert">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="lattice-form">
          <div className="lattice-form-grid">
            <div className="lattice-form-group">
              <label htmlFor="new-field-name" className="lattice-form-label">
                Field Identifier (API name) <span className="lattice-req">*</span>
              </label>
              <input
                id="new-field-name"
                type="text"
                className="lattice-input"
                placeholder="e.g. phone, notes, status"
                value={fieldName}
                onChange={(e) => setFieldName(e.target.value)}
                required
              />
            </div>

            <div className="lattice-form-group">
              <label htmlFor="new-field-label" className="lattice-form-label">
                Display Label
              </label>
              <input
                id="new-field-label"
                type="text"
                className="lattice-input"
                placeholder="e.g. Phone Number, Internal Notes"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>

            <div className="lattice-form-group">
              <label htmlFor="new-field-type" className="lattice-form-label">
                Field Type
              </label>
              <select
                id="new-field-type"
                className="lattice-input"
                value={type}
                onChange={(e) => setType(e.target.value as FieldDefinition["type"])}
              >
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="bool">Boolean</option>
                <option value="date">Date</option>
                <option value="select">Select</option>
                <option value="email">Email</option>
                <option value="url">URL</option>
                <option value="relation">Relation</option>
                <option value="json">JSON</option>
              </select>
            </div>

            {type === "select" && (
              <div className="lattice-form-group">
                <label htmlFor="new-field-options" className="lattice-form-label">
                  Allowed Options (comma-separated) <span className="lattice-req">*</span>
                </label>
                <input
                  id="new-field-options"
                  type="text"
                  className="lattice-input"
                  placeholder="e.g. draft, active, archived"
                  value={options}
                  onChange={(e) => setOptions(e.target.value)}
                  required
                />
              </div>
            )}

            {type === "relation" && (
              <div className="lattice-form-group">
                <label htmlFor="new-field-target" className="lattice-form-label">
                  Target Dataset (Table Name) <span className="lattice-req">*</span>
                </label>
                <input
                  id="new-field-target"
                  type="text"
                  className="lattice-input"
                  placeholder="e.g. users, customers, orders"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  required
                />
              </div>
            )}
          </div>

          <p className="yp-muted" style={{ fontSize: "0.75rem", marginTop: "0.5rem" }}>
            Note: Newly added fields to an existing dataset are optional to ensure compatibility with existing records.
          </p>

          <footer className="lattice-modal-footer">
            <button type="button" className="lattice-btn-secondary" onClick={handleClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="lattice-btn-primary" disabled={saving}>
              {saving ? "Adding Field…" : "Add Field"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

export function SchemaView({ client, schema, schemas, onSchemaUpdated }: SchemaViewProps) {
  const [currentSchema, setCurrentSchema] = useState<SchemaDefinition>(schema);
  useEffect(() => {
    setCurrentSchema(schema);
  }, [schema]);

  const [records, setRecords] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(20);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);

  const [modalOpen, setModalOpen] = useState(false);
  const [addFieldModalOpen, setAddFieldModalOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<Record<string, unknown> | null>(null);
  const [recordToDelete, setRecordToDelete] = useState<Record<string, unknown> | null>(null);

  const canCreate = client.hasDatasetPermission(currentSchema.schema_id, "create") && currentSchema.can_create !== false;
  const canUpdate = client.hasDatasetPermission(currentSchema.schema_id, "update") && currentSchema.can_update !== false;
  const canDelete = client.hasDatasetPermission(currentSchema.schema_id, "delete") && currentSchema.can_delete !== false;
  const hasActions = canUpdate || canDelete;

  // Stable memoized field lists to prevent effect infinite loops
  const displayFields = useMemo(
    () => (currentSchema.fields || []).filter((f) => !f.system && f.name !== "id"),
    [currentSchema.fields],
  );

  const searchableFields = useMemo(
    () => displayFields.filter((f) => ["text", "email", "url", "select"].includes(f.type)),
    [displayFields],
  );

  // Compute available sort fields; if dataset does not have 'created', pick first field or 'id'
  const defaultSortField = useMemo(() => {
    if ((currentSchema.fields || []).some((f) => f.name === "created") || currentSchema.created) {
      return "created";
    }
    const firstField = (currentSchema.fields || []).find((f) => !f.system && f.name !== "id");
    return firstField ? firstField.name : "id";
  }, [currentSchema]);

  const [sortField, setSortField] = useState<string>(defaultSortField);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    setSortField(defaultSortField);
  }, [defaultSortField]);

  const [debouncedSearch, setDebouncedSearch] = useState(searchQuery);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 200);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const effectiveSortField = sortField || defaultSortField;
      const sortParam = sortDirection === "desc" ? `-${effectiveSortField}` : effectiveSortField;
      const options: Record<string, unknown> = {
        sort: sortParam,
        requestKey: null,
      };

      const trimmed = debouncedSearch.trim();
      if (trimmed && searchableFields.length > 0) {
        const clauses = searchableFields.map((f) => `${f.name} ~ {:q}`).join(" || ");
        options.filter = client.filter(clauses, { q: trimmed });
      }

      const res = await client.collection(currentSchema.schema_id).getList(page, perPage, options);
      setRecords(res.items as unknown as Array<Record<string, unknown>>);
      setTotalPages(res.totalPages || 1);
      setTotalItems(res.totalItems || 0);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load collection records");
    } finally {
      setLoading(false);
    }
  }, [client, currentSchema.schema_id, page, perPage, sortField, defaultSortField, sortDirection, debouncedSearch, searchableFields]);

  const loadRecordsRef = useRef(loadRecords);
  loadRecordsRef.current = loadRecords;

  useEffect(() => {
    loadRecords();
  }, [loadRecords]);

  useEffect(() => {
    // Subscribe to PocketBase realtime updates for this collection
    let unsubscribed = false;
    client
      .collection(currentSchema.schema_id)
      .subscribe("*", () => {
        if (!unsubscribed) {
          loadRecordsRef.current();
        }
      })
      .catch(() => {
        // Realtime subscription optional if offline
      });

    return () => {
      unsubscribed = true;
      try {
        client.collection(currentSchema.schema_id).unsubscribe("*").catch(() => {});
      } catch {
        // ignore
      }
    };
  }, [client, currentSchema.schema_id]);

  // Reset page when schema changes
  useEffect(() => {
    setPage(1);
    setSearchQuery("");
  }, [currentSchema.schema_id]);

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
      await client.collection(currentSchema.schema_id).update(String(editingRecord.id), data);
    } else {
      await client.collection(currentSchema.schema_id).create(data);
    }
    await loadRecords();
  }

  async function handleConfirmDeleteRecord() {
    if (!recordToDelete || !recordToDelete.id) return;
    try {
      await client.collection(currentSchema.schema_id).delete(String(recordToDelete.id));
      setRecordToDelete(null);
      await loadRecords();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete record");
    }
  }

  async function handleAddField(newField: FieldDefinition) {
    const updatedFields: [FieldDefinition, ...FieldDefinition[]] = [
      ...currentSchema.fields,
      newField,
    ];
    const updatePayload: Partial<SchemaDefinition> = {
      fields: updatedFields,
    };
    if (currentSchema.assignee_field) {
      updatePayload.assignee_field = currentSchema.assignee_field;
    }
    const saved = await client.updateSchema(currentSchema.schema_id, updatePayload);
    setCurrentSchema(saved);
    onSchemaUpdated?.(saved);
    await loadRecords();
  }

  const filteredRecords = records;

  return (
    <section className="lattice-schema-view" aria-label={currentSchema.name}>
      <header className="lattice-schema-header">
        <div className="lattice-schema-title-area">
          <div className="lattice-schema-icon-large">{currentSchema.icon || "📁"}</div>
          <div>
            <h1 className="lattice-schema-heading">{currentSchema.name}</h1>
            <p className="lattice-schema-id-badge">
              <code>{currentSchema.schema_id}</code>
              {currentSchema.description && <span className="lattice-schema-desc">— {currentSchema.description}</span>}
            </p>
          </div>
        </div>

        <div className="lattice-schema-toolbar">
          <div className="lattice-search-box">
            <input
              type="search"
              placeholder={`Search ${currentSchema.name}…`}
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(1);
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

          {client.isOwnerOrAdmin && (
            <button
              type="button"
              className="lattice-btn-secondary"
              onClick={() => setAddFieldModalOpen(true)}
              title="Add a new field to this schema"
            >
              + Add Field
            </button>
          )}

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
        <p className="yp-muted lattice-center-text">Loading {currentSchema.name} records…</p>
      ) : filteredRecords.length === 0 ? (
        <div className="lattice-empty-card">
          <p className="lattice-empty-title">No records found</p>
          <p className="yp-muted">
            {records.length === 0
              ? canCreate
                ? `This collection is empty. Click "+ Add Record" to insert your first record according to the schema.`
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
            <div className="lattice-table-pagination-info">
              Showing page {page} of {totalPages} ({totalItems} total records)
            </div>
            <div className="lattice-table-pagination-controls">
              <button
                type="button"
                className="lattice-btn-table"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </button>
              <button
                type="button"
                className="lattice-btn-table"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </button>
            </div>
          </footer>
        </div>
      )}

      <SchemaRecordModal
        client={client}
        schema={currentSchema}
        schemas={schemas}
        record={editingRecord}
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSave={handleSaveRecord}
      />

      <ConfirmModal
        isOpen={Boolean(recordToDelete)}
        title="Delete Record"
        message={`Are you sure you want to delete record "${String(recordToDelete?.id || "")}"? This action cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onCancel={() => setRecordToDelete(null)}
        onConfirm={handleConfirmDeleteRecord}
      />

      <AddFieldModal
        isOpen={addFieldModalOpen}
        onClose={() => setAddFieldModalOpen(false)}
        onAdd={handleAddField}
        existingFieldNames={(currentSchema.fields || []).map((f) => f.name)}
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
