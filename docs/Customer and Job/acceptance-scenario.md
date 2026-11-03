# Customer & Job Tracking: Pilot Acceptance Scenario & Release Test

This document defines the release acceptance criteria and end-to-end verification scenario for the Customer & Job Tracking managed module in Lattice. It serves as the proposed pilot release test (pending confirmation) for single-tenant PocketBase deployments across web and mobile clients.

---

## 1. Roles & Environment

- **Operator**: Boots the single-tenant server, manages infrastructure, and provisions the initial workspace setup secret.
- **Workspace Owner (`owner@example.com`)**: Sets up the workspace, configures modules, invites team members, creates customers, and assigns work orders.
- **Member 1 (`tech1@example.com`)**: Field service technician operating primarily on a mobile phone.
- **Member 2 (`tech2@example.com`)**: Field service technician operating primarily on a mobile phone.
- **Pilot Scope (Proposed - Pending Confirmation)**: All participating team members are granted **read-only access to all customer records** (`customers: { read: true, scope: "all" }`) so they can find, identify, and view details of any customer linked to their assigned jobs. This read-all policy is proposed and pending confirmation with the pilot business.

---

## 2. Chronological Acceptance Steps

### Step 1: Fresh Instance Bootstrap & Setup Secret
- **Action**: Operator boots a fresh Lattice backend instance with clean database storage (`pb_data`).
- **Expected Result**:
  - The server generates an ephemeral 24-hour setup secret token (e.g. via `authz.GetOrCreateSetupToken`).
  - `GET /v1/config` reports `has_owner: false`.
  - Non-authenticated requests to administrative endpoints return `401 Unauthorized`.

### Step 2: Owner Workspace Creation & Module Enablement
- **Action**:
  1. The owner opens the Lattice web dashboard and submits `POST /v1/workspace/setup` with the setup secret, owner name, email, and password.
  2. The owner signs in and opens the Workspace Modules modal.
  3. The owner enables **Customer & Job Tracking** using the *Suggested Datasets* path (`POST /v1/workspace/modules/customer_job_tracking/setup` with `{"use_suggested": true}`).
- **Expected Result**:
  - The owner account is initialized with role `owner`.
  - Collections `customers` (fields: `name` [text, required], `phone` [text, optional]) and `jobs` (fields: `title` [text, required], `customer` [relation:customers, required], `status` [select: "Open", "In progress", "Done", required], `assignee` [relation:users, required]) are created atomically.
  - Row-level access rules are established to protect assigned-member scoping while allowing full owner/admin oversight.
  - Repeating the setup is idempotent and returns `200 OK` without creating duplicate collections.

### Step 3: Owner Creates Customer & Invites Two Members
- **Action**:
  1. Owner creates a customer named "Acme Industrial" with phone "555-0199".
  2. Owner navigates to Workspace Members and invites `tech1@example.com` and `tech2@example.com` with role `member` using the **Customer & Job Tracking** permission preset:
     - `customers`: `{"read": true, "scope": "all"}`
     - `jobs`: `{"read": true, "create": true, "update": true, "delete": false, "scope": "assigned"}`
  3. Member 1 and Member 2 receive invitations, open the invite accept links, and set their passwords (`POST /v1/workspace/invitations/accept`).
- **Expected Result**:
  - Customer record is persisted in `customers`.
  - Invitation tokens are validated, single-use, and expire after acceptance.
  - User records for Member 1 and Member 2 are created with the exact assigned permission matrix without silently granting unlisted permissions.

### Step 4: Owner Creates Assigned Jobs
- **Action**:
  1. Owner creates Job 1: `title: "Boiler Maintenance"`, `customer: "Acme Industrial"`, `status: "Open"`, `assignee: Member 1`.
  2. Owner creates Job 2: `title: "HVAC Inspection"`, `customer: "Acme Industrial"`, `status: "Open"`, `assignee: Member 2`.
- **Expected Result**:
  - Both records are saved in the `jobs` collection.
  - Relation pointers correctly reference the customer and respective assignee user IDs.

