import { useEffect, useState } from "react";
import type { FieldDefinition, SchemaDefinition } from "@lattice/types";
import type { ProductClient } from "@lattice/sdk";

export interface SchemaRecordModalProps {
  client?: ProductClient;
  schema: SchemaDefinition;
  record?: Record<string, unknown> | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => Promise<void>;
}

export function SchemaRecordModal({
  client,
  schema,
  record,
  isOpen,
  onClose,
  onSave,
}: SchemaRecordModalProps) {
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [relationOptions, setRelationOptions] = useState<Record<string, Array<{ id: string; label: string }>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editableFields = schema.fields.filter(
    (f) => !f.system && f.name !== "id" && f.name !== "created" && f.name !== "updated",
  );

  useEffect(() => {
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
  }, [record, schema]);

  // Load relation targets if client is available
  useEffect(() => {
    if (!client || !isOpen) return;

    let ignore = false;
    async function loadRelations() {
      const relationFields = editableFields.filter((f) => f.type === "relation" && f.target);
      const loaded: Record<string, Array<{ id: string; label: string }>> = {};

      for (const f of relationFields) {
        if (!f.target) continue;
        try {
          const res = await client!.collection(f.target).getList(1, 50, { requestKey: null });
          loaded[f.name] = res.items.map((item) => ({
            id: item.id,
            label: String(item.name || item.title || item.label || item.code || item.id),
          }));
        } catch {
          // Relation target collection not found or forbidden, will fallback to text input
          loaded[f.name] = [];
        }
      }

      if (!ignore) {
        setRelationOptions(loaded);
      }
    }

    loadRelations();
    return () => {
      ignore = true;
    };
  }, [client, isOpen, schema]);

  if (!isOpen) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);

    try {
      const payload: Record<string, unknown> = {};
      for (const field of editableFields) {
        const val = formData[field.name];
        if (field.required && (val === "" || val === undefined || val === null)) {
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
        } else {
          payload[field.name] = val;
        }
      }

      await onSave(payload);
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
          <button type="button" className="lattice-modal-close" onClick={onClose} aria-label="Close">
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
              const relOpts = relationOptions[field.name];

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
                  ) : field.type === "relation" && relOpts && relOpts.length > 0 ? (
                    <select
                      id={id}
                      className="lattice-input"
                      value={String(formData[field.name] ?? "")}
                      onChange={(e) => setFormData({ ...formData, [field.name]: e.target.value })}
                      required={field.required}
                    >
                      <option value="">-- Select related {field.target || field.name} --</option>
                      {relOpts.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label} ({opt.id})
                        </option>
                      ))}
                    </select>
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
                      placeholder={field.type === "relation" ? "Record ID" : undefined}
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
            <button type="button" className="lattice-btn-secondary" onClick={onClose} disabled={saving}>
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
