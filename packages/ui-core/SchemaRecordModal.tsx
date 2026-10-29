import { useCallback, useEffect, useMemo, useState } from "react";
import type { FieldDefinition, SchemaDefinition } from "@lattice/types";
import type { ProductClient } from "@lattice/sdk";

export interface SchemaRecordModalProps {
  client?: ProductClient;
  schema: SchemaDefinition;
  record?: Record<string, unknown> | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
  schemas?: SchemaDefinition[];
}

interface RelationOption {
  id: string;
  label: string;
}

interface RelationPickerProps {
  id: string;
  field: FieldDefinition;
  client?: ProductClient;
  value: string;
  onChange: (val: string) => void;
  required?: boolean;
  schemas?: SchemaDefinition[];
}

export function RelationPicker({ id, field, client, value, onChange, required, schemas }: RelationPickerProps) {
  const [items, setItems] = useState<RelationOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [manualMode, setManualMode] = useState(false);

  const effectiveTargetSchema = useMemo(() => {
    if (!field.target || field.target === "users") return null;
    return (schemas || []).find((s) => s.schema_id === field.target || s.name === field.target) || null;
  }, [schemas, field.target]);

  const [remoteSchema, setRemoteSchema] = useState<SchemaDefinition | null>(null);

  useEffect(() => {
    if (effectiveTargetSchema || !field.target || field.target === "users" || !client) return;
    let active = true;
    client
      .getSchema(field.target)
      .then((s) => {
        if (active) setRemoteSchema(s);
      })
      .catch(() => {
        // ignore if target is a custom PocketBase collection without schema metadata
      });
    return () => {
      active = false;
    };
  }, [effectiveTargetSchema, field.target, client]);

  const targetSchema = effectiveTargetSchema || remoteSchema;

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!client || !field.target) return;
    let cancelled = false;

    async function fetchPage() {
      setLoading(true);
      setError(null);
      try {
        const options: Record<string, unknown> = {
          requestKey: null,
        };
        const trimmed = debouncedSearch.trim();
        if (trimmed) {
          if (field.target === "users") {
            options.filter = client!.filter("name ~ {:q} || email ~ {:q} || id ~ {:q}", { q: trimmed });
          } else if (targetSchema?.fields && targetSchema.fields.length > 0) {
            const searchable = targetSchema.fields
              .filter((f) => !f.system && f.name !== "id" && ["text", "email", "url", "select"].includes(f.type))
              .map((f) => f.name);
            const clauses = ["id ~ {:q}", ...searchable.map((name) => `${name} ~ {:q}`)].join(" || ");
            options.filter = client!.filter(clauses, { q: trimmed });
          } else {
            options.filter = client!.filter("id ~ {:q}", { q: trimmed });
          }
        }

        const res = await client!.collection(field.target!).getList(page, 20, options);
        if (cancelled) return;

        const getItemLabel = (item: Record<string, unknown>): string => {
          if (targetSchema?.fields) {
            const textFields = targetSchema.fields.filter(
              (f) => !f.system && f.name !== "id" && ["text", "email"].includes(f.type)
            );
            for (const f of textFields) {
              const val = item[f.name];
              if (val !== undefined && val !== null && String(val).trim() !== "") {
                return String(val);
              }
            }
          }
          return String(item.name || item.title || item.label || item.code || item.id);
        };

        const mapped: RelationOption[] = res.items.map((item) => ({
          id: item.id,
          label: getItemLabel(item as unknown as Record<string, unknown>),
        }));

        // If the current value is not in the page results, fetch that record directly so it remains selectable
        if (value && !mapped.some((m) => m.id === value)) {
          try {
            const currentItem = await client!.collection(field.target!).getOne(value);
            if (!cancelled && currentItem) {
              mapped.unshift({
                id: currentItem.id,
                label: getItemLabel(currentItem as unknown as Record<string, unknown>),
              });
            }
          } catch {
            // Keep existing value as ID
          }
        }

        setItems(mapped);
        setTotalPages(res.totalPages || 1);
        setTotalItems(res.totalItems || 0);
      } catch (err: unknown) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Failed to load options";
          setError(msg);
          setItems([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchPage();
    return () => {
      cancelled = true;
    };
  }, [client, field.target, page, debouncedSearch, value, targetSchema]);

  if (!client || manualMode) {
    return (
      <div className="lattice-relation-manual">
        <input
          id={id}
          type="text"
          className="lattice-input"
          placeholder="Enter Record ID"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={required}
        />
        {client && (
          <button
            type="button"
            className="lattice-btn-link"
            style={{ fontSize: "0.8rem", marginTop: "0.25rem", display: "inline-block" }}
            onClick={() => setManualMode(false)}
          >
            Switch to picker list
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="lattice-relation-picker">
      <div className="lattice-relation-search-row" style={{ display: "flex", gap: "0.5rem", marginBottom: "0.35rem" }}>
        <input
          type="search"
          className="lattice-input"
          style={{ fontSize: "0.85rem", padding: "0.25rem 0.5rem" }}
          placeholder={`Search ${field.target}…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="yp-muted" style={{ fontSize: "0.85rem", padding: "0.35rem 0" }}>
          Loading {field.target} records…
        </div>
      ) : error ? (
        <div className="lattice-alert-error" style={{ fontSize: "0.8rem", padding: "0.35rem 0.5rem", marginBottom: "0.35rem" }}>
          <span>Failed to load: {error}</span>
          <button
            type="button"
            className="lattice-btn-link"
            style={{ marginLeft: "0.5rem", color: "inherit", textDecoration: "underline" }}
            onClick={() => setManualMode(true)}
          >
            Enter ID manually
          </button>
        </div>
      ) : totalItems === 0 && !debouncedSearch ? (
        <div className="yp-muted" style={{ fontSize: "0.85rem", padding: "0.35rem 0" }}>
          Dataset "{field.target}" has no records yet.
          <button
            type="button"
            className="lattice-btn-link"
            style={{ marginLeft: "0.5rem" }}
            onClick={() => setManualMode(true)}
          >
            Enter ID manually
          </button>
        </div>
      ) : (
        <>
          <select
            id={id}
            className="lattice-input"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            required={required}
          >
            <option value="">-- Select related {field.target || field.name} --</option>
            {value && !items.some((i) => i.id === value) && (
              <option value={value}>{value} (Selected)</option>
            )}
            {items.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label} ({opt.id})
              </option>
            ))}
          </select>

          {totalPages > 1 && (
            <div
              className="lattice-relation-pagination"
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginTop: "0.25rem",
                fontSize: "0.75rem",
              }}
            >
              <button
                type="button"
                className="lattice-btn-table"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ◀ Prev
              </button>
              <span className="yp-muted">
                Page {page} of {totalPages} ({totalItems} records)
              </span>
              <button
                type="button"
                className="lattice-btn-table"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next ▶
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function SchemaRecordModal({
  client,
  schema,
  record,
  isOpen,
  onClose,
  onSave,
  schemas,
}: SchemaRecordModalProps) {
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editableFields = useMemo(
    () => (schema.fields || []).filter(
      (f) => !f.system && f.name !== "id" && f.name !== "created" && f.name !== "updated",
    ),
    [schema.fields],
  );

  const isAssignedMember = useMemo(() => {
    if (!client) return false;
    if (client.isOwnerOrAdmin) return false;
    const scope = client.getDatasetScope?.(schema.schema_id);
    if (scope === "assigned") return true;
    const authRec = client.authStore?.record as { role?: string; permissions?: Record<string, { scope?: string }> } | null;
    return authRec?.role === "member" && authRec?.permissions?.[schema.schema_id]?.scope === "assigned";
  }, [client, schema.schema_id]);

  const isAssigneeField = (fieldName: string) => {
    return Boolean(schema.assignee_field && schema.assignee_field === fieldName);
  };

  const resetForm = useCallback(() => {
    if (record) {
      setFormData({ ...record });
    } else {
      const initial: Record<string, unknown> = {};
      for (const field of editableFields) {
        if (field.type === "bool") {
          initial[field.name] = false;
        } else if (field.type === "number") {
          initial[field.name] = "";
        } else {
          initial[field.name] = "";
        }
      }
      setFormData(initial);
    }
    setError(null);
  }, [record, editableFields]);

  // Reset form whenever opening modal or when record/schema changes
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
    setSaving(true);

    try {
      const payload: Record<string, unknown> = {};
      for (const field of editableFields) {
        let val = formData[field.name];

        // For assigned-scope members on the assignee relation field,
        // prefill/satisfy with the current user ID or omit so server auto-assignment runs.
        if (isAssignedMember && isAssigneeField(field.name)) {
          const currentUserId = client?.currentUserId || client?.authStore?.record?.id;
          if (currentUserId) {
            val = currentUserId;
          }
          // Do not fail required validation for auto-assigned field
        } else if (field.required && (val === "" || val === undefined || val === null)) {
          throw new Error(`Field "${field.label || field.name}" is required`);
        }

        if (field.type === "number" && val !== "" && val !== undefined && val !== null) {
          payload[field.name] = Number(val);
        } else if (field.type === "bool") {
          payload[field.name] = Boolean(val);
        } else if (field.type === "json" && typeof val === "string" && val.trim() !== "") {
          try {
            payload[field.name] = JSON.parse(val);
          } catch {
            throw new Error(`Field "${field.label || field.name}" must be valid JSON`);
          }
        } else if (val !== undefined && val !== null) {
          payload[field.name] = val;
        }
      }

      await onSave(payload);
      resetForm();
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to save record";
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="lattice-modal-overlay" role="dialog" aria-modal="true">
      <div className="lattice-modal-dialog">
        <header className="lattice-modal-header">
          <h2>{record ? `Edit ${schema.name} Record` : `Add New ${schema.name}`}</h2>
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
            {editableFields.map((field) => {
              const id = `field-${field.name}`;

              // If this is the assignee field for an assigned member, display auto-assignment banner
              if (isAssignedMember && isAssigneeField(field.name)) {
                const authUser = client?.authStore?.record as { name?: string; email?: string; id?: string } | null;
                const displayName = authUser?.name || authUser?.email || authUser?.id || "Current User";
                return (
                  <div key={field.name} className="lattice-form-group">
                    <label htmlFor={id} className="lattice-form-label">
                      {field.label || field.name}
                    </label>
                    <div
                      className="lattice-assigned-badge"
                      style={{
                        padding: "0.5rem 0.75rem",
                        background: "rgba(100, 150, 255, 0.1)",
                        border: "1px solid rgba(100, 150, 255, 0.3)",
                        borderRadius: "4px",
                        fontSize: "0.85rem",
                      }}
                    >
                      👤 <strong>Assigned to you:</strong> {displayName}
                      <div className="yp-muted" style={{ fontSize: "0.75rem", marginTop: "0.2rem" }}>
                        This record will automatically be assigned to your account upon creation.
                      </div>
                    </div>
                  </div>
                );
              }

              return (
                <div key={field.name} className="lattice-form-group">
                  <label htmlFor={id} className="lattice-form-label">
                    {field.label || field.name}
                    {field.required && <span className="lattice-req">*</span>}
                    {field.type === "relation" && field.target && (
                      <span className="lattice-field-hint"> → {field.target}</span>
                    )}
                  </label>

                  {field.type === "select" ? (
                    <select
                      id={id}
                      className="lattice-input"
                      value={String(formData[field.name] ?? "")}
                      onChange={(e) => setFormData({ ...formData, [field.name]: e.target.value })}
                      required={field.required}
                    >
                      <option value="">-- Select {field.label || field.name} --</option>
                      {(field.options || []).map((opt) => (
                        <option key={opt} value={opt}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  ) : field.type === "relation" ? (
                    <RelationPicker
                      id={id}
                      field={field}
                      client={client}
                      value={String(formData[field.name] ?? "")}
                      onChange={(val) => setFormData({ ...formData, [field.name]: val })}
                      required={field.required}
                      schemas={schemas}
                    />
                  ) : field.type === "bool" ? (
                    <div className="lattice-checkbox-wrapper">
                      <input
                        id={id}
                        type="checkbox"
                        checked={Boolean(formData[field.name])}
                        onChange={(e) => setFormData({ ...formData, [field.name]: e.target.checked })}
                      />
                      <span className="lattice-checkbox-label">
                        {Boolean(formData[field.name]) ? "Yes / Enabled" : "No / Disabled"}
                      </span>
                    </div>
                  ) : field.type === "number" ? (
                    <input
                      id={id}
                      type="number"
                      step="any"
                      className="lattice-input"
                      value={formData[field.name] !== undefined ? String(formData[field.name]) : ""}
                      onChange={(e) => setFormData({ ...formData, [field.name]: e.target.value })}
                      required={field.required}
                    />
                  ) : field.type === "date" ? (
                    <input
                      id={id}
                      type="date"
                      className="lattice-input"
                      value={String(formData[field.name] ?? "")}
                      onChange={(e) => setFormData({ ...formData, [field.name]: e.target.value })}
                      required={field.required}
                    />
                  ) : field.type === "json" ? (
                    <textarea
                      id={id}
                      rows={3}
                      className="lattice-input lattice-textarea"
                      value={
                        typeof formData[field.name] === "object"
                          ? JSON.stringify(formData[field.name], null, 2)
                          : String(formData[field.name] ?? "")
                      }
                      onChange={(e) => setFormData({ ...formData, [field.name]: e.target.value })}
                      placeholder="{}"
                      required={field.required}
                    />
                  ) : (
                    <input
                      id={id}
                      type={field.type === "email" ? "email" : field.type === "url" ? "url" : "text"}
                      className="lattice-input"
                      value={String(formData[field.name] ?? "")}
                      onChange={(e) => setFormData({ ...formData, [field.name]: e.target.value })}
                      required={field.required}
                    />
                  )}
                </div>
              );
            })}
          </div>

          <footer className="lattice-modal-footer">
            <button type="button" className="lattice-btn-secondary" onClick={handleClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="lattice-btn-primary" disabled={saving}>
              {saving ? "Saving…" : record ? "Save Changes" : "Create Record"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
