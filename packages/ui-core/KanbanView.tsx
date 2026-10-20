import { useCallback, useEffect, useRef, useState } from "react";
import type { FieldDefinition, PageDefinition, SchemaDefinition } from "@lattice/types";
import type { ProductClient } from "@lattice/sdk";
import { SchemaRecordModal } from "./SchemaRecordModal";
import { ConfirmModal } from "./ConfirmModal";

export interface KanbanViewProps {
  client: ProductClient;
  page: PageDefinition;
  schema?: SchemaDefinition;
}

export function KanbanView({ client, page, schema }: KanbanViewProps) {
  if (!schema) {
    return (
      <div className="lattice-alert-error" role="alert">
        Collection "{page.collection}" is not defined or could not be found.
      </div>
    );
  }

  const schemaId = schema.schema_id;
  const config = page.config ?? {};
  const groupByField = config.groupByField || "status";
  const groupFieldDef = schema.fields.find((f) => f.name === groupByField);

  const [records, setRecords] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<Record<string, unknown> | null>(null);
  const [initialRecordValues, setInitialRecordValues] = useState<Record<string, unknown>>({});
  const [recordToDelete, setRecordToDelete] = useState<Record<string, unknown> | null>(null);

  const canCreate = schema.can_create !== false && config.allowCreate !== false;
  const canUpdate = schema.can_update !== false && config.allowEdit !== false;
  const canDelete = schema.can_delete !== false && config.allowDelete !== false;

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const options: Record<string, unknown> = {
        sort: config.defaultSort || "-created",
        requestKey: null,
      };
      if (config.defaultFilter) {
        options.filter = config.defaultFilter;
      }
      const res = await client.collection(schemaId).getList(1, 100, options);
      setRecords(res.items as unknown as Array<Record<string, unknown>>);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load kanban records");
    } finally {
      setLoading(false);
    }
  }, [client, schemaId, config.defaultSort, config.defaultFilter]);

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

  // Determine lanes/columns
  let lanes: string[] = [];
  if (groupFieldDef?.options && groupFieldDef.options.length > 0) {
    lanes = [...groupFieldDef.options];
  } else {
    // Collect distinct values from current records
    const distinct = new Set<string>();
    for (const r of records) {
      const val = r[groupByField];
      if (val !== undefined && val !== null && String(val).trim() !== "") {
        distinct.add(String(val));
      }
    }
    lanes = distinct.size > 0 ? Array.from(distinct) : ["todo", "in_progress", "done"];
  }

  // Include any extra status values present in records not in options so no records are hidden
  const laneSet = new Set(lanes);
  for (const r of records) {
    const val = String(r[groupByField] ?? "").trim();
    if (val && !laneSet.has(val)) {
      lanes.push(val);
      laneSet.add(val);
    }
  }

  // Check if any records have empty status
  const hasUnassigned = records.some((r) => !String(r[groupByField] ?? "").trim());
  if (hasUnassigned && !laneSet.has("")) {
    lanes.push("");
  }

  // Card fields to display
  const allFields = schema.fields.filter((f) => !f.system && f.name !== "id" && f.name !== groupByField);
  const cardFields =
    Array.isArray(config.cardFields) && config.cardFields.length > 0
      ? config.cardFields
          .map((colName) => allFields.find((f) => f.name === colName))
          .filter((f): f is FieldDefinition => Boolean(f))
      : allFields.slice(0, 3);

  async function handleStatusChange(recordId: string, newStatus: string) {
    if (!canUpdate) return;
    try {
      await client.collection(schemaId).update(recordId, { [groupByField]: newStatus });
      await loadRecords();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update record status");
    }
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

  function handleOpenCreate(lane: string) {
    if (!canCreate) return;
    setEditingRecord(null);
    setInitialRecordValues({ [groupByField]: lane });
    setModalOpen(true);
  }

  return (
    <section className="lattice-kanban-view" aria-label={page.name}>
      <header className="lattice-schema-header">
        <div className="lattice-schema-title-area">
          <div className="lattice-schema-icon-large">{page.icon || "📌"}</div>
          <div>
            <h1 className="lattice-schema-heading">{page.name}</h1>
            <p className="lattice-schema-id-badge">
              <code>{schema.schema_id}</code>
              <span className="lattice-badge lattice-badge--pill" style={{ marginLeft: "0.5rem" }}>
                Kanban View ({groupByField})
              </span>
              {page.description && <span className="lattice-schema-desc">— {page.description}</span>}
            </p>
          </div>
        </div>

        <div className="lattice-schema-toolbar">
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
              onClick={() => handleOpenCreate(lanes[0] || "")}
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
        <p className="yp-muted lattice-center-text">Loading {page.name} board…</p>
      ) : (
        <div className="lattice-kanban-board">
          {lanes.map((lane) => {
            const laneRecords = records.filter((r) => String(r[groupByField] ?? "") === lane);
            return (
              <div key={lane} className="lattice-kanban-column">
                <div className="lattice-kanban-column-header">
                  <div className="lattice-kanban-column-title">
                    <span className="lattice-kanban-lane-name">{lane || "Unassigned"}</span>
                    <span className="lattice-kanban-count-badge">{laneRecords.length}</span>
                  </div>
                  {canCreate && (
                    <button
                      type="button"
                      className="lattice-btn-table"
                      onClick={() => handleOpenCreate(lane)}
                      title={`Add record to ${lane || "Unassigned"}`}
                    >
                      +
                    </button>
                  )}
                </div>

                <div className="lattice-kanban-column-content">
                  {laneRecords.map((item) => {
                    const itemId = String(item.id);
                    return (
                      <div key={itemId} className="lattice-kanban-card">
                        <div className="lattice-kanban-card-header">
                          <span className="lattice-kanban-card-id">#{itemId.slice(-6)}</span>
                          <div className="lattice-kanban-card-actions">
                            {canUpdate && (
                              <button
                                type="button"
                                className="lattice-btn-link-sm"
                                onClick={() => {
                                  setEditingRecord(item);
                                  setInitialRecordValues({});
                                  setModalOpen(true);
                                }}
                              >
                                Edit
                              </button>
                            )}
                            {canDelete && (
                              <button
                                type="button"
                                className="lattice-btn-link-sm lattice-btn-danger-text"
                                onClick={() => setRecordToDelete(item)}
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="lattice-kanban-card-body">
                          {cardFields.map((field) => (
                            <div key={field.name} className="lattice-kanban-field-row">
                              <span className="lattice-kanban-field-label">
                                {field.label || field.name}:
                              </span>
                              <span className="lattice-kanban-field-value">
                                {renderCardValue(item[field.name])}
                              </span>
                            </div>
                          ))}
                        </div>

                        {canUpdate && lanes.length > 1 && (
                          <div className="lattice-kanban-card-footer">
                            <label className="lattice-kanban-move-label">Move to:</label>
                            <select
                              value={lane}
                              onChange={(e) => handleStatusChange(itemId, e.target.value)}
                              className="lattice-input-select-sm"
                            >
                              {lanes.map((l) => (
                                <option key={l} value={l}>
                                  {l}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {laneRecords.length === 0 && (
                    <div className="lattice-kanban-empty-lane">Empty lane</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Record Modal */}
      <SchemaRecordModal
        client={client}
        schema={schema}
        record={editingRecord ? { ...initialRecordValues, ...editingRecord } : initialRecordValues}
        isOpen={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditingRecord(null);
          setInitialRecordValues({});
        }}
        onSave={handleSaveRecord}
      />

      {/* Delete Record Confirmation Modal */}
      <ConfirmModal
        isOpen={Boolean(recordToDelete)}
        title="Delete Record"
        message={`Are you sure you want to delete this record (${recordToDelete?.id || ""})?`}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={handleConfirmDeleteRecord}
        onCancel={() => setRecordToDelete(null)}
      />
    </section>
  );
}

function renderCardValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
