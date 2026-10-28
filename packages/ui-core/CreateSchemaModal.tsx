import { useState } from "react";
import type { FieldDefinition, SchemaDefinition } from "@lattice/types";

export interface CreateSchemaModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (schema: SchemaDefinition) => Promise<void>;
}

interface DraftField {
  name: string;
  label: string;
  type: FieldDefinition["type"];
  required: boolean;
  options: string;
  target?: string;
}

const FIELD_TYPES: Array<FieldDefinition["type"]> = [
  "text",
  "number",
  "bool",
  "date",
  "select",
  "email",
  "url",
  "relation",
  "json",
];

export function CreateSchemaModal({ isOpen, onClose, onCreate }: CreateSchemaModalProps) {
  const [schemaId, setSchemaId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("📋");
  const [assigneeField, setAssigneeField] = useState("");
  const [fields, setFields] = useState<DraftField[]>([
    { name: "title", label: "Title", type: "text", required: true, options: "" },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  function addField() {
    setFields((prev) => [
      ...prev,
      { name: `field_${prev.length + 1}`, label: "", type: "text", required: false, options: "" },
    ]);
  }

  function removeField(index: number) {
    if (fields.length <= 1) {
      setError("A schema must have at least one field.");
      return;
    }
    setFields((prev) => prev.filter((_, i) => i !== index));
  }

  function updateField<K extends keyof DraftField>(index: number, key: K, value: DraftField[K]) {
    setFields((prev) =>
      prev.map((field, i) => {
        if (i !== index) return field;
        const updated = { ...field, [key]: value };
        if (key === "type" && value === "relation" && !updated.target) {
          updated.target = "users";
        }
        return updated;
      }),
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);

    try {
      const trimmedId = schemaId.trim().toLowerCase();
      if (!trimmedId) throw new Error("Schema ID is required");
      if (!/^[a-z][a-z0-9_]{1,40}$/.test(trimmedId)) {
        throw new Error(
          "Schema ID must start with a lowercase letter and contain only lowercase letters, numbers, and underscores (2-41 chars)",
        );
      }
      if (!name.trim()) throw new Error("Schema Name is required");

      const compiledFields: FieldDefinition[] = fields.map((f, i) => {
        const fieldName = f.name.trim().toLowerCase();
        if (!fieldName) throw new Error(`Field #${i + 1} must have a name`);
        if (!/^[a-z][a-z0-9_]{0,40}$/.test(fieldName)) {
          throw new Error(`Field name "${fieldName}" is invalid. Must be lowercase alphanumeric (max 41 chars).`);
        }

        const def: FieldDefinition = {
          name: fieldName,
          label: f.label.trim() || undefined,
          type: f.type,
          required: f.required || undefined,
        };

        if (f.type === "select") {
          const opts = f.options
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          if (opts.length === 0) {
            throw new Error(`Select field "${fieldName}" must have at least one option (comma-separated)`);
          }
          def.options = opts;
        }

        if (f.type === "relation") {
          const target = f.target?.trim().toLowerCase();
          if (!target) {
            throw new Error(`Relation field "${fieldName}" must specify a target collection.`);
          }
          def.target = target;
        }

        return def;
      });

      if (assigneeField.trim()) {
        const targetField = compiledFields.find((f) => f.name === assigneeField.trim().toLowerCase());
        if (!targetField) {
          throw new Error(`Assignee field "${assigneeField}" does not match any declared field.`);
        }
        if (targetField.type !== "relation" || targetField.target !== "users") {
          throw new Error(`Assignee field "${assigneeField}" must be a relation targeting the 'users' collection.`);
        }
      }

      const newSchema: SchemaDefinition = {
        schema_id: trimmedId,
        name: name.trim(),
        description: description.trim() || undefined,
        icon: icon.trim() || undefined,
        assignee_field: assigneeField.trim().toLowerCase() || undefined,
        fields: compiledFields as [FieldDefinition, ...FieldDefinition[]],
      };

      await onCreate(newSchema);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create schema");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="lattice-modal-overlay" role="dialog" aria-modal="true">
      <div className="lattice-modal-dialog lattice-modal-lg">
        <header className="lattice-modal-header">
          <h2>Create New Dynamic Schema</h2>
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
          <div className="lattice-form-row">
            <div className="lattice-form-group" style={{ flex: "0 0 80px" }}>
              <label htmlFor="schema-icon" className="lattice-form-label">
                Icon
              </label>
              <input
                id="schema-icon"
                type="text"
                className="lattice-input"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                maxLength={4}
                title="Emoji or icon character"
              />
            </div>
            <div className="lattice-form-group" style={{ flex: 1 }}>
              <label htmlFor="schema-name" className="lattice-form-label">
                Display Name <span className="lattice-req">*</span>
              </label>
              <input
                id="schema-name"
                type="text"
                className="lattice-input"
                placeholder="e.g. คลังสินค้า, Customer Directory"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!schemaId) {
                    setSchemaId(
                      e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, "_")
                        .replace(/^_+|_+$/g, ""),
                    );
                  }
                }}
                required
              />
            </div>
            <div className="lattice-form-group" style={{ flex: 1 }}>
              <label htmlFor="schema-id" className="lattice-form-label">
                Schema ID (Table identifier) <span className="lattice-req">*</span>
              </label>
              <input
                id="schema-id"
                type="text"
                className="lattice-input"
                placeholder="e.g. inventory, customers"
                value={schemaId}
                onChange={(e) => setSchemaId(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="lattice-form-group">
            <label htmlFor="schema-desc" className="lattice-form-label">
              Description
            </label>
            <input
              id="schema-desc"
              type="text"
              className="lattice-input"
              placeholder="What this dataset is used for..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <fieldset className="lattice-fieldset">
            <legend className="lattice-legend">Dataset Fields Definition</legend>

            <div className="lattice-fields-list">
              {fields.map((f, idx) => (
                <div key={idx} className="lattice-field-builder-row">
                  <div className="lattice-field-col">
                    <label className="lattice-sublabel">Field Name</label>
                    <input
                      type="text"
                      className="lattice-input"
                      placeholder="e.g. sku_code"
                      value={f.name}
                      onChange={(e) => updateField(idx, "name", e.target.value)}
                      required
                    />
                  </div>

                  <div className="lattice-field-col">
                    <label className="lattice-sublabel">Label</label>
                    <input
                      type="text"
                      className="lattice-input"
                      placeholder="e.g. SKU Code"
                      value={f.label}
                      onChange={(e) => updateField(idx, "label", e.target.value)}
                    />
                  </div>

                  <div className="lattice-field-col" style={{ width: "130px" }}>
                    <label className="lattice-sublabel">Type</label>
                    <select
                      className="lattice-input"
                      value={f.type}
                      onChange={(e) => updateField(idx, "type", e.target.value as FieldDefinition["type"])}
                    >
                      {FIELD_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>

                  {f.type === "select" && (
                    <div className="lattice-field-col" style={{ flex: 1.5 }}>
                      <label className="lattice-sublabel">Options (comma-separated)</label>
                      <input
                        type="text"
                        className="lattice-input"
                        placeholder="e.g. active, pending, archived"
                        value={f.options}
                        onChange={(e) => updateField(idx, "options", e.target.value)}
                        required
                      />
                    </div>
                  )}

                  {f.type === "relation" && (
                    <div className="lattice-field-col" style={{ flex: 1.5 }}>
                      <label className="lattice-sublabel">Target Collection</label>
                      <input
                        type="text"
                        className="lattice-input"
                        placeholder="e.g. users, customers"
                        value={f.target || ""}
                        onChange={(e) => updateField(idx, "target", e.target.value)}
                        required
                      />
                    </div>
                  )}

                  <div className="lattice-field-col-chk">
                    <label className="lattice-checkbox-label">
                      <input
                        type="checkbox"
                        checked={f.required}
                        onChange={(e) => updateField(idx, "required", e.target.checked)}
                      />
                      Req
                    </label>
                  </div>

                  <div className="lattice-field-col-action">
                    <button
                      type="button"
                      className="lattice-btn-icon"
                      onClick={() => removeField(idx)}
                      title="Remove Field"
                      disabled={fields.length <= 1}
                    >
                      🗑
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <button type="button" className="lattice-btn-secondary lattice-btn-sm" onClick={addField}>
              + Add Field
            </button>
          </fieldset>

          <div className="lattice-form-group" style={{ marginTop: "1rem" }}>
            <label htmlFor="schema-assignee-field" className="lattice-form-label">
              Assignee Field (Optional)
            </label>
            <select
              id="schema-assignee-field"
              className="lattice-input"
              value={assigneeField}
              onChange={(e) => setAssigneeField(e.target.value)}
            >
              <option value="">None (No assigned record scoping)</option>
              {fields
                .filter(
                  (f) =>
                    f.name.trim() !== "" &&
                    f.type === "relation" &&
                    (!f.target || f.target.trim().toLowerCase() === "users"),
                )
                .map((f, i) => (
                  <option key={i} value={f.name.trim().toLowerCase()}>
                    {f.name.trim().toLowerCase()} ({f.label || f.name} - user relation)
                  </option>
                ))}
            </select>
            <span className="yp-muted" style={{ fontSize: "0.75rem", display: "block", marginTop: "0.25rem" }}>
              Designating an assignee field enables "Assigned Only" record scoping for members. Select a relation field targeting the 'users' collection.
            </span>
          </div>

          <footer className="lattice-modal-footer">
            <button type="button" className="lattice-btn-secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="lattice-btn-primary" disabled={saving}>
              {saving ? "Creating Schema…" : "Create Schema"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