### Step 5: Member Mobile Workflow & Status Updates
- **Action**:
  1. Member 1 signs in on mobile or narrow viewport.
  2. Member 1 opens the Customer & Job Tracking view.
  3. Member 1 views their assigned job "Boiler Maintenance" and the associated customer details ("Acme Industrial", "555-0199").
  4. Member 1 updates Job 1 status to `"In progress"`, and later to `"Done"`.
  5. Member 2 signs in, finds "HVAC Inspection", and updates status to `"In progress"`.
- **Expected Result**:
  - Member 1 sees only "Boiler Maintenance" in their job list.
  - Status updates succeed immediately (`200 OK`) and update the local UI and remote database.
  - Member 1 is never required to enter raw record IDs or request owner intervention.

### Step 6: Two-Member Isolation & Security Verification
- **Action**:
  1. Member 1 inspects their job list: Job 2 must not be visible in UI.
  2. Member 1 performs a direct API request for Job 2: `GET /api/collections/jobs/records/<job2_id>`.
  3. Member 1 attempts a direct modification: `PATCH /api/collections/jobs/records/<job2_id>` with `{"status": "Done"}`.
  4. Member 1 creates a new job: verify assignee is automatically bound to Member 1 and cannot be assigned to Member 2.
  5. Member 2 performs direct API request for Job 1: `GET /api/collections/jobs/records/<job1_id>`.
- **Expected Result**:
  - Direct retrieval requests for another member's job return `404 Not Found` (PocketBase row-level security masking).
  - Direct mutation requests return `404 Not Found` / `403 Forbidden`.
  - Member 1 cannot modify or view Member 2's jobs via UI, client SDK, or direct curl/REST calls.
  - Relation expansion (`?expand=customer`) operates strictly on permitted records.

### Step 7: Real-Time Web Observation by Owner
- **Action**:
  - Owner observes the Customer & Job Tracking dashboard on the web while Member 1 and Member 2 submit status updates.
- **Expected Result**:
  - The owner's view automatically updates via PocketBase Realtime (SSE) subscriptions without requiring a manual page refresh.
  - Both jobs display their latest statuses ("Done" for Job 1, "In progress" for Job 2).

---

## 3. Validation & Error Handling Specification

1. **Required Fields**:
   - Customer creation without a name must return validation error `400 Bad Request` (`name: cannot be blank`).
   - Job creation without title or customer must return validation error `400 Bad Request`.
2. **Invalid Options**:
   - Submitting a job status not in `["Open", "In progress", "Done"]` must be rejected with `400 Bad Request`.
3. **Invalid Foreign Keys**:
   - Submitting a non-existent customer ID or user ID in relation fields must return a foreign key relation error.
4. **Phone Formatting**:
   - Free-form text is accepted for pilot customer phone numbers, but whitespace is trimmed.
5. **Actionable UI Messages**:
   - Forms display inline validation errors next to the relevant inputs.
   - Server error responses are translated into human-readable notifications.

---

## 4. Lost Connectivity & Offline Specification

1. **Online-Only Baseline for Pilot**:
   - The initial pilot operates in online mode. Persistent offline queued mutations are not required for release sign-off.
2. **Connection Drop Detection**:
   - If connectivity is lost during an API request, the client must surface a clear connection error banner rather than a blank screen or unhandled crash.
   - Pending action buttons show a disabled/loading state and revert gracefully if the request times out.
3. **Automatic Reconnection & Realtime Recovery**:
   - When connection is restored or the mobile app resumes from background:
     - Realtime SSE streams reconnect automatically with exponential backoff.
     - Active view data refreshes automatically upon successful reconnection.
4. **Idempotent Retries**:
   - Module setup, customer creation, and job status updates are safe to retry upon network timeout without corrupting data or duplicating module installations.

---

## 5. Lifecycle & Session Invalidation

1. **Module Disabling**:
   - Disabling Customer & Job Tracking (`PUT /v1/workspace/modules/customer_job_tracking` with `{"enabled": false}`) hides module screens and navigation across all web and mobile clients.
   - All existing customer and job datasets, schema definitions, and records remain completely intact and preserved in SQLite.
   - Re-enabling the module restores all views with data intact.
2. **Member Revocation & Account Disabling**:
   - If an owner deactivates a member (`disabled: true`), any existing auth token or active session is immediately rejected on subsequent requests (`401 / 403`).
