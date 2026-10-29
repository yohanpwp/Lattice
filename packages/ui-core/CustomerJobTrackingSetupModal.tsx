import { useState } from "react";
import type { SchemaDefinition } from "@lattice/types";
import type { ProductClient } from "@lattice/sdk";

export interface CustomerJobTrackingSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  client: ProductClient;
  schemas: SchemaDefinition[];
  onConfigured?: () => void;
}

export function CustomerJobTrackingSetupModal({
  isOpen,
  onClose,
  client,
  schemas,
  onConfigured,
}: CustomerJobTrackingSetupModalProps) {
  const [mode, setMode] = useState<"suggested" | "custom">("suggested");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Custom mapping state
  const [customerDataset, setCustomerDataset] = useState(
    schemas.find((s) => s.schema_id.includes("customer"))?.schema_id || ""
  );
  const [customerNameField, setCustomerNameField] = useState("name");
  const [customerPhoneField, setCustomerPhoneField] = useState("phone");
  const [jobDataset, setJobDataset] = useState(
    schemas.find((s) => s.schema_id.includes("job"))?.schema_id || ""
  );
  const [jobTitleField, setJobTitleField] = useState("title");
  const [jobCustomerField, setJobCustomerField] = useState("customer");
  const [jobStatusField, setJobStatusField] = useState("status");
  const [jobAssigneeField, setJobAssigneeField] = useState("assignee");

  if (!isOpen) return null;

  const selectedCustSchema = schemas.find((s) => s.schema_id === customerDataset);
  const selectedJobSchema = schemas.find((s) => s.schema_id === jobDataset);

  async function handleSetup() {
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      if (mode === "suggested") {
        await client.setupWorkspaceModule("customer_job_tracking", {
          use_suggested: true,
        });
      } else {
        if (!customerDataset || !jobDataset) {
          throw new Error("Both Customer and Job datasets must be selected");
        }
        if (customerDataset === jobDataset) {
          throw new Error("Customer and Job datasets must be different");
        }
        await client.setupWorkspaceModule("customer_job_tracking", {
          use_suggested: false,
          mapping: {
            customer_dataset: customerDataset,
            customer_name_field: customerNameField,
            customer_phone_field: customerPhoneField || undefined,
            job_dataset: jobDataset,
            job_title_field: jobTitleField,
            job_customer_field: jobCustomerField,
            job_status_field: jobStatusField,
            job_assignee_field: jobAssigneeField,
          },
        });
      }

      setSuccess("Customer & Job Tracking module configured and enabled successfully!");
      onConfigured?.();
      setTimeout(() => {
        onClose();
      }, 1000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to configure module");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="lattice-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="cjt-modal-title">
      <div className="lattice-modal lattice-modal-lg" style={{ maxWidth: "780px" }}>
        <div className="lattice-modal-header">
          <div>
            <h2 id="cjt-modal-title">Configure Customer &amp; Job Tracking</h2>
            <p className="yp-muted" style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
              Enable phone and web workflows for managing customer contacts, jobs, and field assignments.
            </p>
          </div>
          <button type="button" className="lattice-modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="lattice-modal-body" style={{ padding: "1.25rem 1.5rem" }}>
          {error && (
            <div className="lattice-alert-error" role="alert" style={{ marginBottom: "1rem" }}>
              {error}
            </div>
          )}

          {success && (
            <div
              className="lattice-card"
              style={{ background: "#f0fdf4", border: "1px solid #86efac", color: "#166534", marginBottom: "1rem" }}
            >
              {success}
            </div>
          )}

          {/* Mode Switcher */}
          <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.25rem" }}>
            <button
              type="button"
              className={mode === "suggested" ? "lattice-btn-primary" : "lattice-btn-secondary"}
              style={{ flex: 1, padding: "0.6rem 1rem", fontSize: "0.875rem" }}
              onClick={() => setMode("suggested")}
            >
              ✨ Create Suggested Datasets (Recommended)
            </button>
            <button
              type="button"
              className={mode === "custom" ? "lattice-btn-primary" : "lattice-btn-secondary"}
              style={{ flex: 1, padding: "0.6rem 1rem", fontSize: "0.875rem" }}
              onClick={() => setMode("custom")}
            >
              🔄 Map Existing Datasets
            </button>
          </div>

          {mode === "suggested" ? (
            <div>
              <p style={{ fontSize: "0.875rem", color: "var(--lattice-text)", marginBottom: "1rem" }}>
                Setting up with suggested datasets creates two pre-configured, permission-protected collections:
              </p>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1.25rem" }}>
                <div
                  style={{
                    border: "1px solid var(--lattice-border)",
                    borderRadius: "6px",
                    padding: "1rem",
                    background: "var(--lattice-bg)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
                    <span style={{ fontSize: "1.2rem" }}>👥</span>
                    <strong>Customers</strong>
                    <span className="app-chip"><code>customers</code></span>
                  </div>
                  <p className="yp-muted" style={{ fontSize: "0.8rem", margin: "0 0 0.75rem 0" }}>
                    Contact directory for searching and linking customer accounts.
                  </p>
                  <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.8rem" }}>
                    <li><code>name</code> (Text, Required)</li>
                    <li><code>phone</code> (Text, Optional)</li>
                  </ul>
                </div>

                <div
                  style={{
                    border: "1px solid var(--lattice-border)",
                    borderRadius: "6px",
                    padding: "1rem",
                    background: "var(--lattice-bg)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
                    <span style={{ fontSize: "1.2rem" }}>📋</span>
                    <strong>Jobs</strong>
                    <span className="app-chip"><code>jobs</code></span>
                  </div>
                  <p className="yp-muted" style={{ fontSize: "0.8rem", margin: "0 0 0.75rem 0" }}>
                    Work orders with status tracking and assigned member scoping.
                  </p>
                  <ul style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.8rem" }}>
                    <li><code>title</code> (Text, Required)</li>
                    <li><code>customer</code> (Relation &rarr; Customers, Required)</li>
                    <li><code>status</code> (Select: Open, In progress, Done)</li>
                    <li><code>assignee</code> (Relation &rarr; Users, Required)</li>
                  </ul>
                </div>
              </div>
            </div>
          ) : (
            <div>
              <p style={{ fontSize: "0.875rem", marginBottom: "1rem" }}>
                Map your existing workspace collections to the roles required by Customer &amp; Job Tracking:
              </p>

              {/* Customer mapping */}
              <div
                style={{
                  border: "1px solid var(--lattice-border)",
                  borderRadius: "6px",
                  padding: "1rem",
                  marginBottom: "1rem",
                }}
              >
                <h4 style={{ margin: "0 0 0.75rem 0", fontSize: "0.95rem" }}>1. Customer Dataset</h4>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem" }}>
                  <div>
                    <label style={{ fontSize: "0.8rem", fontWeight: 600 }}>Dataset</label>
                    <select
                      value={customerDataset}
                      onChange={(e) => setCustomerDataset(e.target.value)}
                      style={{ width: "100%", padding: "0.4rem", borderRadius: "4px" }}
                    >
                      <option value="">Select dataset…</option>
                      {schemas.map((s) => (
                        <option key={s.schema_id} value={s.schema_id}>
                          {s.name} ({s.schema_id})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: "0.8rem", fontWeight: 600 }}>Name Field</label>
                    <select
                      value={customerNameField}
                      onChange={(e) => setCustomerNameField(e.target.value)}
                      style={{ width: "100%", padding: "0.4rem", borderRadius: "4px" }}
                    >
                      {selectedCustSchema?.fields.map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.label || f.name} ({f.type})
                        </option>
                      )) || <option value="name">name</option>}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: "0.8rem", fontWeight: 600 }}>Phone Field (Optional)</label>
                    <select
                      value={customerPhoneField}
                      onChange={(e) => setCustomerPhoneField(e.target.value)}
                      style={{ width: "100%", padding: "0.4rem", borderRadius: "4px" }}
                    >
                      <option value="">(None)</option>
                      {selectedCustSchema?.fields.map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.label || f.name} ({f.type})
                        </option>
                      )) || <option value="phone">phone</option>}
                    </select>
                  </div>
                </div>
              </div>

              {/* Job mapping */}
              <div
                style={{
                  border: "1px solid var(--lattice-border)",
                  borderRadius: "6px",
                  padding: "1rem",
                  marginBottom: "1rem",
                }}
              >
                <h4 style={{ margin: "0 0 0.75rem 0", fontSize: "0.95rem" }}>2. Job Dataset</h4>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", marginBottom: "0.75rem" }}>
                  <div>
                    <label style={{ fontSize: "0.8rem", fontWeight: 600 }}>Dataset</label>
                    <select
                      value={jobDataset}
                      onChange={(e) => setJobDataset(e.target.value)}
                      style={{ width: "100%", padding: "0.4rem", borderRadius: "4px" }}
                    >
                      <option value="">Select dataset…</option>
                      {schemas.map((s) => (
                        <option key={s.schema_id} value={s.schema_id}>
                          {s.name} ({s.schema_id})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: "0.8rem", fontWeight: 600 }}>Title Field</label>
                    <select
                      value={jobTitleField}
                      onChange={(e) => setJobTitleField(e.target.value)}
                      style={{ width: "100%", padding: "0.4rem", borderRadius: "4px" }}
                    >
                      {selectedJobSchema?.fields.map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.label || f.name} ({f.type})
                        </option>
                      )) || <option value="title">title</option>}
                    </select>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem" }}>
                  <div>
                    <label style={{ fontSize: "0.8rem", fontWeight: 600 }}>Customer Relation</label>
                    <select
                      value={jobCustomerField}
                      onChange={(e) => setJobCustomerField(e.target.value)}
                      style={{ width: "100%", padding: "0.4rem", borderRadius: "4px" }}
                    >
                      {selectedJobSchema?.fields
                        .filter((f) => f.type === "relation")
                        .map((f) => (
                          <option key={f.name} value={f.name}>
                            {f.label || f.name} &rarr; {f.target}
                          </option>
                        )) || <option value="customer">customer</option>}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: "0.8rem", fontWeight: 600 }}>Status Field</label>
                    <select
                      value={jobStatusField}
                      onChange={(e) => setJobStatusField(e.target.value)}
                      style={{ width: "100%", padding: "0.4rem", borderRadius: "4px" }}
                    >
                      {selectedJobSchema?.fields.map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.label || f.name} ({f.type})
                        </option>
                      )) || <option value="status">status</option>}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: "0.8rem", fontWeight: 600 }}>Assignee Relation (&rarr; users)</label>
                    <select
                      value={jobAssigneeField}
                      onChange={(e) => setJobAssigneeField(e.target.value)}
                      style={{ width: "100%", padding: "0.4rem", borderRadius: "4px" }}
                    >
                      {selectedJobSchema?.fields
                        .filter((f) => f.type === "relation")
                        .map((f) => (
                          <option key={f.name} value={f.name}>
                            {f.label || f.name} &rarr; {f.target}
                          </option>
                        )) || <option value="assignee">assignee</option>}
                    </select>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Team Permissions Callout */}
          <div
            style={{
              background: "var(--lattice-bg)",
              border: "1px solid var(--lattice-border)",
              borderRadius: "6px",
              padding: "0.85rem 1rem",
              fontSize: "0.825rem",
            }}
          >
            <strong>🛡️ Team Access &amp; Isolation Rules</strong>
            <p style={{ margin: "0.25rem 0 0.5rem 0", color: "var(--lattice-muted)" }}>
              After setup, use the <strong>Workspace Team</strong> dialog to invite members with the Customer &amp; Job Tracking preset:
            </p>
            <div style={{ display: "flex", gap: "1rem" }}>
              <div>
                <strong>Customers:</strong> <span className="app-chip">Read All</span>
              </div>
              <div>
                <strong>Jobs:</strong> <span className="app-chip">Read/Create/Update Assigned</span>
              </div>
            </div>
            <p style={{ margin: "0.5rem 0 0 0", fontSize: "0.775rem", color: "var(--lattice-muted)" }}>
              Members on phones or web can only view and edit jobs assigned to them. Jobs created by members are automatically assigned to them.
            </p>
          </div>
        </div>

        <div className="lattice-modal-footer" style={{ display: "flex", justifyContent: "space-between" }}>
          <button type="button" className="lattice-btn-secondary" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            type="button"
            className="lattice-btn-primary"
            onClick={handleSetup}
            disabled={loading}
          >
            {loading ? "Configuring…" : "Save & Enable Module"}
          </button>
        </div>
      </div>
    </div>
  );
}
