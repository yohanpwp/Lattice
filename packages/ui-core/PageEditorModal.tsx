import { useCallback, useEffect, useState } from "react";
import type { PageDefinition, SchemaDefinition } from "@lattice/types";
import type { ProductClient } from "@lattice/sdk";
import { ConfirmModal } from "./ConfirmModal";

export interface PageEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  client: ProductClient;
  schemas: SchemaDefinition[];
  page?: PageDefinition | null;
  onSave: (page: PageDefinition) => Promise<void>;
  onDelete?: (pageId: string) => Promise<void>;
}

export function PageEditorModal({
  isOpen,
  onClose,
  client,
  schemas,
  page,
  onSave,
  onDelete,
}: PageEditorModalProps) {
  const isEditing = Boolean(page);

  const [pageId, setPageId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("");
  const [viewType, setViewType] = useState<PageDefinition["view_type"]>("table");
  const [collection, setCollection] = useState("");
  const [published, setPublished] = useState(true);
  const [navOrder, setNavOrder] = useState(0);

  // View-specific config
  const [selectedColumns, setSelectedColumns] = useState<string[]>([]);
  const [groupByField, setGroupByField] = useState("");
  const [selectedCardFields, setSelectedCardFields] = useState<string[]>([]);
  const [detailCollection, setDetailCollection] = useState("");
  const [relationField, setRelationField] = useState("");
  const [perPage, setPerPage] = useState(20);
  const [defaultSort, setDefaultSort] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Initialize or reset form values
  useEffect(() => {
    if (page) {
      setPageId(page.page_id);
      setName(page.name);
      setDescription(page.description || "");
      setIcon(page.icon || "");
      setViewType(page.view_type);
      setCollection(page.collection);
      setPublished(page.published !== false);
      setNavOrder(page.nav_order ?? 0);

      const cfg = page.config || {};
      setSelectedColumns(cfg.columns || []);
      setGroupByField(cfg.groupByField || "");
      setSelectedCardFields(cfg.cardFields || []);
      setDetailCollection(cfg.detailCollection || "");
      setRelationField(cfg.relationField || "");
      setPerPage(cfg.perPage || 20);
      setDefaultSort(cfg.defaultSort || "");
    } else {
      const firstSchema = schemas[0]?.schema_id || "";
      setPageId("");
      setName("");
      setDescription("");
      setIcon("");
      setViewType("table");
      setCollection(firstSchema);
      setPublished(true);
      setNavOrder(0);
      setSelectedColumns([]);
      setGroupByField("");
      setSelectedCardFields([]);
      setDetailCollection("");
      setRelationField("");
      setPerPage(20);
      setDefaultSort("");
    }
    setError(null);
  }, [page, schemas, isOpen]);

  // Derive pageId from name if not manually edited when creating
  const handleNameChange = (val: string) => {
    setName(val);
    if (!isEditing && (!pageId || pageId === slugify(name))) {
      setPageId(slugify(val));
    }
  };

  const selectedSchema = schemas.find((s) => s.schema_id === collection);
  const availableFields = selectedSchema?.fields || [];

  const detailSchema = schemas.find((s) => s.schema_id === detailCollection);
  const detailAvailableFields = detailSchema?.fields || [];

  if (!isOpen) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    const trimmedId = pageId.trim().toLowerCase();

    if (!trimmedName) {
      setError("Page name is required.");
      return;
    }
    if (!trimmedId) {
      setError("Page identifier (ID) is required.");
      return;
    }
    if (!/^[a-z][a-z0-9_-]{1,40}$/.test(trimmedId)) {
      setError("Page ID must start with a lowercase letter and contain only lowercase letters, digits, dashes, and underscores (2-40 characters).");
      return;
    }
    if (!collection) {
      setError("Please select a target dataset for this page.");
      return;
    }

    if (viewType === "kanban" && !groupByField) {
      setError("Kanban view requires selecting a group-by field.");
      return;
    }

    if (viewType === "master_detail") {
      if (!detailCollection) {
        setError("Master-Detail view requires selecting a detail dataset.");
        return;
      }
      if (!relationField) {
        setError("Master-Detail view requires selecting a relation field.");
        return;
      }
    }

    const config: Record<string, unknown> = {
      perPage,
      allowCreate: true,
      allowEdit: true,
      allowDelete: true,
    };

    if (selectedColumns.length > 0) {
      config.columns = selectedColumns;
    }
    if (defaultSort.trim()) {
      config.defaultSort = defaultSort.trim();
    }
    if (viewType === "kanban") {
      config.groupByField = groupByField;
      if (selectedCardFields.length > 0) {
        config.cardFields = selectedCardFields;
      }
    } else if (viewType === "master_detail") {
      config.detailCollection = detailCollection;
      config.relationField = relationField;
    }

    const pageDef: PageDefinition = {
      page_id: trimmedId,
      name: trimmedName,
      view_type: viewType,
      collection,
      published,
      nav_order: navOrder,
      config,
    };

    if (description.trim()) {
      pageDef.description = description.trim();
    }
    if (icon.trim()) {
      pageDef.icon = icon.trim();
    }

    setSaving(true);
    try {
      await onSave(pageDef);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save page configuration");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!page || !onDelete) return;
    setDeleting(true);
    try {
      await onDelete(page.page_id);
      setShowDeleteConfirm(false);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete page");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="lattice-modal-overlay" role="dialog" aria-modal="true">
      <div className="lattice-modal-dialog" style={{ maxWidth: "680px" }}>
        <header className="lattice-modal-header">
          <h2>{isEditing ? `Edit Page: ${page?.name}` : "Create Custom Page"}</h2>
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
            <div className="lattice-form-group">
              <label htmlFor="page-name-input" className="lattice-form-label">
                Page Name <span className="lattice-req">*</span>
              </label>
              <input
                id="page-name-input"
                type="text"
                className="lattice-input"
                placeholder="e.g. Orders Board, Project List"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                required
              />
            </div>

            <div className="lattice-form-group">
              <label htmlFor="page-id-input" className="lattice-form-label">
                Page Identifier (slug) <span className="lattice-req">*</span>
              </label>
              <input
                id="page-id-input"
                type="text"
                className="lattice-input"
                placeholder="e.g. orders-board, projects-list"
                value={pageId}
                onChange={(e) => setPageId(e.target.value.toLowerCase())}
                disabled={isEditing}
                required
              />
            </div>

            <div className="lattice-form-group">
              <label htmlFor="page-view-type" className="lattice-form-label">
                View Layout <span className="lattice-req">*</span>
              </label>
              <select
                id="page-view-type"
                className="lattice-input"
                value={viewType}
                onChange={(e) => setViewType(e.target.value as PageDefinition["view_type"])}
              >
                <option value="table">Table View (Data Grid)</option>
                <option value="kanban">Kanban Board (Grouped Cards)</option>
                <option value="master_detail">Master-Detail (Parent &amp; Child Records)</option>
                <option value="dashboard">Dashboard (Embedded Widgets)</option>
              </select>
            </div>

            <div className="lattice-form-group">
              <label htmlFor="page-collection" className="lattice-form-label">
                Dataset (Collection) <span className="lattice-req">*</span>
              </label>
              <select
                id="page-collection"
                className="lattice-input"
                value={collection}
                onChange={(e) => {
                  setCollection(e.target.value);
                  setSelectedColumns([]);
                  setGroupByField("");
                  setSelectedCardFields([]);
                }}
                required
              >
                <option value="">-- Select a dataset --</option>
                {schemas.map((s) => (
                  <option key={s.schema_id} value={s.schema_id}>
                    {s.icon ? `${s.icon} ` : ""}{s.name} ({s.schema_id})
                  </option>
                ))}
              </select>
            </div>

            <div className="lattice-form-group">
              <label htmlFor="page-icon" className="lattice-form-label">
                Page Icon (Emoji)
              </label>
              <input
                id="page-icon"
                type="text"
                className="lattice-input"
                placeholder="e.g. 📋, 📌, 🚀"
                value={icon}
                maxLength={4}
                onChange={(e) => setIcon(e.target.value)}
              />
            </div>

            <div className="lattice-form-group">
              <label htmlFor="page-nav-order" className="lattice-form-label">
                Navigation Sort Order
              </label>
              <input
                id="page-nav-order"
                type="number"
                className="lattice-input"
                value={navOrder}
                min={0}
                max={999}
                onChange={(e) => setNavOrder(parseInt(e.target.value, 10) || 0)}
              />
            </div>
          </div>

          <div className="lattice-form-group">
            <label htmlFor="page-description" className="lattice-form-label">
              Description
            </label>
            <input
              id="page-description"
              type="text"
              className="lattice-input"
              placeholder="Brief description of this view's purpose"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="lattice-form-group" style={{ margin: "1rem 0" }}>
            <label className="lattice-checkbox-label" style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={published}
                onChange={(e) => setPublished(e.target.checked)}
              />
              <span>
                <strong>Publish Page to Workspace</strong>
                <span className="yp-muted" style={{ display: "block", fontSize: "0.8rem" }}>
                  When enabled, members with read access to the dataset will see this page in workspace navigation. When disabled, the page remains an unpublished draft visible only to owners and admins.
                </span>
              </span>
            </label>
          </div>

          {/* Kanban Specific Settings */}
          {viewType === "kanban" && (
            <fieldset className="lattice-fieldset" style={{ marginTop: "1rem", border: "1px solid var(--yp-border, #cbd5e1)", padding: "1rem", borderRadius: "6px" }}>
              <legend style={{ fontWeight: "bold", padding: "0 0.5rem" }}>Kanban Configuration</legend>
              <div className="lattice-form-group">
                <label htmlFor="kanban-groupby" className="lattice-form-label">
                  Group By Column (Status / Category) <span className="lattice-req">*</span>
                </label>
                <select
                  id="kanban-groupby"
                  className="lattice-input"
                  value={groupByField}
                  onChange={(e) => setGroupByField(e.target.value)}
                  required
                >
                  <option value="">-- Choose field to group cards by --</option>
                  {availableFields.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.label || f.name} ({f.type})
                    </option>
                  ))}
                </select>
              </div>

              <div className="lattice-form-group" style={{ marginTop: "0.75rem" }}>
                <label className="lattice-form-label">Card Display Fields</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                  {availableFields.map((f) => {
                    const isSelected = selectedCardFields.includes(f.name);
                    return (
                      <button
                        key={f.name}
                        type="button"
                        className={`lattice-chip-btn ${isSelected ? "lattice-chip-btn--active" : ""}`}
                        style={{
                          padding: "0.25rem 0.6rem",
                          borderRadius: "4px",
                          border: "1px solid",
                          borderColor: isSelected ? "var(--yp-primary, #2563eb)" : "var(--yp-border, #cbd5e1)",
                          background: isSelected ? "var(--yp-primary-bg, #eff6ff)" : "#fff",
                          cursor: "pointer",
                        }}
                        onClick={() => {
                          setSelectedCardFields((prev) =>
                            isSelected ? prev.filter((name) => name !== f.name) : [...prev, f.name]
                          );
                        }}
                      >
                        {isSelected ? "✓ " : "+ "}{f.label || f.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            </fieldset>
          )}

          {/* Master Detail Specific Settings */}
          {viewType === "master_detail" && (
            <fieldset className="lattice-fieldset" style={{ marginTop: "1rem", border: "1px solid var(--yp-border, #cbd5e1)", padding: "1rem", borderRadius: "6px" }}>
              <legend style={{ fontWeight: "bold", padding: "0 0.5rem" }}>Master-Detail Configuration</legend>
              <div className="lattice-form-grid">
                <div className="lattice-form-group">
                  <label htmlFor="detail-collection" className="lattice-form-label">
                    Detail Dataset (Child Collection) <span className="lattice-req">*</span>
                  </label>
                  <select
                    id="detail-collection"
                    className="lattice-input"
                    value={detailCollection}
                    onChange={(e) => {
                      setDetailCollection(e.target.value);
                      setRelationField("");
                    }}
                    required
                  >
                    <option value="">-- Choose child dataset --</option>
                    {schemas.map((s) => (
                      <option key={s.schema_id} value={s.schema_id}>
                        {s.name} ({s.schema_id})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="lattice-form-group">
                  <label htmlFor="relation-field" className="lattice-form-label">
                    Foreign Key / Relation Field <span className="lattice-req">*</span>
                  </label>
                  <select
                    id="relation-field"
                    className="lattice-input"
                    value={relationField}
                    onChange={(e) => setRelationField(e.target.value)}
                    required
                  >
                    <option value="">-- Relation field pointing to parent --</option>
                    {detailAvailableFields.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.label || f.name} ({f.type})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </fieldset>
          )}

          {/* Table View Specific Settings */}
          {viewType === "table" && (
            <fieldset className="lattice-fieldset" style={{ marginTop: "1rem", border: "1px solid var(--yp-border, #cbd5e1)", padding: "1rem", borderRadius: "6px" }}>
              <legend style={{ fontWeight: "bold", padding: "0 0.5rem" }}>Table Columns &amp; Display</legend>
              <div className="lattice-form-group">
                <label className="lattice-form-label">Visible Columns (leave unselected to show all columns)</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                  {availableFields.map((f) => {
                    const isSelected = selectedColumns.includes(f.name);
                    return (
                      <button
                        key={f.name}
                        type="button"
                        className={`lattice-chip-btn ${isSelected ? "lattice-chip-btn--active" : ""}`}
                        style={{
                          padding: "0.25rem 0.6rem",
                          borderRadius: "4px",
                          border: "1px solid",
                          borderColor: isSelected ? "var(--yp-primary, #2563eb)" : "var(--yp-border, #cbd5e1)",
                          background: isSelected ? "var(--yp-primary-bg, #eff6ff)" : "#fff",
                          cursor: "pointer",
                        }}
                        onClick={() => {
                          setSelectedColumns((prev) =>
                            isSelected ? prev.filter((name) => name !== f.name) : [...prev, f.name]
                          );
                        }}
                      >
                        {isSelected ? "✓ " : "+ "}{f.label || f.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="lattice-form-grid" style={{ marginTop: "0.75rem" }}>
                <div className="lattice-form-group">
                  <label htmlFor="table-sort-input" className="lattice-form-label">
                    Default Sort Field
                  </label>
                  <input
                    id="table-sort-input"
                    type="text"
                    className="lattice-input"
                    placeholder="e.g. -created, name"
                    value={defaultSort}
                    onChange={(e) => setDefaultSort(e.target.value)}
                  />
                </div>

                <div className="lattice-form-group">
                  <label htmlFor="table-per-page" className="lattice-form-label">
                    Records Per Page
                  </label>
                  <input
                    id="table-per-page"
                    type="number"
                    className="lattice-input"
                    min={5}
                    max={100}
                    value={perPage}
                    onChange={(e) => setPerPage(parseInt(e.target.value, 10) || 20)}
                  />
                </div>
              </div>
            </fieldset>
          )}

          <footer className="lattice-modal-footer" style={{ marginTop: "1.5rem", display: "flex", justifyContent: "space-between" }}>
            <div>
              {isEditing && onDelete && (
                <button
                  type="button"
                  className="lattice-btn-danger"
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={saving || deleting}
                >
                  Delete Page
                </button>
              )}
            </div>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button type="button" className="lattice-btn-secondary" onClick={onClose} disabled={saving || deleting}>
                Cancel
              </button>
              <button type="submit" className="lattice-btn-primary" disabled={saving || deleting}>
                {saving ? "Saving…" : isEditing ? "Save Changes" : "Create Page"}
              </button>
            </div>
          </footer>
        </form>
      </div>

      <ConfirmModal
        isOpen={showDeleteConfirm}
        title="Delete Custom Page"
        message={`Are you sure you want to delete page "${name}" (${pageId})? The underlying dataset "${collection}" and its business records will remain completely intact.`}
        confirmLabel={deleting ? "Deleting…" : "Delete Page"}
        confirmVariant="danger"
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  );
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
