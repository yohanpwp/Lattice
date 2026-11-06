# Audit: Admin management of data and web app content

**Date:** 2026-11-04  
**Status:** Initial source audit; implementation and release verification pending  
**Scope:** A single workspace backed by PocketBase, managed by an owner or admin through the Lattice web app.

## Goal

An owner or admin can define business datasets, manage their records and team access, and decide which data and views appear in the web app without using the PocketBase superuser UI, writing code, or editing JSON. Members see the published experience and can access only the data their permissions allow. PocketBase remains the source of persisted collections, records, authentication, rules, files, and realtime events; Lattice provides the controlled management experience and versioned contracts.

For this audit, “content” means business records, pages, navigation, and dashboard layouts inside the authenticated web app. Public websites, rich-text publishing, and a multi-tenant control plane are outside this initial scope unless explicitly added later.

## Current assessment

**The foundation exists, but the complete admin journey is not yet available.** Dataset creation and record views exist, as do page contracts and renderers. The main missing link is an admin interface for creating, configuring, publishing, and maintaining pages and dashboards, with workspace-wide state and server-enforced permissions.

| Capability | Assessment | Evidence and limit |
| --- | --- | --- |
| PocketBase-backed datasets | Partial | [Schema service](../../backend/internal/platform/schemas/schemas.go) creates collections and synchronizes metadata. [CreateSchemaModal](../../packages/ui-core/CreateSchemaModal.tsx) and [SchemaView](../../packages/ui-core/SchemaView.tsx) provide creation and editing flows. Existing fields cannot be deleted or have their type or relation target changed through the service; new fields must be optional. A safe migration experience is not established. |
| Business records and files | Partial | [SchemaView](../../packages/ui-core/SchemaView.tsx) and [SchemaRecordModal](../../packages/ui-core/SchemaRecordModal.tsx) support dynamic record workflows. The [pilot progress](../Customer%20and%20Job/progress.md) reports browser coverage for key workflows but still calls for a real upload and cancel/reopen test. Full CRUD and every supported field type need an admin journey test. |
| Team and access | Partial | [WorkspaceMembersModal](../../packages/ui-core/WorkspaceMembersModal.tsx) and [authorization](../../backend/internal/platform/authz/authz.go) provide invitations, roles, and dataset permissions. The customer/job pilot has reported direct-API isolation tests; equivalent checks are needed for general admin-created datasets, files, page data, and realtime. Hiding a view must never be treated as access control. |
| Custom pages | Incomplete | [PageDefinition](../../contracts/schemas/page-definition.json), PocketBase [app_pages](../../backend/internal/migrations/1794000000_create_app_pages.go), SDK [page methods](../../packages/sdk/src/client.ts), and [DynamicPageView](../../packages/ui-core/DynamicPageView.tsx) exist. No page create/edit/delete UI call site was found in `packages/ui-core`. Admins therefore cannot yet build these views entirely in the web app. |
| Dashboard | Incomplete | [dashboardLoader](../../packages/ui-core/dashboardLoader.ts) reads a saved layout or builds a fallback; [Dashboard](../../packages/ui-core/Dashboard.tsx) renders it. No dashboard editor or publish flow was found in the web UI. Verify audience and ownership semantics before choosing a shared layout design. |
| Shared navigation and visibility | Incomplete | [WorkspaceModulesModal](../../packages/ui-core/WorkspaceModulesModal.tsx) exposes toggles. [ProductClient](../../packages/sdk/src/client.ts) persists managed module state on the server, but also keeps disabled IDs in platform storage; dashboard, dataset, feature and page visibility therefore cannot be assumed to be workspace-wide. The modal's statement that disabling hides views for all members needs to match actual behavior. |
| Contracts and validation | Partial | Schemas and generated artifacts exist, and page SDK methods validate client-side. `PageConfig` permits additional properties, and dashboard pages cast `config.widgets` for rendering. Verify server-side validation of page writes, referenced datasets and fields, filters, and widget props; direct PocketBase requests must not bypass required invariants. |
| Realtime and recovery | Partial | The app subscribes to `app_pages` and managed module changes in [DashboardPage](../../packages/ui-core/DashboardPage.tsx). The pilot reports earlier multi-session and recovery checks. Propagation of admin-created pages, dashboard changes, schema changes, and publication state needs an end-to-end test against a running server. |

## Priority work

### P0 — Make admin changes authoritative and safe

