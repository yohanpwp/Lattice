import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { FieldDefinition, SchemaDefinition, WorkspaceUser } from "@lattice/types";
import type { ProductClient } from "@lattice/sdk";
import { RelationPicker } from "./SchemaRecordModal";

type RecordModel = { id: string; [key: string]: any };

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as any).isAbort === true || (err as Error).name === "AbortError";
}

export const CJT_JOBS_REQUEST_KEY = "cjt_jobs_list";
export const CJT_CUSTOMER_LIST_REQUEST_KEY = "cjt_customer_list";
export const CJT_PICKER_REQUEST_KEY = "cjt_picker_customers";

export interface JobModalDraftState {
  isOpen: boolean;
  title: string;
  customerId: string;
  status: string;
  assigneeId: string;
  extraFieldValues: Record<string, any>;
  error: string | null;
  pending: boolean;
}

export type JobModalDraftAction =
  | { type: "OPEN"; customerId?: string }
  | { type: "CLOSE" }
  | { type: "SET_TITLE"; title: string }
  | { type: "SET_CUSTOMER"; customerId: string }
  | { type: "SET_STATUS"; status: string }
  | { type: "SET_ASSIGNEE"; assigneeId: string }
  | { type: "SET_EXTRA_FIELD"; fieldName: string; value: any }
  | { type: "SET_ERROR"; error: string | null }
  | { type: "SET_PENDING"; pending: boolean }
  | { type: "RESET" };

export function jobModalDraftReducer(state: JobModalDraftState, action: JobModalDraftAction): JobModalDraftState {
  switch (action.type) {
    case "OPEN":
      return {
        ...state,
        isOpen: true,
        title: "",
        extraFieldValues: {},
        error: null,
        customerId: action.customerId !== undefined ? action.customerId : state.customerId,
      };
    case "CLOSE":
    case "RESET":
      return {
        ...state,
        isOpen: false,
        title: "",
        extraFieldValues: {},
        error: null,
        pending: false,
      };
    case "SET_TITLE":
      return { ...state, title: action.title };
    case "SET_CUSTOMER":
      return { ...state, customerId: action.customerId };
    case "SET_STATUS":
      return { ...state, status: action.status };
    case "SET_ASSIGNEE":
      return { ...state, assigneeId: action.assigneeId };
    case "SET_EXTRA_FIELD":
      return {
        ...state,
        extraFieldValues: { ...state.extraFieldValues, [action.fieldName]: action.value },
      };
    case "SET_ERROR":
      return { ...state, error: action.error };
    case "SET_PENDING":
      return { ...state, pending: action.pending };
    default:
      return state;
  }
}

export function buildJobCreatePayload({
  title,
  customerId,
  status,
  assigneeId,
  extraJobFields,
  extraFieldValues,
  jobTitleField = "title",
  jobCustomerField = "customer",
  jobStatusField = "status",
  jobAssigneeField = "assignee",
}: {
  title: string;
  customerId: string;
  status: string;
  assigneeId: string;
  extraJobFields: FieldDefinition[];
  extraFieldValues: Record<string, any>;
  jobTitleField?: string;
  jobCustomerField?: string;
  jobStatusField?: string;
  jobAssigneeField?: string;
}): Record<string, any> {
  const payload: Record<string, any> = {
    [jobTitleField]: title.trim(),
    [jobCustomerField]: customerId,
    [jobStatusField]: status,
    [jobAssigneeField]: assigneeId,
  };

  for (const f of extraJobFields) {
    const val = extraFieldValues[f.name];
    if (val !== undefined && val !== "" && val !== null) {
      if (f.type === "number") {
        payload[f.name] = Number(val);
      } else if (f.type === "bool") {
        payload[f.name] = Boolean(val);
      } else if (f.type === "json" && typeof val === "string" && val.trim() !== "") {
        try {
          payload[f.name] = JSON.parse(val);
        } catch {
          throw new Error(`Field "${f.label || f.name}" must be valid JSON`);
        }
      } else if (f.type === "file") {
        if (val instanceof File || (typeof Blob !== "undefined" && val instanceof Blob)) {
          payload[f.name] = val;
        } else if (typeof val === "string" && val.trim() !== "") {
          payload[f.name] = val;
        }
      } else {
        payload[f.name] = val;
      }
    }
  }

  return payload;
}

export interface CustomerJobTrackingViewProps {
  client: ProductClient;
  schemas?: SchemaDefinition[];
  initialSegment?: "jobs" | "customers";
  initialCustomerPhoneField?: string;
  initialCreateCustModalOpen?: boolean;
  initialLoadingJobs?: boolean;
  initialJobs?: RecordModel[];
  initialError?: string;
  initialCreateJobModalOpen?: boolean;
  initialExtraFieldValues?: Record<string, any>;
  onModalDraftChange?: (draft: JobModalDraftState) => void;
}

