# Admin Workspace: Acceptance Scenario & Release Test

This document defines the release acceptance criteria and end-to-end verification scenario for the Admin Workspace capabilities in Lattice. It serves as the executable release test for single-tenant PocketBase deployments across web clients, verifying that owners and admins can manage datasets, records, pages, navigation, and dashboards without superuser access, code, or raw JSON, while enforcing strict server-side authorization and data isolation.

---

## 1. Roles & Environment

- **Operator**: Boots the single-tenant server, manages infrastructure, and provisions the initial workspace setup secret.
- **Workspace Owner (`owner@example.com`)**: Sets up the workspace, manages team roles, configures modules, and oversees workspace policies.
- **Admin (`admin@example.com`)**: Business administrator invited by the owner. Creates datasets, manages schema fields, authors pages, configures the shared dashboard, and manages records.
- **Member 1 (`analyst@example.com`)**: Team member granted `read` and `create` access on business datasets. Can view published pages, interact with authorized dashboard widgets, and create records.
- **Member 2 (`guest@example.com`)**: Restricted team member with **zero permissions** on business datasets (`read: false`).
- **Policy Invariant**: Presentation settings (such as hiding a page or dashboard widget) must never substitute for data access control. PocketBase row-level security and collection rules remain authoritative for all record and file operations.

---

## 2. Chronological Acceptance Steps

### Step 1: Fresh Instance Bootstrap & Owner Workspace Setup
- **Action**:
  1. Operator starts a fresh Lattice instance with clean storage.
  2. Owner opens the web app, provides the setup secret, and completes workspace setup (`owner@example.com`, role: `owner`).
- **Expected Result**:
  - The workspace is initialized. Collections `app_pages`, `dashboards`, `schema_definitions`, `workspace_modules`, and `users` are verified.
  - Owner signs in and lands on the dashboard.

### Step 2: Owner Invites Admin and Two Differential Members
- **Action**:
  1. Owner opens **Manage Team** (`WorkspaceMembersModal`).
  2. Owner invites `admin@example.com` with role `admin`.
  3. Owner invites `analyst@example.com` with role `member` and grants read/create access to future business datasets.
  4. Owner invites `guest@example.com` with role `member` and explicitly denies access to business datasets.
  5. Admin, Member 1, and Member 2 accept their invitations and set passwords.
- **Expected Result**:
  - Invitations are processed; user records are created with distinct roles and permission maps.
  - Admin receives full dataset and page authoring rights without owner escalation privileges.

### Step 3: Admin Creates Multi-Field Business Dataset and Records
- **Action**:
  1. Admin signs in to the web app.
  2. Admin clicks `+ Create First Dataset` (or `+ Add Dataset` in navigation) and opens `CreateSchemaModal`.
  3. Admin defines dataset `projects`:
     - `name`: Text (required)
     - `budget`: Number (optional)
     - `status`: Select (options: `"Planning"`, `"Active"`, `"Completed"`)
     - `lead`: Relation targeting `users` collection
     - `attachment`: File
  4. Admin adds 2 records:
     - Project Alpha (`name: "Alpha"`, `budget: 15000`, `status: "Active"`, `lead: admin_id`, file attached).
     - Project Beta (`name: "Beta"`, `budget: 8000`, `status: "Planning"`, `lead: analyst_id`).
- **Expected Result**:
  - PocketBase collection `projects` is created with auto-date fields (`created`, `updated`) and scoped collection rules.
  - `schema_definitions` record is created and synchronized.
  - Records and file attachments are persisted and viewable in `SchemaView`.

### Step 4: Admin Authors, Previews, and Publishes Custom Pages
- **Action**:
  1. Admin opens the Page Management interface (`PageEditorModal`).
  2. Admin creates Page 1:
     - `page_id`: `projects-table`
     - `name`: `"Projects Table"`
     - `view_type`: `"table"`
     - `collection`: `"projects"`
     - `published`: `true`
     - `nav_order`: `1`
  3. Admin creates Page 2:
     - `page_id`: `projects-board`
     - `name`: `"Projects Kanban"`
     - `view_type`: `"kanban"`
     - `collection`: `"projects"`
     - `config`: `{ groupByField: "status", cardFields: ["budget", "lead"] }`
     - `published`: `true`
     - `nav_order`: `2`
- **Expected Result**:
  - Page definitions are validated against `PageDefinition` schema and persisted to `app_pages`.
  - Both pages appear in the workspace navigation bar for authorized users.
  - DynamicPageView renders TableView and KanbanView faithfully without error.

### Step 5: Admin Customizes and Publishes Shared Dashboard
- **Action**:
  1. Admin opens the Dashboard Editor (`DashboardEditorModal`).
  2. Admin configures the shared workspace layout:
     - Widget 1 (`kpi`): Count of `projects` (`metric: "count"`).
     - Widget 2 (`table`): Recent records from `projects` (`fields: ["name", "status", "budget"]`).
  3. Admin saves the layout to the shared `"main"` dashboard record.
