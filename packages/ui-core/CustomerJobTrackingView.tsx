import { useCallback, useEffect, useState } from "react";
import type { SchemaDefinition } from "@lattice/types";
import type { ProductClient } from "@lattice/sdk";

type RecordModel = { id: string; [key: string]: any };

export interface CustomerJobTrackingViewProps {
  client: ProductClient;
  schemas?: SchemaDefinition[];
}

export function CustomerJobTrackingView({ client, schemas = [] }: CustomerJobTrackingViewProps) {
  const [activeSegment, setActiveSegment] = useState<"jobs" | "customers">("jobs");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [customerSearch, setCustomerSearch] = useState<string>("");

  const [jobs, setJobs] = useState<RecordModel[]>([]);
  const [customers, setCustomers] = useState<RecordModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Mappings
  const [customerDataset, setCustomerDataset] = useState("customers");
  const [customerNameField, setCustomerNameField] = useState("name");
  const [customerPhoneField, setCustomerPhoneField] = useState("phone");
  const [jobDataset, setJobDataset] = useState("jobs");
  const [jobTitleField, setJobTitleField] = useState("title");
  const [jobCustomerField, setJobCustomerField] = useState("customer");
  const [jobStatusField, setJobStatusField] = useState("status");
  const [jobAssigneeField, setJobAssigneeField] = useState("assignee");

  // Job creation modal state
  const [createJobModalOpen, setCreateJobModalOpen] = useState(false);
  const [newJobTitle, setNewJobTitle] = useState("");
  const [newJobCustomerId, setNewJobCustomerId] = useState("");
  const [newJobStatus, setNewJobStatus] = useState("Open");
  const [createJobPending, setCreateJobPending] = useState(false);
  const [createJobError, setCreateJobError] = useState<string | null>(null);

  // Customer creation modal state
  const [createCustModalOpen, setCreateCustModalOpen] = useState(false);
  const [newCustName, setNewCustName] = useState("");
  const [newCustPhone, setNewCustPhone] = useState("");
  const [createCustPending, setCreateCustPending] = useState(false);
  const [createCustError, setCreateCustError] = useState<string | null>(null);

  const [selectedCustomerIdFilter, setSelectedCustomerIdFilter] = useState<string | null>(null);

  // Load module configuration mappings
  useEffect(() => {
    let ignore = false;
    client.getWorkspaceModule("customer_job_tracking").then((mod) => {
      if (!ignore && mod?.mapping) {
        if (mod.mapping.customer_dataset) setCustomerDataset(mod.mapping.customer_dataset);
        if (mod.mapping.customer_name_field) setCustomerNameField(mod.mapping.customer_name_field);
        if (mod.mapping.customer_phone_field) setCustomerPhoneField(mod.mapping.customer_phone_field);
        if (mod.mapping.job_dataset) setJobDataset(mod.mapping.job_dataset);
        if (mod.mapping.job_title_field) setJobTitleField(mod.mapping.job_title_field);
        if (mod.mapping.job_customer_field) setJobCustomerField(mod.mapping.job_customer_field);
        if (mod.mapping.job_status_field) setJobStatusField(mod.mapping.job_status_field);
        if (mod.mapping.job_assignee_field) setJobAssigneeField(mod.mapping.job_assignee_field);
      }
    }).catch(() => {});
    return () => {
      ignore = true;
    };
  }, [client]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [jobsRes, custRes] = await Promise.all([
        client.collection(jobDataset).getList(1, 200, { sort: "-created" }).catch((err: unknown) => {
          throw new Error(`Jobs access error: ${err instanceof Error ? err.message : String(err)}`);
        }),
        client.collection(customerDataset).getList(1, 200, { sort: "created" }).catch((err: unknown) => {
          throw new Error(`Customers access error: ${err instanceof Error ? err.message : String(err)}`);
        }),
      ]);

      setJobs(jobsRes.items);
      setCustomers(custRes.items);
      if (custRes.items.length > 0 && !newJobCustomerId && custRes.items[0]) {
        setNewJobCustomerId(custRes.items[0].id);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [client, jobDataset, customerDataset, newJobCustomerId]);

  useEffect(() => {
    loadData();

    // Realtime subscriptions for jobs and customers
    let unsubscribed = false;
    client
      .collection(jobDataset)
      .subscribe("*", () => {
        if (!unsubscribed) {
          loadData();
        }
      })
      .catch(() => {});

    client
      .collection(customerDataset)
      .subscribe("*", () => {
        if (!unsubscribed) {
          loadData();
        }
      })
      .catch(() => {});

    return () => {
      unsubscribed = true;
      try {
        client.collection(jobDataset).unsubscribe("*").catch(() => {});
        client.collection(customerDataset).unsubscribe("*").catch(() => {});
      } catch {}
    };
  }, [client, jobDataset, customerDataset, loadData]);

  // Quick status transition
  async function handleCycleStatus(job: RecordModel) {
    const currentStatus = String(job[jobStatusField] || "Open");
    let nextStatus = "In progress";
    if (currentStatus === "In progress") {
      nextStatus = "Done";
    } else if (currentStatus === "Done") {
      nextStatus = "Open";
    }

    try {
      await client.collection(jobDataset).update(job.id, {
        [jobStatusField]: nextStatus,
      });
      setJobs((prev) =>
        prev.map((j) => (j.id === job.id ? { ...j, [jobStatusField]: nextStatus } : j))
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update job status");
    }
  }

  // Handle create job
  async function handleCreateJob(e: React.FormEvent) {
    e.preventDefault();
    if (!newJobTitle.trim()) return;

    setCreateJobPending(true);
    setCreateJobError(null);

    try {
      const payload: Record<string, any> = {
        [jobTitleField]: newJobTitle.trim(),
        [jobCustomerField]: newJobCustomerId,
        [jobStatusField]: newJobStatus,
        [jobAssigneeField]: client.currentUserId || "",
      };

      await client.collection(jobDataset).create(payload);
      setNewJobTitle("");
      setCreateJobModalOpen(false);
      await loadData();
    } catch (err: unknown) {
      setCreateJobError(err instanceof Error ? err.message : "Failed to create job");
    } finally {
      setCreateJobPending(false);
    }
  }

  // Handle create customer
  async function handleCreateCustomer(e: React.FormEvent) {
    e.preventDefault();
    if (!newCustName.trim()) return;

    setCreateCustPending(true);
    setCreateCustError(null);

    try {
      const payload: Record<string, any> = {
        [customerNameField]: newCustName.trim(),
      };
      if (newCustPhone.trim()) {
        payload[customerPhoneField] = newCustPhone.trim();
      }

      await client.collection(customerDataset).create(payload);
      setNewCustName("");
      setNewCustPhone("");
      setCreateCustModalOpen(false);
      await loadData();
    } catch (err: unknown) {
      setCreateCustError(err instanceof Error ? err.message : "Failed to create customer");
    } finally {
      setCreateCustPending(false);
    }
  }

  const customerMap = new Map<string, RecordModel>();
  for (const c of customers) {
    customerMap.set(c.id, c);
  }

  // Filtering
  const filteredJobs = jobs.filter((j) => {
    if (selectedCustomerIdFilter && j[jobCustomerField] !== selectedCustomerIdFilter) {
      return false;
    }
    const status = String(j[jobStatusField] || "").toLowerCase();
    if (statusFilter === "open" && status !== "open") return false;
    if (statusFilter === "in_progress" && status !== "in progress") return false;
    if (statusFilter === "done" && status !== "done") return false;
    return true;
  });

  const filteredCustomers = customers.filter((c) => {
    if (!customerSearch.trim()) return true;
    const q = customerSearch.toLowerCase();
    const name = String(c[customerNameField] || "").toLowerCase();
    const phone = String(c[customerPhoneField] || "").toLowerCase();
    return name.includes(q) || phone.includes(q);
  });

  const openCount = jobs.filter((j) => String(j[jobStatusField] || "").toLowerCase() === "open").length;
  const inProgressCount = jobs.filter((j) => String(j[jobStatusField] || "").toLowerCase() === "in progress").length;
  const doneCount = jobs.filter((j) => String(j[jobStatusField] || "").toLowerCase() === "done").length;

  return (
    <div className="lattice-container" style={{ padding: "0.5rem 0", maxWidth: "900px", margin: "0 auto" }}>
      {/* Phone/Responsive Header & Segment Switcher */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "1rem",
          flexWrap: "wrap",
          gap: "0.75rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ fontSize: "1.5rem" }}>📋</span>
          <div>
            <h2 style={{ margin: 0, fontSize: "1.25rem" }}>Customer &amp; Job Tracking</h2>
            <span className="yp-muted" style={{ fontSize: "0.8rem" }}>
              {client.isOwnerOrAdmin ? "All Workspace Jobs & Customers" : "My Assigned Work & Directory"}
            </span>
          </div>
        </div>

        <div style={{ display: "flex", gap: "0.5rem" }}>
          {activeSegment === "jobs" ? (
            <button
              type="button"
              className="lattice-btn-primary"
              style={{ padding: "0.45rem 0.85rem", fontSize: "0.85rem" }}
              onClick={() => {
                setCreateJobError(null);
                setCreateJobModalOpen(true);
              }}
            >
              + New Job
            </button>
          ) : (
            <button
              type="button"
              className="lattice-btn-primary"
              style={{ padding: "0.45rem 0.85rem", fontSize: "0.85rem" }}
              onClick={() => {
                setCreateCustError(null);
                setCreateCustModalOpen(true);
              }}
            >
              + New Customer
            </button>
          )}
        </div>
      </div>

      {/* Segment switcher tabs: Jobs | Customers */}
      <div
        style={{
          display: "flex",
          background: "var(--lattice-bg)",
          border: "1px solid var(--lattice-border)",
          borderRadius: "8px",
          padding: "0.25rem",
          marginBottom: "1rem",
        }}
      >
        <button
          type="button"
          style={{
            flex: 1,
            padding: "0.5rem",
            fontSize: "0.875rem",
            fontWeight: 600,
            border: "none",
            borderRadius: "6px",
            background: activeSegment === "jobs" ? "var(--lattice-surface, #ffffff)" : "transparent",
            color: activeSegment === "jobs" ? "var(--lattice-text)" : "var(--lattice-muted)",
            boxShadow: activeSegment === "jobs" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
            cursor: "pointer",
          }}
          onClick={() => {
            setActiveSegment("jobs");
            setSelectedCustomerIdFilter(null);
          }}
        >
          Jobs ({jobs.length})
        </button>
        <button
          type="button"
          style={{
            flex: 1,
            padding: "0.5rem",
            fontSize: "0.875rem",
            fontWeight: 600,
            border: "none",
            borderRadius: "6px",
            background: activeSegment === "customers" ? "var(--lattice-surface, #ffffff)" : "transparent",
            color: activeSegment === "customers" ? "var(--lattice-text)" : "var(--lattice-muted)",
            boxShadow: activeSegment === "customers" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
            cursor: "pointer",
          }}
          onClick={() => setActiveSegment("customers")}
        >
          Customers ({customers.length})
        </button>
      </div>

      {error && (
        <div
          className="lattice-alert-error"
          role="alert"
          style={{
            marginBottom: "1rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            <strong>Access Alert:</strong> {error}
          </div>
          <button
            type="button"
            className="lattice-btn-secondary"
            style={{ padding: "0.25rem 0.5rem", fontSize: "0.75rem" }}
            onClick={loadData}
          >
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem 1rem" }}>
          <p className="yp-muted">Loading records…</p>
        </div>
      ) : activeSegment === "jobs" ? (
        /* JOBS VIEW */
        <div>
          {/* Customer filter alert if set */}
          {selectedCustomerIdFilter && (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: "#f0f9ff",
                border: "1px solid #bae6fd",
                padding: "0.5rem 0.75rem",
                borderRadius: "6px",
                marginBottom: "0.75rem",
                fontSize: "0.85rem",
              }}
            >
              <span>
                Filtered by customer: <strong>{customerMap.get(selectedCustomerIdFilter)?.[customerNameField] || "Selected"}</strong>
              </span>
              <button
                type="button"
                className="app-link"
                style={{ fontSize: "0.8rem" }}
                onClick={() => setSelectedCustomerIdFilter(null)}
              >
                Clear filter
              </button>
            </div>
          )}

          {/* Status filter pills */}
          <div
            style={{
              display: "flex",
              gap: "0.4rem",
              marginBottom: "1rem",
              overflowX: "auto",
              paddingBottom: "0.25rem",
            }}
          >
            <button
              type="button"
              className={statusFilter === "all" ? "lattice-btn-primary" : "lattice-btn-secondary"}
              style={{ padding: "0.35rem 0.65rem", fontSize: "0.8rem", whiteSpace: "nowrap" }}
              onClick={() => setStatusFilter("all")}
            >
              All ({jobs.length})
            </button>
            <button
              type="button"
              className={statusFilter === "open" ? "lattice-btn-primary" : "lattice-btn-secondary"}
              style={{ padding: "0.35rem 0.65rem", fontSize: "0.8rem", whiteSpace: "nowrap" }}
              onClick={() => setStatusFilter("open")}
            >
              Open ({openCount})
            </button>
            <button
              type="button"
              className={statusFilter === "in_progress" ? "lattice-btn-primary" : "lattice-btn-secondary"}
              style={{ padding: "0.35rem 0.65rem", fontSize: "0.8rem", whiteSpace: "nowrap" }}
              onClick={() => setStatusFilter("in_progress")}
            >
              In progress ({inProgressCount})
            </button>
            <button
              type="button"
              className={statusFilter === "done" ? "lattice-btn-primary" : "lattice-btn-secondary"}
              style={{ padding: "0.35rem 0.65rem", fontSize: "0.8rem", whiteSpace: "nowrap" }}
              onClick={() => setStatusFilter("done")}
            >
              Done ({doneCount})
            </button>
          </div>

          {/* Jobs List */}
          {filteredJobs.length === 0 ? (
            <div className="lattice-empty-card" style={{ padding: "2.5rem 1rem", textAlign: "center" }}>
              <p className="yp-muted" style={{ margin: 0 }}>
                {statusFilter === "all"
                  ? "No jobs assigned to you yet."
                  : `No jobs currently in "${statusFilter.replace("_", " ")}" status.`}
              </p>
              <button
                type="button"
                className="lattice-btn-secondary"
                style={{ marginTop: "1rem" }}
                onClick={() => setCreateJobModalOpen(true)}
              >
                + Create First Job
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {filteredJobs.map((job) => {
                const status = String(job[jobStatusField] || "Open");
                const cust = customerMap.get(String(job[jobCustomerField]));
                const custName = cust ? String(cust[customerNameField] || "Customer") : "Customer";
                const custPhone = cust ? String(cust[customerPhoneField] || "") : "";

                const statusColor =
                  status === "Done"
                    ? { bg: "#f0fdf4", border: "#86efac", text: "#166534" }
                    : status === "In progress"
                    ? { bg: "#eff6ff", border: "#93c5fd", text: "#1e40af" }
                    : { bg: "#fffbeb", border: "#fde68a", text: "#92400e" };

                return (
                  <div
                    key={job.id}
                    className="lattice-card"
                    style={{
                      padding: "1rem",
                      borderRadius: "8px",
                      border: "1px solid var(--lattice-border)",
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.5rem",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "0.5rem" }}>
                      <strong style={{ fontSize: "1rem", lineHeight: 1.3 }}>
                        {String(job[jobTitleField] || "Untitled Job")}
                      </strong>
                      <button
                        type="button"
                        onClick={() => handleCycleStatus(job)}
                        title="Click to cycle status"
                        style={{
                          background: statusColor.bg,
                          border: `1px solid ${statusColor.border}`,
                          color: statusColor.text,
                          borderRadius: "12px",
                          padding: "0.2rem 0.6rem",
                          fontSize: "0.75rem",
                          fontWeight: 600,
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {status} ↷
                      </button>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem", color: "var(--lattice-muted)" }}>
                      <span>👤 {custName}</span>
                      {custPhone && (
                        <a
                          href={`tel:${custPhone}`}
                          style={{ color: "#2563eb", textDecoration: "none", fontSize: "0.8rem" }}
                        >
                          📞 {custPhone}
                        </a>
                      )}
                    </div>

                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        fontSize: "0.75rem",
                        color: "var(--lattice-muted)",
                        marginTop: "0.25rem",
                        paddingTop: "0.5rem",
                        borderTop: "1px solid var(--lattice-border)",
                      }}
                    >
                      <span>
                        Assignee:{" "}
                        <strong>
                          {job[jobAssigneeField] === client.currentUserId ? "You" : String(job[jobAssigneeField] || "None")}
                        </strong>
                      </span>
                      <span>ID: {job.id.slice(0, 8)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        /* CUSTOMERS VIEW */
        <div>
          {/* Search Bar */}
          <div style={{ marginBottom: "1rem" }}>
            <input
              type="text"
              placeholder="Search customers by name or phone…"
              value={customerSearch}
              onChange={(e) => setCustomerSearch(e.target.value)}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "0.55rem 0.85rem",
                fontSize: "0.875rem",
                borderRadius: "6px",
                border: "1px solid var(--lattice-border)",
              }}
            />
          </div>

          {filteredCustomers.length === 0 ? (
            <div className="lattice-empty-card" style={{ padding: "2.5rem 1rem", textAlign: "center" }}>
              <p className="yp-muted" style={{ margin: 0 }}>No customers found.</p>
              <button
                type="button"
                className="lattice-btn-secondary"
                style={{ marginTop: "1rem" }}
                onClick={() => setCreateCustModalOpen(true)}
              >
                + Add Customer
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {filteredCustomers.map((cust) => {
                const name = String(cust[customerNameField] || "Unnamed Customer");
                const phone = String(cust[customerPhoneField] || "");
                const custJobs = jobs.filter((j) => j[jobCustomerField] === cust.id);

                return (
                  <div
                    key={cust.id}
                    className="lattice-card"
                    style={{
                      padding: "1rem",
                      borderRadius: "8px",
                      border: "1px solid var(--lattice-border)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "1rem",
                      flexWrap: "wrap",
                    }}
                  >
                    <div>
                      <strong style={{ fontSize: "1rem", display: "block" }}>{name}</strong>
                      {phone && (
                        <a
                          href={`tel:${phone}`}
                          style={{
                            color: "#2563eb",
                            textDecoration: "none",
                            fontSize: "0.85rem",
                            display: "inline-block",
                            marginTop: "0.2rem",
                          }}
                        >
                          📞 {phone}
                        </a>
                      )}
                      <div style={{ fontSize: "0.75rem", color: "var(--lattice-muted)", marginTop: "0.25rem" }}>
                        {custJobs.length} associated job(s)
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button
                        type="button"
                        className="lattice-btn-secondary"
                        style={{ padding: "0.35rem 0.65rem", fontSize: "0.8rem" }}
                        onClick={() => {
                          setSelectedCustomerIdFilter(cust.id);
                          setActiveSegment("jobs");
                        }}
                      >
                        View Jobs ({custJobs.length})
                      </button>
                      <button
                        type="button"
                        className="lattice-btn-primary"
                        style={{ padding: "0.35rem 0.65rem", fontSize: "0.8rem" }}
                        onClick={() => {
                          setNewJobCustomerId(cust.id);
                          setCreateJobModalOpen(true);
                        }}
                      >
                        + Job
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* CREATE JOB MODAL */}
      {createJobModalOpen && (
        <div className="lattice-modal-overlay" role="dialog" aria-modal="true">
          <div className="lattice-modal" style={{ maxWidth: "500px" }}>
            <div className="lattice-modal-header">
              <h3>Create New Job</h3>
              <button
                type="button"
                className="lattice-modal-close"
                onClick={() => setCreateJobModalOpen(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleCreateJob}>
              <div className="lattice-modal-body" style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
                {createJobError && (
                  <div className="lattice-alert-error" role="alert">
                    {createJobError}
                  </div>
                )}

                <div>
                  <label style={{ fontSize: "0.85rem", fontWeight: 600 }}>Job Title</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Repair water pump"
                    value={newJobTitle}
                    onChange={(e) => setNewJobTitle(e.target.value)}
                    style={{ width: "100%", boxSizing: "border-box", padding: "0.5rem", borderRadius: "4px" }}
                  />
                </div>

                <div>
                  <label style={{ fontSize: "0.85rem", fontWeight: 600 }}>Customer</label>
                  <select
                    required
                    value={newJobCustomerId}
                    onChange={(e) => setNewJobCustomerId(e.target.value)}
                    style={{ width: "100%", boxSizing: "border-box", padding: "0.5rem", borderRadius: "4px" }}
                  >
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {String(c[customerNameField] || c.id)}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={{ fontSize: "0.85rem", fontWeight: 600 }}>Initial Status</label>
                  <select
                    value={newJobStatus}
                    onChange={(e) => setNewJobStatus(e.target.value)}
                    style={{ width: "100%", boxSizing: "border-box", padding: "0.5rem", borderRadius: "4px" }}
                  >
                    <option value="Open">Open</option>
                    <option value="In progress">In progress</option>
                    <option value="Done">Done</option>
                  </select>
                </div>

                <div
                  style={{
                    background: "var(--lattice-bg)",
                    border: "1px solid var(--lattice-border)",
                    borderRadius: "6px",
                    padding: "0.6rem 0.75rem",
                    fontSize: "0.8rem",
                  }}
                >
                  <strong>👤 Assignee:</strong>{" "}
                  <span>You ({client.currentUserEmail || "Current Member"}) - Automatically assigned</span>
                </div>
              </div>

              <div className="lattice-modal-footer" style={{ display: "flex", justifyContent: "space-between" }}>
                <button
                  type="button"
                  className="lattice-btn-secondary"
                  onClick={() => setCreateJobModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="lattice-btn-primary"
                  disabled={createJobPending}
                >
                  {createJobPending ? "Creating…" : "Create Job"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CREATE CUSTOMER MODAL */}
      {createCustModalOpen && (
        <div className="lattice-modal-overlay" role="dialog" aria-modal="true">
          <div className="lattice-modal" style={{ maxWidth: "450px" }}>
            <div className="lattice-modal-header">
              <h3>Add New Customer</h3>
              <button
                type="button"
                className="lattice-modal-close"
                onClick={() => setCreateCustModalOpen(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleCreateCustomer}>
              <div className="lattice-modal-body" style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
                {createCustError && (
                  <div className="lattice-alert-error" role="alert">
                    {createCustError}
                  </div>
                )}

                <div>
                  <label style={{ fontSize: "0.85rem", fontWeight: 600 }}>Customer Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Acme Corporation"
                    value={newCustName}
                    onChange={(e) => setNewCustName(e.target.value)}
                    style={{ width: "100%", boxSizing: "border-box", padding: "0.5rem", borderRadius: "4px" }}
                  />
                </div>

                <div>
                  <label style={{ fontSize: "0.85rem", fontWeight: 600 }}>Phone (Optional)</label>
                  <input
                    type="tel"
                    placeholder="e.g. 555-0199"
                    value={newCustPhone}
                    onChange={(e) => setNewCustPhone(e.target.value)}
                    style={{ width: "100%", boxSizing: "border-box", padding: "0.5rem", borderRadius: "4px" }}
                  />
                </div>
              </div>

              <div className="lattice-modal-footer" style={{ display: "flex", justifyContent: "space-between" }}>
                <button
                  type="button"
                  className="lattice-btn-secondary"
                  onClick={() => setCreateCustModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="lattice-btn-primary"
                  disabled={createCustPending}
                >
                  {createCustPending ? "Saving…" : "Save Customer"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