export function CustomerJobTrackingView({
  client,
  schemas = [],
  initialSegment = "jobs",
  initialCustomerPhoneField,
  initialCreateCustModalOpen = false,
  initialLoadingJobs,
  initialJobs,
  initialError,
  initialCreateJobModalOpen = false,
  initialExtraFieldValues,
  onModalDraftChange,
}: CustomerJobTrackingViewProps) {
  const [activeSegment, setActiveSegment] = useState<"jobs" | "customers">(initialSegment);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [jobsSearch, setJobsSearch] = useState<string>("");
  const [customerSearch, setCustomerSearch] = useState<string>("");

  // Request sequencing refs to ignore stale out-of-order responses
  const jobsReqSeq = useRef(0);
  const customerReqSeq = useRef(0);
  const pickerReqSeq = useRef(0);

  // Jobs pagination
  const [jobs, setJobs] = useState<RecordModel[]>(initialJobs ?? []);
  const [jobsPage, setJobsPage] = useState(1);
  const [jobsPerPage] = useState(25);
  const [jobsTotalPages, setJobsTotalPages] = useState(1);
  const [jobsTotalItems, setJobsTotalItems] = useState(initialJobs?.length ?? 0);
  const [loadingJobs, setLoadingJobs] = useState(initialLoadingJobs ?? (initialJobs ? false : true));

  // Customers pagination
  const [customers, setCustomers] = useState<RecordModel[]>([]);
  const [customersPage, setCustomersPage] = useState(1);
  const [customersPerPage] = useState(25);
  const [customersTotalPages, setCustomersTotalPages] = useState(1);
  const [customersTotalItems, setCustomersTotalItems] = useState(0);
  const [loadingCustomers, setLoadingCustomers] = useState(true);

  // Customer cache for relation display
  const [customerCache, setCustomerCache] = useState<Record<string, RecordModel>>({});

  // Workspace team members for assignee picker (owners / admins)
  const [workspaceUsers, setWorkspaceUsers] = useState<WorkspaceUser[]>([]);

  const [error, setError] = useState<string | null>(initialError ?? null);

  // Mappings (customerPhoneField is empty if no phone field mapped)
  const [customerDataset, setCustomerDataset] = useState("customers");
  const [customerNameField, setCustomerNameField] = useState("name");
  const [customerPhoneField, setCustomerPhoneField] = useState(initialCustomerPhoneField ?? "");
  const [isPhoneRequiredState, setIsPhoneRequiredState] = useState(false);
  const custSchema = schemas.find((s) => s.schema_id === customerDataset);
  const phoneFieldDef = custSchema?.fields.find((f) => f.name === customerPhoneField);
  const isPhoneRequired = Boolean(phoneFieldDef?.required || isPhoneRequiredState);
  const [jobDataset, setJobDataset] = useState("jobs");
  const [jobTitleField, setJobTitleField] = useState("title");
  const [jobCustomerField, setJobCustomerField] = useState("customer");
  const [jobStatusField, setJobStatusField] = useState("status");
  const [jobAssigneeField, setJobAssigneeField] = useState("assignee");

  // Job creation modal state (managed via reducer to guarantee clean draft reset)
  const [jobDraft, dispatchJobDraft] = useReducer(jobModalDraftReducer, {
    isOpen: initialCreateJobModalOpen ?? false,
    title: "",
    customerId: "",
    status: "Open",
    assigneeId: "",
    extraFieldValues: initialExtraFieldValues ?? {},
    error: null,
    pending: false,
  });

  const handleOpenCreateJobModal = useCallback((customerId?: string) => {
    dispatchJobDraft({ type: "OPEN", customerId });
  }, []);

  const handleCloseCreateJobModal = useCallback(() => {
    dispatchJobDraft({ type: "CLOSE" });
  }, []);

  useEffect(() => {
    if (!jobDraft.isOpen) {
      dispatchJobDraft({ type: "RESET" });
    }
  }, [jobDraft.isOpen]);

  useEffect(() => {
    onModalDraftChange?.(jobDraft);
  }, [jobDraft, onModalDraftChange]);

  const jobSchema = schemas.find((s) => s.schema_id === jobDataset);
  const extraJobFields = (jobSchema?.fields || []).filter(
    (f) =>
      !f.system &&
      !["id", "created", "updated", jobTitleField, jobCustomerField, jobStatusField, jobAssigneeField].includes(f.name)
  );

  // Customer picker in Job modal (server-side search & pagination)
  const [pickerSearch, setPickerSearch] = useState("");
  const [pickerPage, setPickerPage] = useState(1);
  const [pickerPerPage] = useState(10);
  const [pickerTotalPages, setPickerTotalPages] = useState(1);
  const [pickerTotalItems, setPickerTotalItems] = useState(0);
  const [pickerCustomers, setPickerCustomers] = useState<RecordModel[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);

  // Customer creation modal state
  const [createCustModalOpen, setCreateCustModalOpen] = useState(initialCreateCustModalOpen);
  const [newCustName, setNewCustName] = useState("");
  const [newCustPhone, setNewCustPhone] = useState("");
  const [createCustPending, setCreateCustPending] = useState(false);
  const [createCustError, setCreateCustError] = useState<string | null>(null);

  const resetCreateCustDraft = useCallback(() => {
    setNewCustName("");
    setNewCustPhone("");
    setCreateCustError(null);
  }, []);

  const handleOpenCreateCustModal = useCallback(() => {
    resetCreateCustDraft();
    setCreateCustModalOpen(true);
  }, [resetCreateCustDraft]);

  const handleCloseCreateCustModal = useCallback(() => {
    resetCreateCustDraft();
    setCreateCustModalOpen(false);
  }, [resetCreateCustDraft]);

  useEffect(() => {
    if (!createCustModalOpen) {
      resetCreateCustDraft();
    }
  }, [createCustModalOpen, resetCreateCustDraft]);

  const [selectedCustomerIdFilter, setSelectedCustomerIdFilter] = useState<string | null>(null);

  // Load module configuration mappings
  useEffect(() => {
    let ignore = false;
    if (typeof client.getWorkspaceModule === "function") {
      client
        .getWorkspaceModule("customer_job_tracking")
        .then((mod) => {
          if (!ignore && mod?.mapping) {
            if (mod.mapping.customer_dataset) setCustomerDataset(mod.mapping.customer_dataset);
            if (mod.mapping.customer_name_field) setCustomerNameField(mod.mapping.customer_name_field);
            setCustomerPhoneField(mod.mapping.customer_phone_field || "");
            if (mod.mapping.job_dataset) setJobDataset(mod.mapping.job_dataset);
            if (mod.mapping.job_title_field) setJobTitleField(mod.mapping.job_title_field);
            if (mod.mapping.job_customer_field) setJobCustomerField(mod.mapping.job_customer_field);
            if (mod.mapping.job_status_field) setJobStatusField(mod.mapping.job_status_field);
            if (mod.mapping.job_assignee_field) setJobAssigneeField(mod.mapping.job_assignee_field);
          }
        })
        .catch(() => {});
    }
    return () => {
      ignore = true;
    };
  }, [client]);

  // Determine if mapped customer phone field is required
  useEffect(() => {
    let ignore = false;
    if (customerPhoneField && typeof client.getSchema === "function") {
      client
        .getSchema(customerDataset)
        .then((s) => {
          if (!ignore && s) {
            const f = s.fields?.find((field) => field.name === customerPhoneField);
            setIsPhoneRequiredState(Boolean(f?.required));
          }
        })
        .catch(() => {});
    }
    return () => {
      ignore = true;
    };
  }, [client, customerDataset, customerPhoneField]);

  // Load team users for assignee picker when owner/admin
  useEffect(() => {
    let ignore = false;
    if (client.isOwnerOrAdmin && typeof client.getWorkspaceUsers === "function") {
      client
        .getWorkspaceUsers()
        .then((list) => {
          if (!ignore && Array.isArray(list)) {
            const activeUsers = list.filter((u) => !u.disabled);
            setWorkspaceUsers(activeUsers);
            if (!jobDraft.assigneeId) {
              dispatchJobDraft({
                type: "SET_ASSIGNEE",
                assigneeId: client.currentUserId || activeUsers[0]?.id || "",
              });
            }
          }
        })
        .catch(() => {});
    }
    return () => {
      ignore = true;
    };
  }, [client, client.isOwnerOrAdmin, client.currentUserId, jobDraft.assigneeId]);

  // Build PocketBase filter expression for jobs
  const buildJobFilter = useCallback(() => {
    const parts: string[] = [];
    if (selectedCustomerIdFilter) {
      parts.push(
        client.filter
          ? client.filter(`${jobCustomerField} = {:cid}`, { cid: selectedCustomerIdFilter })
          : `${jobCustomerField} = '${selectedCustomerIdFilter}'`
      );
    }
    if (statusFilter === "open") {
      parts.push(
        client.filter
          ? client.filter(`${jobStatusField} = {:st}`, { st: "Open" })
          : `${jobStatusField} = 'Open'`
      );
    } else if (statusFilter === "in_progress") {
      parts.push(
        client.filter
          ? client.filter(`${jobStatusField} = {:st}`, { st: "In progress" })
          : `${jobStatusField} = 'In progress'`
      );
    } else if (statusFilter === "done") {
      parts.push(
        client.filter
          ? client.filter(`${jobStatusField} = {:st}`, { st: "Done" })
          : `${jobStatusField} = 'Done'`
      );
    }
    if (jobsSearch.trim()) {
      const q = jobsSearch.trim();
      parts.push(
        client.filter
          ? client.filter(`${jobTitleField} ~ {:q}`, { q })
          : `${jobTitleField} ~ '${q}'`
      );
    }
    return parts.length > 0 ? parts.join(" && ") : undefined;
  }, [client, jobCustomerField, jobStatusField, jobTitleField, selectedCustomerIdFilter, statusFilter, jobsSearch]);

  // Load Jobs from server
  const loadJobs = useCallback(async () => {
    const seq = ++jobsReqSeq.current;
    setLoadingJobs(true);
    setError(null);
    try {
      const filter = buildJobFilter();
      const res = await client.collection(jobDataset).getList(jobsPage, jobsPerPage, {
        filter,
        sort: "-created",
        expand: jobCustomerField,
        requestKey: "cjt_jobs_list",
      });

      if (seq !== jobsReqSeq.current) return;

      setJobs(res.items);
      setJobsTotalPages(res.totalPages || 1);
      setJobsTotalItems(res.totalItems || 0);

      // Cache expanded customers for fast lookup
      const cacheUpdates: Record<string, RecordModel> = {};
      for (const item of res.items) {
        if (item.expand && item.expand[jobCustomerField]) {
          const cust = item.expand[jobCustomerField];
          cacheUpdates[cust.id] = cust;
        }
      }
      if (Object.keys(cacheUpdates).length > 0) {
        setCustomerCache((prev) => ({ ...prev, ...cacheUpdates }));
      }
    } catch (err: unknown) {
      if (seq !== jobsReqSeq.current) return;
      if (isAbortError(err)) {
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load jobs");
    } finally {
      if (seq === jobsReqSeq.current) {
        setLoadingJobs(false);
      }
    }
  }, [client, jobDataset, jobCustomerField, jobsPage, jobsPerPage, buildJobFilter]);

  // Load Customers from server
  const loadCustomers = useCallback(async () => {
    const seq = ++customerReqSeq.current;
    setLoadingCustomers(true);
    setError(null);
    try {
      let filter: string | undefined;
      if (customerSearch.trim()) {
        const q = customerSearch.trim();
        if (customerPhoneField) {
          filter = client.filter
            ? client.filter(`${customerNameField} ~ {:q} || ${customerPhoneField} ~ {:q}`, { q })
            : `(${customerNameField} ~ '${q}' || ${customerPhoneField} ~ '${q}')`;
        } else {
          filter = client.filter
            ? client.filter(`${customerNameField} ~ {:q}`, { q })
            : `${customerNameField} ~ '${q}'`;
        }
      }

      const res = await client.collection(customerDataset).getList(customersPage, customersPerPage, {
        filter,
        sort: "created",
        requestKey: "cjt_customer_list",
      });

      if (seq !== customerReqSeq.current) return;

      setCustomers(res.items);
      setCustomersTotalPages(res.totalPages || 1);
      setCustomersTotalItems(res.totalItems || 0);

      // Update customer cache
      const cacheUpdates: Record<string, RecordModel> = {};
      for (const c of res.items) {
        cacheUpdates[c.id] = c;
      }
      setCustomerCache((prev) => ({ ...prev, ...cacheUpdates }));

      // Default job customer id if empty
      if (!jobDraft.customerId && res.items.length > 0 && res.items[0]) {
        dispatchJobDraft({ type: "SET_CUSTOMER", customerId: res.items[0].id });
      }
    } catch (err: unknown) {
      if (seq !== customerReqSeq.current) return;
      if (isAbortError(err)) {
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load customers");
    } finally {
      if (seq === customerReqSeq.current) {
        setLoadingCustomers(false);
      }
    }
  }, [client, customerDataset, customerNameField, customerPhoneField, customersPage, customersPerPage, customerSearch, jobDraft.customerId]);

  // Load Customer Picker records (for the modal dropdown)
  const loadPickerCustomers = useCallback(async () => {
    const seq = ++pickerReqSeq.current;
    setPickerLoading(true);
    try {
      let filter: string | undefined;
      if (pickerSearch.trim()) {
        const q = pickerSearch.trim();
        if (customerPhoneField) {
          filter = client.filter
            ? client.filter(`${customerNameField} ~ {:q} || ${customerPhoneField} ~ {:q}`, { q })
            : `(${customerNameField} ~ '${q}' || ${customerPhoneField} ~ '${q}')`;
        } else {
          filter = client.filter
            ? client.filter(`${customerNameField} ~ {:q}`, { q })
            : `${customerNameField} ~ '${q}'`;
        }
      }

      const res = await client.collection(customerDataset).getList(pickerPage, pickerPerPage, {
        filter,
        sort: "created",
        requestKey: "cjt_picker_customers",
      });

      if (seq !== pickerReqSeq.current) return;

      let items = [...res.items];
      // Ensure currently selected customer is present in list
      if (jobDraft.customerId && !items.some((c) => c.id === jobDraft.customerId)) {
        try {
          const selected = await client.collection(customerDataset).getOne(jobDraft.customerId, { requestKey: null });
          if (seq !== pickerReqSeq.current) return;
          if (selected) {
            items = [selected, ...items];
          }
        } catch {
          // If customer not found, proceed
        }
      }

      if (seq !== pickerReqSeq.current) return;

      setPickerCustomers(items);
      setPickerTotalPages(res.totalPages || 1);
      setPickerTotalItems(res.totalItems || 0);

      if (!jobDraft.customerId && items[0]) {
        dispatchJobDraft({ type: "SET_CUSTOMER", customerId: items[0].id });
      }
    } catch (err: unknown) {
      if (seq !== pickerReqSeq.current) return;
      if (isAbortError(err)) {
        return;
      }
      dispatchJobDraft({
        type: "SET_ERROR",
        error: err instanceof Error ? err.message : "Failed to load customers",
      });
    } finally {
      if (seq === pickerReqSeq.current) {
        setPickerLoading(false);
      }
    }
  }, [client, customerDataset, customerNameField, customerPhoneField, pickerSearch, pickerPage, pickerPerPage, jobDraft.customerId]);

  // Effects to trigger loads
  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    loadCustomers();
  }, [loadCustomers]);

  useEffect(() => {
    if (jobDraft.isOpen) {
      loadPickerCustomers();
    }
  }, [jobDraft.isOpen, loadPickerCustomers]);

  // Realtime subscriptions
  useEffect(() => {
    let unsubscribed = false;
    client
      .collection(jobDataset)
      .subscribe("*", () => {
        if (!unsubscribed) {
          loadJobs();
        }
      })
      .catch(() => {});

    client
      .collection(customerDataset)
      .subscribe("*", () => {
        if (!unsubscribed) {
          loadCustomers();
          if (jobDraft.isOpen) {
            loadPickerCustomers();
          }
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
  }, [client, jobDataset, customerDataset, loadJobs, loadCustomers, loadPickerCustomers, jobDraft.isOpen]);

  // Quick status transition
  async function handleCycleStatus(job: RecordModel) {
    const rawStatus = job[jobStatusField];
    const currentStatus = Array.isArray(rawStatus) ? String(rawStatus[0] || "Open") : String(rawStatus || "Open");
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
    if (!jobDraft.title.trim()) return;

    dispatchJobDraft({ type: "SET_PENDING", pending: true });
    dispatchJobDraft({ type: "SET_ERROR", error: null });

    try {
      const assigneeId = client.isOwnerOrAdmin
        ? jobDraft.assigneeId || client.currentUserId || workspaceUsers[0]?.id || ""
        : client.currentUserId || "";

      const payload = buildJobCreatePayload({
        title: jobDraft.title,
        customerId: jobDraft.customerId,
        status: jobDraft.status,
        assigneeId,
        extraJobFields,
        extraFieldValues: jobDraft.extraFieldValues,
        jobTitleField,
        jobCustomerField,
        jobStatusField,
        jobAssigneeField,
      });

      await client.collection(jobDataset).create(payload);
      dispatchJobDraft({ type: "RESET" });
      await loadJobs();
    } catch (err: unknown) {
      dispatchJobDraft({
        type: "SET_ERROR",
        error: err instanceof Error ? err.message : "Failed to create job",
      });
    } finally {
      dispatchJobDraft({ type: "SET_PENDING", pending: false });
    }
  }

  // Handle create customer
  async function handleCreateCustomer(e: React.FormEvent) {
    e.preventDefault();
    if (!newCustName.trim()) return;
    if (customerPhoneField && isPhoneRequired && !newCustPhone.trim()) {
      setCreateCustError("Phone number is required");
      return;
    }

    setCreateCustPending(true);
    setCreateCustError(null);

    try {
      const payload: Record<string, any> = {
        [customerNameField]: newCustName.trim(),
      };
      if (customerPhoneField && (isPhoneRequired || newCustPhone.trim())) {
        payload[customerPhoneField] = newCustPhone.trim();
      }

      const created = await client.collection(customerDataset).create(payload);
      resetCreateCustDraft();
      setCreateCustModalOpen(false);
      await loadCustomers();
      if (created?.id) {
        dispatchJobDraft({ type: "SET_CUSTOMER", customerId: created.id });
      }
    } catch (err: unknown) {
      setCreateCustError(err instanceof Error ? err.message : "Failed to create customer");
    } finally {
      setCreateCustPending(false);
    }
  }

  return (
    <div className="lattice-container" style={{ padding: "0.5rem 0", maxWidth: "900px", margin: "0 auto" }}>
      {/* Header & New Button */}
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
              onClick={() => handleOpenCreateJobModal()}
            >
              + New Job
            </button>
          ) : (
            <button
              type="button"
              className="lattice-btn-primary"
              style={{ padding: "0.45rem 0.85rem", fontSize: "0.85rem" }}
              onClick={handleOpenCreateCustModal}
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
          Jobs ({jobsTotalItems})
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
          Customers ({customersTotalItems})
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
            onClick={() => {
              loadJobs();
              loadCustomers();
            }}
          >
            Retry
          </button>
        </div>
      )}

      {activeSegment === "jobs" ? (
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
                Filtered by customer:{" "}
                <strong>
                  {customerCache[selectedCustomerIdFilter]?.[customerNameField] || "Selected Customer"}
                </strong>
              </span>
              <button
                type="button"
                className="app-link"
                style={{ fontSize: "0.8rem" }}
                onClick={() => {
                  setSelectedCustomerIdFilter(null);
                  setJobsPage(1);
                }}
              >
                Clear filter
              </button>
            </div>
          )}

          {/* Search bar for Jobs */}
          <div style={{ marginBottom: "0.75rem" }}>
            <input
              type="text"
              placeholder="Search jobs by title…"
              value={jobsSearch}
              onChange={(e) => {
                setJobsSearch(e.target.value);
                setJobsPage(1);
              }}
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

          {/* Status filter pills without misleading partial counts */}
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
              onClick={() => {
                setStatusFilter("all");
                setJobsPage(1);
              }}
            >
              All
            </button>
            <button
              type="button"
              className={statusFilter === "open" ? "lattice-btn-primary" : "lattice-btn-secondary"}
              style={{ padding: "0.35rem 0.65rem", fontSize: "0.8rem", whiteSpace: "nowrap" }}
              onClick={() => {
                setStatusFilter("open");
                setJobsPage(1);
              }}
            >
              Open
            </button>
            <button
              type="button"
              className={statusFilter === "in_progress" ? "lattice-btn-primary" : "lattice-btn-secondary"}
              style={{ padding: "0.35rem 0.65rem", fontSize: "0.8rem", whiteSpace: "nowrap" }}
              onClick={() => {
                setStatusFilter("in_progress");
                setJobsPage(1);
              }}
            >
              In progress
            </button>
            <button
              type="button"
              className={statusFilter === "done" ? "lattice-btn-primary" : "lattice-btn-secondary"}
              style={{ padding: "0.35rem 0.65rem", fontSize: "0.8rem", whiteSpace: "nowrap" }}
              onClick={() => {
                setStatusFilter("done");
                setJobsPage(1);
              }}
            >
              Done
            </button>
          </div>

          {/* Jobs List */}
          {loadingJobs ? (
            <div style={{ textAlign: "center", padding: "3rem 1rem" }}>
              <p className="yp-muted">Loading jobs…</p>
            </div>
          ) : jobs.length === 0 ? (
            <div className="lattice-empty-card" style={{ padding: "2.5rem 1rem", textAlign: "center" }}>
              <p className="yp-muted" style={{ margin: 0 }}>
                {statusFilter === "all"
                  ? "No jobs found."
                  : `No jobs currently in "${statusFilter.replace("_", " ")}" status.`}
              </p>
              <button
                type="button"
                className="lattice-btn-secondary"
                style={{ marginTop: "1rem" }}
                onClick={() => handleOpenCreateJobModal()}
              >
                + Create First Job
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {jobs.map((job) => {
                const rawStatus = job[jobStatusField];
                const status = Array.isArray(rawStatus) ? String(rawStatus[0] || "Open") : String(rawStatus || "Open");
                const cust = (job.expand && job.expand[jobCustomerField]) || customerCache[String(job[jobCustomerField])];
                const custName = cust ? String(cust[customerNameField] || "Customer") : "Customer";
                const custPhone = customerPhoneField && cust ? String(cust[customerPhoneField] || "") : "";

                const statusColor =
                  status === "Done"
                    ? { bg: "#f0fdf4", border: "#86efac", text: "#166534" }
                    : status === "In progress"
                    ? { bg: "#eff6ff", border: "#93c5fd", text: "#1e40af" }
                    : { bg: "#fffbeb", border: "#fde68a", text: "#92400e" };

                const assigneeId = job[jobAssigneeField];
                let assigneeDisplay = "None";
                if (assigneeId === client.currentUserId) {
                  assigneeDisplay = "You";
                } else {
                  const matchedUser = workspaceUsers.find((u) => u.id === assigneeId);
                  if (matchedUser) {
                    assigneeDisplay = matchedUser.name
                      ? `${matchedUser.name} (${matchedUser.email})`
                      : matchedUser.email;
                  } else if (assigneeId) {
                    assigneeDisplay = String(assigneeId);
                  }
                }

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
                      {customerPhoneField && custPhone ? (
                        <a
                          href={`tel:${custPhone}`}
                          style={{ color: "#2563eb", textDecoration: "none", fontSize: "0.8rem" }}
                        >
                          📞 {custPhone}
                        </a>
                      ) : null}
                    </div>

                    {extraJobFields.map((f) => {
                      const val = job[f.name];
                      if (val === undefined || val === null || val === "") return null;
                      const displayVal =
                        f.type === "bool"
                          ? val
                            ? "Yes"
                            : "No"
                          : f.type === "file"
                          ? `📎 ${val}`
                          : typeof val === "object"
                          ? JSON.stringify(val)
                          : String(val);
                      return (
                        <div key={f.name} style={{ fontSize: "0.8rem", color: "var(--lattice-muted)" }}>
                          <strong>{f.label || f.name}:</strong> {displayVal}
                        </div>
                      );
                    })}

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
                        Assignee: <strong>{assigneeDisplay}</strong>
                      </span>
                      <span>ID: {job.id.slice(0, 8)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Jobs Pagination Footer */}
          <footer className="lattice-table-footer" style={{ marginTop: "0.5rem" }}>
            <div className="lattice-table-pagination-info">
              Showing page {jobsPage} of {jobsTotalPages} ({jobsTotalItems} total jobs)
            </div>
            <div className="lattice-table-pagination-controls" style={{ display: "flex", gap: "0.4rem" }}>
              <button
                type="button"
                className="lattice-btn-table"
                disabled={jobsPage <= 1 || loadingJobs}
                onClick={() => setJobsPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </button>
              <button
                type="button"
                className="lattice-btn-table"
                disabled={jobsPage >= jobsTotalPages || loadingJobs}
                onClick={() => setJobsPage((p) => Math.min(jobsTotalPages, p + 1))}
              >
                Next
              </button>
            </div>
          </footer>
        </div>
      ) : (
        /* CUSTOMERS VIEW */
        <div>
          {/* Search Bar */}
          <div style={{ marginBottom: "1rem" }}>
            <input
              type="text"
              placeholder={customerPhoneField ? "Search customers by name or phone…" : "Search customers by name…"}
              value={customerSearch}
              onChange={(e) => {
                setCustomerSearch(e.target.value);
                setCustomersPage(1);
              }}
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

          {loadingCustomers ? (
            <div style={{ textAlign: "center", padding: "3rem 1rem" }}>
              <p className="yp-muted">Loading customers…</p>
            </div>
          ) : customers.length === 0 ? (
            <div className="lattice-empty-card" style={{ padding: "2.5rem 1rem", textAlign: "center" }}>
              <p className="yp-muted" style={{ margin: 0 }}>No customers found.</p>
              <button
                type="button"
                className="lattice-btn-secondary"
                style={{ marginTop: "1rem" }}
                onClick={handleOpenCreateCustModal}
              >
                + Add Customer
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {customers.map((cust) => {
                const name = String(cust[customerNameField] || "Unnamed Customer");
                const phone = customerPhoneField ? String(cust[customerPhoneField] || "") : "";

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
                      {customerPhoneField && phone ? (
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
                      ) : null}
                    </div>

                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button
                        type="button"
                        className="lattice-btn-secondary"
                        style={{ padding: "0.35rem 0.65rem", fontSize: "0.8rem" }}
                        onClick={() => {
                          setSelectedCustomerIdFilter(cust.id);
                          setJobsPage(1);
                          setActiveSegment("jobs");
                        }}
                      >
                        View Jobs
                      </button>
                      <button
                        type="button"
                        className="lattice-btn-primary"
                        style={{ padding: "0.35rem 0.65rem", fontSize: "0.8rem" }}
                        onClick={() => handleOpenCreateJobModal(cust.id)}
                      >
                        + Job
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Customers Pagination Footer */}
          <footer className="lattice-table-footer" style={{ marginTop: "0.5rem" }}>
            <div className="lattice-table-pagination-info">
              Showing page {customersPage} of {customersTotalPages} ({customersTotalItems} total customers)
            </div>
            <div className="lattice-table-pagination-controls" style={{ display: "flex", gap: "0.4rem" }}>
              <button
                type="button"
                className="lattice-btn-table"
                disabled={customersPage <= 1 || loadingCustomers}
                onClick={() => setCustomersPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </button>
              <button
                type="button"
                className="lattice-btn-table"
                disabled={customersPage >= customersTotalPages || loadingCustomers}
                onClick={() => setCustomersPage((p) => Math.min(customersTotalPages, p + 1))}
              >
                Next
              </button>
            </div>
          </footer>
        </div>
      )}

      {/* CREATE JOB MODAL */}
      {jobDraft.isOpen && (
        <div className="lattice-modal-overlay" role="dialog" aria-modal="true">
          <div className="lattice-modal" style={{ maxWidth: "500px" }}>
            <div className="lattice-modal-header">
              <h3>Create New Job</h3>
              <button
                type="button"
                className="lattice-modal-close"
                onClick={handleCloseCreateJobModal}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleCreateJob}>
              <div className="lattice-modal-body" style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
                {jobDraft.error && (
                  <div className="lattice-alert-error" role="alert">
                    {jobDraft.error}
                  </div>
                )}

                <div>
                  <label style={{ fontSize: "0.85rem", fontWeight: 600 }}>Job Title</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Repair water pump"
                    value={jobDraft.title}
                    onChange={(e) => dispatchJobDraft({ type: "SET_TITLE", title: e.target.value })}
                    style={{ width: "100%", boxSizing: "border-box", padding: "0.5rem", borderRadius: "4px" }}
                  />
                </div>

                {/* Customer Picker with server-side search and pagination */}
                <div>
                  <label style={{ fontSize: "0.85rem", fontWeight: 600 }}>Customer</label>
                  <input
                    type="text"
                    placeholder={customerPhoneField ? "Search customers by name or phone…" : "Search customers by name…"}
                    value={pickerSearch}
                    onChange={(e) => {
                      setPickerSearch(e.target.value);
                      setPickerPage(1);
                    }}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      padding: "0.45rem",
                      marginBottom: "0.35rem",
                      borderRadius: "4px",
                      fontSize: "0.85rem",
                      border: "1px solid var(--lattice-border)",
                    }}
                  />
                  <select
                    required
                    value={jobDraft.customerId}
                    onChange={(e) => dispatchJobDraft({ type: "SET_CUSTOMER", customerId: e.target.value })}
                    style={{ width: "100%", boxSizing: "border-box", padding: "0.5rem", borderRadius: "4px" }}
                  >
                    {pickerCustomers.length === 0 && <option value="">No customers found</option>}
                    {pickerCustomers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {String(c[customerNameField] || c.id)} {customerPhoneField && c[customerPhoneField] ? `(${c[customerPhoneField]})` : ""}
                      </option>
                    ))}
                  </select>
                  {pickerTotalPages > 1 && (
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        fontSize: "0.75rem",
                        color: "var(--lattice-muted)",
                        marginTop: "0.3rem",
                      }}
                    >
                      <span>
                        Page {pickerPage} of {pickerTotalPages} ({pickerTotalItems} customers)
                      </span>
                      <div style={{ display: "flex", gap: "0.3rem" }}>
                        <button
                          type="button"
                          className="lattice-btn-secondary"
                          style={{ padding: "0.15rem 0.5rem", fontSize: "0.75rem" }}
                          disabled={pickerPage <= 1 || pickerLoading}
                          onClick={() => setPickerPage((p) => Math.max(1, p - 1))}
                        >
                          Prev
                        </button>
                        <button
                          type="button"
                          className="lattice-btn-secondary"
                          style={{ padding: "0.15rem 0.5rem", fontSize: "0.75rem" }}
                          disabled={pickerPage >= pickerTotalPages || pickerLoading}
                          onClick={() => setPickerPage((p) => Math.min(pickerTotalPages, p + 1))}
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div>
                  <label style={{ fontSize: "0.85rem", fontWeight: 600 }}>Initial Status</label>
                  <select
                    value={jobDraft.status}
                    onChange={(e) => dispatchJobDraft({ type: "SET_STATUS", status: e.target.value })}
                    style={{ width: "100%", boxSizing: "border-box", padding: "0.5rem", borderRadius: "4px" }}
                  >
                    <option value="Open">Open</option>
                    <option value="In progress">In progress</option>
                    <option value="Done">Done</option>
                  </select>
                </div>

                {/* Assignee selection */}
                {client.isOwnerOrAdmin ? (
                  <div>
                    <label style={{ fontSize: "0.85rem", fontWeight: 600 }}>Assignee</label>
                    <select
                      required
                      value={jobDraft.assigneeId || client.currentUserId || ""}
                      onChange={(e) => dispatchJobDraft({ type: "SET_ASSIGNEE", assigneeId: e.target.value })}
                      style={{ width: "100%", boxSizing: "border-box", padding: "0.5rem", borderRadius: "4px" }}
                    >
                      {workspaceUsers.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name ? `${u.name} (${u.email})` : u.email}
                          {u.id === client.currentUserId ? " — You" : ""}
                        </option>
                      ))}
                      {!workspaceUsers.some((u) => u.id === client.currentUserId) && (
                        <option value={client.currentUserId || ""}>
                          You ({client.currentUserEmail || "Current Member"})
                        </option>
                      )}
                    </select>
                  </div>
                ) : (
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
                )}

                {extraJobFields.map((f) => {
                  const id = `cjt-field-${f.name}`;
                  return (
                    <div key={f.name}>
                      <label htmlFor={id} style={{ fontSize: "0.85rem", fontWeight: 600, display: "block", marginBottom: "0.25rem" }}>
                        {f.label || f.name} {f.required && <span className="lattice-req">*</span>}
                        {f.type === "relation" && f.target && (
                          <span className="lattice-field-hint" style={{ fontSize: "0.75rem", color: "var(--lattice-muted)", fontWeight: "normal" }}> → {f.target}</span>
                        )}
                      </label>

                      {f.type === "select" ? (
                        <select
                          id={id}
                          className="lattice-input"
                          value={String(jobDraft.extraFieldValues[f.name] ?? "")}
                          onChange={(e) => dispatchJobDraft({ type: "SET_EXTRA_FIELD", fieldName: f.name, value: e.target.value })}
                          required={Boolean(f.required)}
                          style={{ width: "100%", boxSizing: "border-box" }}
                        >
                          <option value="">-- Select {f.label || f.name} --</option>
                          {(f.options || []).map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}
                            </option>
                          ))}
                        </select>
                      ) : f.type === "relation" ? (
                        <RelationPicker
                          id={id}
                          field={f}
                          client={client}
                          value={String(jobDraft.extraFieldValues[f.name] ?? "")}
                          onChange={(val) => dispatchJobDraft({ type: "SET_EXTRA_FIELD", fieldName: f.name, value: val })}
                          required={Boolean(f.required)}
                          schemas={schemas}
                        />
                      ) : f.type === "bool" ? (
                        <div className="lattice-checkbox-wrapper" style={{ marginTop: "0.25rem" }}>
                          <input
                            id={id}
                            type="checkbox"
                            checked={Boolean(jobDraft.extraFieldValues[f.name])}
                            onChange={(e) => dispatchJobDraft({ type: "SET_EXTRA_FIELD", fieldName: f.name, value: e.target.checked })}
                          />
                          <label htmlFor={id} style={{ fontSize: "0.85rem", marginLeft: "0.5rem", cursor: "pointer" }}>
                            {Boolean(jobDraft.extraFieldValues[f.name]) ? "Yes / Enabled" : "No / Disabled"}
                          </label>
                        </div>
                      ) : f.type === "date" ? (
                        <input
                          id={id}
                          type="date"
                          required={Boolean(f.required)}
                          value={String(jobDraft.extraFieldValues[f.name] ?? "")}
                          onChange={(e) => dispatchJobDraft({ type: "SET_EXTRA_FIELD", fieldName: f.name, value: e.target.value })}
                          className="lattice-input"
                          style={{ width: "100%", boxSizing: "border-box" }}
                        >
                        </input>
                      ) : f.type === "number" ? (
                        <input
                          id={id}
                          type="number"
                          step="any"
                          required={Boolean(f.required)}
                          placeholder={`Enter ${f.label || f.name}…`}
                          value={jobDraft.extraFieldValues[f.name] !== undefined ? String(jobDraft.extraFieldValues[f.name]) : ""}
                          onChange={(e) => dispatchJobDraft({ type: "SET_EXTRA_FIELD", fieldName: f.name, value: e.target.value })}
                          className="lattice-input"
                          style={{ width: "100%", boxSizing: "border-box" }}
                        />
                      ) : f.type === "json" ? (
                        <textarea
                          id={id}
                          rows={3}
                          required={Boolean(f.required)}
                          placeholder="{}"
                          value={
                            typeof jobDraft.extraFieldValues[f.name] === "object"
                              ? JSON.stringify(jobDraft.extraFieldValues[f.name], null, 2)
                              : String(jobDraft.extraFieldValues[f.name] ?? "")
                          }
                          onChange={(e) => dispatchJobDraft({ type: "SET_EXTRA_FIELD", fieldName: f.name, value: e.target.value })}
                          className="lattice-input lattice-textarea"
                          style={{ width: "100%", boxSizing: "border-box" }}
                        />
                      ) : f.type === "file" ? (
                        <div>
                          <input
                            id={id}
                            type="file"
                            required={Boolean(f.required)}
                            onChange={(e) => {
                              const file = e.target.files?.[0] || null;
                              dispatchJobDraft({ type: "SET_EXTRA_FIELD", fieldName: f.name, value: file });
                            }}
                            className="lattice-input"
                            style={{ width: "100%", boxSizing: "border-box", padding: "0.35rem 0.5rem" }}
                          />
                          {Boolean(jobDraft.extraFieldValues[f.name]) && (
                            <span style={{ fontSize: "0.75rem", color: "var(--lattice-muted)", display: "block", marginTop: "0.25rem" }}>
                              Selected: {jobDraft.extraFieldValues[f.name] instanceof File ? (jobDraft.extraFieldValues[f.name] as File).name : String(jobDraft.extraFieldValues[f.name])}
                            </span>
                          )}
                        </div>
                      ) : (
                        <input
                          id={id}
                          type={f.type === "email" ? "email" : f.type === "url" ? "url" : "text"}
                          required={Boolean(f.required)}
                          placeholder={`Enter ${f.label || f.name}…`}
                          value={String(jobDraft.extraFieldValues[f.name] ?? "")}
                          onChange={(e) => dispatchJobDraft({ type: "SET_EXTRA_FIELD", fieldName: f.name, value: e.target.value })}
                          className="lattice-input"
                          style={{ width: "100%", boxSizing: "border-box" }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="lattice-modal-footer" style={{ display: "flex", justifyContent: "space-between" }}>
                <button
                  type="button"
                  className="lattice-btn-secondary"
                  onClick={handleCloseCreateJobModal}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="lattice-btn-primary"
                  disabled={jobDraft.pending}
                >
                  {jobDraft.pending ? "Creating…" : "Create Job"}
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
                onClick={handleCloseCreateCustModal}
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

                {customerPhoneField ? (
                  <div>
                    <label style={{ fontSize: "0.85rem", fontWeight: 600 }}>
                      {isPhoneRequired ? "Phone" : "Phone (Optional)"}
                    </label>
                    <input
                      type="tel"
                      required={isPhoneRequired}
                      placeholder="e.g. 555-0199"
                      value={newCustPhone}
                      onChange={(e) => setNewCustPhone(e.target.value)}
                      style={{ width: "100%", boxSizing: "border-box", padding: "0.5rem", borderRadius: "4px" }}
                    />
                  </div>
                ) : null}
              </div>

              <div className="lattice-modal-footer" style={{ display: "flex", justifyContent: "space-between" }}>
                <button
                  type="button"
                  className="lattice-btn-secondary"
                  onClick={handleCloseCreateCustModal}
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