1. Define a workspace-owned, server-persisted configuration for page publication, navigation order and visibility, and shared dashboard selection. Decide how personal preferences interact with workspace settings. Preserve managed module behavior and do not confuse feature flags with display preferences.
2. Enforce owner/admin writes and member reads on the server and in PocketBase rules. Validate page and widget definitions, allowed view types, referenced collections and fields, sort/filter inputs, and permitted props on every write path, including direct collection requests. Return actionable errors rather than silently dropping invalid configuration.
3. Define which datasets and fields can be shown to each role. Enforce record and file permissions at the backend, including direct requests, relation expansion, and realtime subscriptions. Presentation settings must not grant access.
4. Add explicit errors and recovery for failed loads or saves. Avoid treating a network or authorization failure as an empty successful configuration.

### P1 — Complete the web admin workflow

1. Add page management: create, edit, preview, publish/unpublish, and delete a page; select an existing dataset and supported view; configure relevant columns, filters, sorting, grouping, and actions without raw JSON. Validate dependencies and show consequences before destructive operations.
2. Add dashboard management: choose permitted data sources and supported widgets, configure layout and properties, preview as an intended role, and save/publish a shared layout. Clearly distinguish draft from published state if drafts are implemented.
3. Complete dataset lifecycle management: create, rename metadata, add supported fields, inspect dependencies and records, and provide safe delete confirmation. Keep destructive field changes blocked until a deliberate migration and recovery workflow exists. Explain unsupported operations in the UI.
4. Complete record management with usable forms, search, pagination, relations, and file handling. Respect actual server permissions and show validation, conflict, permission, and connection errors without losing an admin's unsaved work.
5. Make navigation and published changes visible consistently in another session after refresh and, where supported, realtime updates. Unpublishing hides a view but does not delete records or revoke dataset access.

### P2 — Operational hardening

- Establish backup and restore procedures before allowing destructive administration; verify restoration on a disposable instance.
- Add audit history for administrative changes and decide whether drafts, revision history, rollback, scheduled publishing, and bulk import/export are required. These are proposed capabilities, not claims about current support.
- Add the admin acceptance journey to CI alongside contract generation, backend tests, and existing browser journeys. Retain native-platform checks separately; this audit prioritizes web.
- Reconcile stale contract and SDK README statements with implemented routes and document the supported PocketBase version and upgrade process.

## Proposed acceptance scenario

Run against a fresh, isolated PocketBase-backed Lattice instance with an owner, an admin, and two members. Use the actual web UI and ordinary user credentials; use direct API requests only to verify enforcement.

1. Owner completes workspace setup and invites an admin and two members. Assign the members different dataset permissions.
2. Admin creates a dataset with text, number, select, relation, and file fields, then creates and updates representative records. A second session sees persisted records after refresh.
3. Admin creates a table page and a second supported view from the dataset, configures visible fields and actions, previews, and publishes them. Both members see the appropriate navigation after refresh; a member without dataset read access cannot obtain its records through UI, direct API, relation expansion, files, or realtime.
4. Admin configures and publishes a dashboard using permitted data. A second session sees the saved layout and data; invalid references and unauthorized writes are rejected with useful errors.
5. Admin changes a page, navigation order, and a safe optional dataset field. Verify persisted changes in another session and defined realtime or refresh behavior. Test failed save and retry without losing unrelated data.
6. Admin unpublishes a page; it disappears according to the defined publication semantics while its records remain intact. Verify that unpublishing alone does not change record authorization.
7. Exercise a real file upload, download, cancellation, and permission denial. Verify record edit/delete restrictions, disabled users, and direct requests by both members.
8. Back up the instance, perform an explicitly confirmed destructive operation, restore into a disposable instance, and verify records and configuration.

**Done when:** this journey passes repeatedly against the final change set; workspace configuration is shared rather than device-local; direct API and realtime access follow the permission policy; and the expected behavior for unsupported schema changes and recovery is documented.

## Decisions needed

- Should admins have the same content and dataset powers as owners, or should some destructive and publishing actions be owner-only?
- Is publication workspace-wide only, or do pages and dashboards need role-specific visibility and drafts in the first release?
- Which view types and widget types are required for the first usable release? Current contracts list table, kanban, master/detail, and dashboard pages, but a contract alone does not establish a complete authoring experience.
- Is importing existing PocketBase collections into Lattice management required, and what happens when an operator changes them outside Lattice?

## Evidence and verification limits

This document is a source-level audit, not a claim that every listed control was exercised. Existing pilot evidence and its remaining checks are recorded in [pilot progress](../Customer%20and%20Job/progress.md). On 2026-11-04, `pnpm gen:check` and `pnpm check:openapi` passed during the preceding repository scan; the full suites and proposed admin journey were not rerun for this document. The OpenAPI check passing establishes the checks performed by that tool, not complete authorization or end-to-end correctness.