- **Expected Result**:
  - Dashboard layout is validated against `DashboardLayout` contract.
  - Saved layout persists in the `dashboards` collection.
  - The Overview tab renders the customized KPI and recent records table.

### Step 6: Multi-Session Member Experience & Access Control Verification
- **Action**:
  1. **Member 1 (`analyst@example.com`)** signs in on a separate session:
     - Inspects navigation: "Projects Table", "Projects Kanban", and Dashboard are visible.
     - Opens "Projects Table" and "Projects Kanban": records "Alpha" and "Beta" are displayed.
     - Observes dashboard: KPI shows "2", and table lists both projects.
  2. **Member 2 (`guest@example.com`)** signs in on a separate session:
     - Inspects navigation: "Projects Table" and "Projects Kanban" are NOT visible.
     - Observes dashboard: Widget fails gracefully with permission denial notice; no data is leaked.
  3. **Direct API Verification**:
     - Member 2 queries `GET /api/collections/projects/records`: returns `404 Not Found` / `403 Forbidden`.
     - Member 2 queries `GET /api/collections/app_pages/records`: returns only published pages or 403 on denied data.
     - Member 2 attempts `POST /api/collections/app_pages/records`: returns `403 Forbidden` (only owners/admins may write).
     - Member 2 attempts `POST /api/collections/dashboards/records`: returns `403 Forbidden`.
- **Expected Result**:
  - PocketBase row-level security and collection rules prevent data leakage across all direct API paths.
  - UI hides unauthorized navigation tabs cleanly.

### Step 7: Safe Schema Evolution, Page Unpublishing & Non-Destructive Integrity
- **Action**:
  1. Admin opens `SchemaView` for `projects` and adds a safe optional field: `priority` (select: `"Low"`, `"Medium"`, `"High"`).
  2. Existing records "Alpha" and "Beta" remain intact with null `priority`.
  3. Admin updates Project Alpha with `priority: "High"`.
  4. Admin opens `PageEditorModal` for `projects-board` and toggles `published: false`.
  5. Member 1 refreshes their session:
     - "Projects Kanban" disappears from Member 1's navigation.
     - Member 1 can still access `projects` data via "Projects Table".
     - All underlying records and files in `projects` remain 100% intact.
- **Expected Result**:
  - Safe field addition does not drop existing columns or discard records.
  - Unpublishing a page only changes view visibility; it does not revoke dataset permissions or delete business data.

### Step 8: Confirmed Deletion & Disposable Instance Backup / Restore
- **Action**:
  1. Operator performs a database backup (`pb_data` snapshot / PocketBase backup zip).
  2. Admin deletes Page 1 (`projects-table`) via the Page Editor: underlying `projects` dataset remains intact.
  3. Admin attempts to delete `projects` dataset: UI prompts with a typed confirmation modal requiring typing `"projects"`.
  4. Operator restores the backup into a clean disposable instance and starts the server.
  5. Owner and Member 1 sign in to the restored instance.
- **Expected Result**:
  - Destructive schema deletion requires explicit typed confirmation to prevent accidental loss.
  - Restored instance boots with all schemas, pages, dashboards, users, and records restored to the backup point.

---

## 3. Validation & Error Handling Specification

1. **Page Creation Validation**:
   - `page_id` must match `^[a-z][a-z0-9_-]{1,40}$`.
   - `collection` must match an existing registered dataset in `schema_definitions`.
   - `view_type` must be one of `["table", "kanban", "master_detail", "dashboard"]`.
   - Submitting an invalid `groupByField` for kanban must return a clear UI warning.
2. **Dashboard Validation**:
   - Layout widgets must have valid grid bounds (`x >= 0`, `y >= 0`, `1 <= w <= 12`, `h >= 1`).
   - Widget collection must be a valid dataset identifier.
   - Unauthorized widget data fetching returns informative error cards rather than blank screens or crashed UI.
3. **Authorization Invariants**:
   - Only `owner` and `admin` roles may create, update, or delete records in `app_pages` and `dashboards`.
   - Members cannot mutate workspace-wide layouts or page definitions.
   - Deactivated users (`disabled: true`) are immediately rejected by all API endpoints and realtime subscriptions.

---

## 4. Verification Checkpoints

- [ ] Schema and contract validation passes (`pnpm gen:check`, `pnpm check:openapi`).
- [ ] TypeScript compilation across all workspace packages (`pnpm typecheck`).
- [ ] Automated Go backend tests (`go test ./backend/internal/...`).
- [ ] Automated UI and SDK tests (`pnpm test`).
- [ ] Complete end-to-end admin acceptance test (`admin_acceptance_test.go` or equivalent).
