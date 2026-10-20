import { useCallback, useEffect, useState } from "react";
import type { FieldDefinition, PageDefinition, SchemaDefinition } from "@lattice/types";
import type { ProductClient } from "@lattice/sdk";
import { SchemaRecordModal } from "./SchemaRecordModal";
import { ConfirmModal } from "./ConfirmModal";

export interface MasterDetailViewProps {
  client: ProductClient;
  page: PageDefinition;
  masterSchema?: SchemaDefinition;
  allSchemas: SchemaDefinition[];
}

export function MasterDetailView({
  client,
  page,
  masterSchema,
  allSchemas,
}: MasterDetailViewProps) {
  if (!masterSchema) {
    return (
      <div className="lattice-alert-error" role="alert">
        Master Collection "{page.collection}" is not defined or could not be found.
      </div>
    );
  }

  const config = page.config ?? {};
  const detailCollectionName = config.detailCollection;
  const detailSchema = detailCollectionName
    ? allSchemas.find((s) => s.schema_id === detailCollectionName)
    : undefined;
  const relationField = config.relationField || `${masterSchema.schema_id}_id`;

  // Master records state
  const [masterRecords, setMasterRecords] = useState<Array<Record<string, unknown>>>([]);
  const [selectedMaster, setSelectedMaster] = useState<Record<string, unknown> | null>(null);
  const [loadingMaster, setLoadingMaster] = useState(true);
  const [masterSearch, setMasterSearch] = useState("");

  // Detail records state
  const [detailRecords, setDetailRecords] = useState<Array<Record<string, unknown>>>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Modals state
  const [masterModalOpen, setMasterModalOpen] = useState(false);
  const [editingMaster, setEditingMaster] = useState<Record<string, unknown> | null>(null);

  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [editingDetail, setEditingDetail] = useState<Record<string, unknown> | null>(null);
  const [detailPreset, setDetailPreset] = useState<Record<string, unknown>>({});

  const [deleteConfirmTarget, setDeleteConfirmTarget] = useState<{
    schemaId: string;
    id: string;
    type: "master" | "detail";
  } | null>(null);

  // Master permissions
  const masterCanCreate = masterSchema.can_create !== false && config.allowCreate !== false;
  const masterCanUpdate = masterSchema.can_update !== false && config.allowEdit !== false;
  const masterCanDelete = masterSchema.can_delete !== false && config.allowDelete !== false;

  // Detail permissions
  const detailCanCreate = detailSchema ? detailSchema.can_create !== false : false;
  const detailCanUpdate = detailSchema ? detailSchema.can_update !== false : false;
  const detailCanDelete = detailSchema ? detailSchema.can_delete !== false : false;

  // Load master records
  const loadMasterRecords = useCallback(async () => {
    setLoadingMaster(true);
    try {
      const res = await client.collection(masterSchema.schema_id).getList(1, 50, {
        sort: config.defaultSort || "-created",
        requestKey: null,
      });
      const items = res.items as unknown as Array<Record<string, unknown>>;
      setMasterRecords(items);
      setSelectedMaster((prev) => prev ?? items[0] ?? null);
    } catch {
      // Ignore
    } finally {
      setLoadingMaster(false);
    }
  }, [client, masterSchema.schema_id, config.defaultSort]);

  // Load detail records when selectedMaster changes
  const loadDetailRecords = useCallback(async () => {
    if (!detailSchema || !selectedMaster || !selectedMaster.id) {
      setDetailRecords([]);
      return;
    }
    setLoadingDetail(true);
    try {
      const filter = client.filter(`${relationField} = {:masterId}`, {
        masterId: selectedMaster.id,
      });
      const res = await client.collection(detailSchema.schema_id).getList(1, 50, {
        filter,
        sort: "-created",
        requestKey: null,
      });
      setDetailRecords(res.items as unknown as Array<Record<string, unknown>>);
    } catch {
      setDetailRecords([]);
    } finally {
      setLoadingDetail(false);
    }
  }, [client, detailSchema, selectedMaster, relationField]);

  useEffect(() => {
    loadMasterRecords();

    let unsubscribed = false;
    client
      .collection(masterSchema.schema_id)
      .subscribe("*", () => {
        if (!unsubscribed) {
          loadMasterRecords();
        }
      })
      .catch(() => {});

    return () => {
      unsubscribed = true;
      try {
        client.collection(masterSchema.schema_id).unsubscribe("*").catch(() => {});
      } catch {}
    };
  }, [client, masterSchema.schema_id, loadMasterRecords]);

  useEffect(() => {
    loadDetailRecords();

    if (!detailSchema) return;
    let unsubscribed = false;
    client
      .collection(detailSchema.schema_id)
      .subscribe("*", () => {
        if (!unsubscribed) {
          loadDetailRecords();
        }
      })
      .catch(() => {});

    return () => {
      unsubscribed = true;
      try {
        client.collection(detailSchema.schema_id).unsubscribe("*").catch(() => {});
      } catch {}
    };
  }, [client, detailSchema, loadDetailRecords]);

  const masterDisplayFields = masterSchema.fields.filter((f) => !f.system && f.name !== "id");
  const filteredMasters = masterRecords.filter((rec) => {
    if (!masterSearch.trim()) return true;
    const query = masterSearch.toLowerCase();
    return masterDisplayFields.some((f) => {
      const val = rec[f.name];
      if (val === null || val === undefined) return false;
      return String(val).toLowerCase().includes(query);
    });
  });

  const detailDisplayFields = detailSchema
    ? detailSchema.fields.filter(
        (f) => !f.system && f.name !== "id" && f.name !== relationField,
      )
    : [];

  async function handleSaveMaster(data: Record<string, unknown>) {
    if (editingMaster && editingMaster.id) {
      if (!masterCanUpdate) return;
      await client.collection(masterSchema!.schema_id).update(String(editingMaster.id), data);
    } else {
      if (!masterCanCreate) return;
      const created = await client.collection(masterSchema!.schema_id).create(data);
      setSelectedMaster(created as unknown as Record<string, unknown>);
    }
    await loadMasterRecords();
  }

  async function handleSaveDetail(data: Record<string, unknown>) {
    if (!detailSchema) return;
    if (editingDetail && editingDetail.id) {
      if (!detailCanUpdate) return;
      await client.collection(detailSchema.schema_id).update(String(editingDetail.id), data);
    } else {
      if (!detailCanCreate) return;
      await client.collection(detailSchema.schema_id).create(data);
    }
    await loadDetailRecords();
  }

  async function handleConfirmDelete() {
    if (!deleteConfirmTarget) return;
    try {
      await client.collection(deleteConfirmTarget.schemaId).delete(deleteConfirmTarget.id);
      if (deleteConfirmTarget.type === "master") {
        if (selectedMaster?.id === deleteConfirmTarget.id) {
          setSelectedMaster(null);
        }
        await loadMasterRecords();
      } else {
        await loadDetailRecords();
      }
    } catch {}
    setDeleteConfirmTarget(null);
  }

  return (
    <section className="lattice-master-detail-view" aria-label={page.name}>
      <header className="lattice-schema-header">
        <div className="lattice-schema-title-area">
          <div className="lattice-schema-icon-large">{page.icon || "📂"}</div>
          <div>
            <h1 className="lattice-schema-heading">{page.name}</h1>
            <p className="lattice-schema-id-badge">
              <code>{masterSchema.schema_id}</code>
              {detailSchema && <span> ➔ <code>{detailSchema.schema_id}</code></span>}
              <span className="lattice-badge lattice-badge--pill" style={{ marginLeft: "0.5rem" }}>
                Master-Detail View
              </span>
            </p>
          </div>
        </div>

        <div className="lattice-schema-toolbar">
          {masterCanCreate && (
            <button
              type="button"
              className="lattice-btn-primary"
              onClick={() => {
                setEditingMaster(null);
                setMasterModalOpen(true);
              }}
            >
              + Add {masterSchema.name}
            </button>
          )}
        </div>
      </header>

      <div className="lattice-master-detail-grid">
        {/* Left Side: Master List */}
        <div className="lattice-master-list-panel">
          <div className="lattice-master-search-bar">
            <input
              type="search"
              placeholder={`Search ${masterSchema.name}…`}
              value={masterSearch}
              onChange={(e) => setMasterSearch(e.target.value)}
              className="lattice-input lattice-search-input"
            />
          </div>

          <div className="lattice-master-items">
            {loadingMaster && masterRecords.length === 0 ? (
              <p className="yp-muted lattice-center-text">Loading items…</p>
            ) : filteredMasters.length === 0 ? (
              <p className="yp-muted lattice-center-text">No records found.</p>
            ) : (
              filteredMasters.map((item) => {
                const isSelected = selectedMaster?.id === item.id;
                const primaryField = masterDisplayFields[0];
                const primaryValue = primaryField ? item[primaryField.name] : item.id;
                return (
                  <div
                    key={String(item.id)}
                    className={`lattice-master-card ${isSelected ? "lattice-master-card--active" : ""}`}
                    onClick={() => setSelectedMaster(item)}
                  >
                    <div className="lattice-master-card-title">
                      <strong>{primaryValue ? String(primaryValue) : `Record #${String(item.id).slice(-4)}`}</strong>
                    </div>
                    <div className="lattice-master-card-sub">
                      ID: {String(item.id).slice(-6)}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Side: Detail & Related Items */}
        <div className="lattice-detail-panel">
          {selectedMaster ? (
            <div>
              <div className="lattice-detail-header-card">
                <div className="lattice-detail-header-info">
                  <h2>{String(selectedMaster[masterDisplayFields[0]?.name || "id"] ?? selectedMaster.id)}</h2>
                  <p className="yp-muted">Record ID: {String(selectedMaster.id)}</p>
                </div>
                <div className="lattice-detail-header-actions">
                  {masterCanUpdate && (
                    <button
                      type="button"
                      className="lattice-btn-secondary"
                      onClick={() => {
                        setEditingMaster(selectedMaster);
                        setMasterModalOpen(true);
                      }}
                    >
                      Edit Master
                    </button>
                  )}
                  {masterCanDelete && (
                    <button
                      type="button"
                      className="lattice-btn-secondary lattice-btn-danger-outline"
                      onClick={() =>
                        setDeleteConfirmTarget({
                          schemaId: masterSchema.schema_id,
                          id: String(selectedMaster.id),
                          type: "master",
                        })
                      }
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>

              {/* Master fields summary */}
              <div className="lattice-detail-fields-grid">
                {masterDisplayFields.map((field) => (
                  <div key={field.name} className="lattice-detail-field-item">
                    <span className="lattice-detail-field-label">{field.label || field.name}</span>
                    <span className="lattice-detail-field-val">
                      {renderFieldValue(selectedMaster[field.name], field)}
                    </span>
                  </div>
                ))}
              </div>

              {/* Related Detail Collection Section */}
              {detailSchema && (
                <div className="lattice-detail-relation-section">
                  <div className="lattice-detail-relation-header">
                    <h3>Related {detailSchema.name}</h3>
                    {detailCanCreate && (
                      <button
                        type="button"
                        className="lattice-btn-primary lattice-btn-sm"
                        onClick={() => {
                          setEditingDetail(null);
                          setDetailPreset({ [relationField]: selectedMaster.id });
                          setDetailModalOpen(true);
                        }}
                      >
                        + Add {detailSchema.name}
                      </button>
                    )}
                  </div>

                  {loadingDetail ? (
                    <p className="yp-muted">Loading related items…</p>
                  ) : detailRecords.length === 0 ? (
                    <p className="yp-muted">No related {detailSchema.name} records found.</p>
                  ) : (
                    <table className="lattice-table">
                      <thead>
                        <tr>
                          {detailDisplayFields.map((f) => (
                            <th key={f.name}>{f.label || f.name}</th>
                          ))}
                          {(detailCanUpdate || detailCanDelete) && <th>Actions</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {detailRecords.map((dItem) => (
                          <tr key={String(dItem.id)}>
                            {detailDisplayFields.map((f) => (
                              <td key={f.name}>{renderFieldValue(dItem[f.name], f)}</td>
                            ))}
                            {(detailCanUpdate || detailCanDelete) && (
                              <td>
                                <div className="lattice-table-actions">
                                  {detailCanUpdate && (
                                    <button
                                      type="button"
                                      className="lattice-btn-table"
                                      onClick={() => {
                                        setEditingDetail(dItem);
                                        setDetailPreset({});
                                        setDetailModalOpen(true);
                                      }}
                                    >
                                      Edit
                                    </button>
                                  )}
                                  {detailCanDelete && (
                                    <button
                                      type="button"
                                      className="lattice-btn-table lattice-btn-table-danger"
                                      onClick={() =>
                                        setDeleteConfirmTarget({
                                          schemaId: detailSchema.schema_id,
                                          id: String(dItem.id),
                                          type: "detail",
                                        })
                                      }
                                    >
                                      Delete
                                    </button>
                                  )}
                                </div>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="lattice-empty-card">
              <p className="yp-muted">Select an item from the left to view details.</p>
            </div>
          )}
        </div>
      </div>

      {/* Master Record Modal */}
      <SchemaRecordModal
        client={client}
        schema={masterSchema}
        record={editingMaster}
        isOpen={masterModalOpen}
        onClose={() => {
          setMasterModalOpen(false);
          setEditingMaster(null);
        }}
        onSave={handleSaveMaster}
      />

      {/* Detail Record Modal */}
      {detailSchema && (
        <SchemaRecordModal
          client={client}
          schema={detailSchema}
          record={editingDetail ? { ...detailPreset, ...editingDetail } : detailPreset}
          isOpen={detailModalOpen}
          onClose={() => {
            setDetailModalOpen(false);
            setEditingDetail(null);
            setDetailPreset({});
          }}
          onSave={handleSaveDetail}
        />
      )}

      {/* Delete Confirmation Modal */}
      <ConfirmModal
        isOpen={Boolean(deleteConfirmTarget)}
        title="Confirm Deletion"
        message="Are you sure you want to delete this record? This action cannot be undone."
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteConfirmTarget(null)}
      />
    </section>
  );
}

function renderFieldValue(value: unknown, field: FieldDefinition) {
  if (value === null || value === undefined || value === "") return "—";
  if (field.type === "bool") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
