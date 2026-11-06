# Admin workspace: delivery plan

**Goal:** Let an owner or admin manage PocketBase-backed business data and the content shown in the authenticated web app through Lattice, without superuser access, code, or raw JSON. Use the [audit](admin-data-content-audit.md) as the baseline and [progress](progress.md) to track evidence and remaining work.

**Scope:** One workspace and its web app. PocketBase remains responsible for collections, records, authentication, files, rules, and realtime; Lattice adds the management experience and versioned contracts. Public websites, native-specific features, and hosted multi-tenant provisioning are outside this plan.

## Working decisions

These are starting assumptions for implementation, not finalized product decisions:

- Owner and admin can manage content and datasets, subject to server-side authorization. Decide whether destructive operations need owner-only access before implementing them.
- Start with workspace-wide publication and visibility. Role-specific data access remains enforced independently. Decide whether role-specific page visibility, drafts, and revision history are needed for the first release.
- Start with a table page and one additional supported view, plus a small set of existing dashboard widgets. Agree on the second view and widgets before committing to the editor scope.
- Keep unsupported destructive schema changes blocked. Decide how externally changed or existing PocketBase collections are managed before promising import or full synchronization.

## Milestones

### 1. Define the management contract and acceptance test

- Agree on the role matrix, workspace versus personal settings, publication behavior, initial views and widgets, and handling of existing collections.
- Turn the [audit acceptance scenario](admin-data-content-audit.md#proposed-acceptance-scenario) into an executable release test with concrete users, datasets, expected results, and recovery behavior.
- Specify versioned page, dashboard, navigation, and publication contracts, including field references and validation errors. Identify migration and compatibility needs for existing records.

**Done when:** the decisions and acceptance criteria are recorded, and contracts describe how authorized clients and the server exchange and validate configuration.

### 2. Make workspace configuration authoritative

- Persist publication, navigation order and visibility, and shared dashboard selection in PocketBase-backed workspace state. Define the relationship with personal preferences and existing managed module state.
- Enforce owner/admin writes and appropriate reads on the server, including direct PocketBase collection writes. Validate referenced collections and fields, allowed configuration, filters, and widgets. Never use visibility as authorization.
- Migrate or handle existing local visibility settings deliberately; surface loading, authorization, and save failures instead of silently treating them as empty state.

**Done when:** changes persist across independent sessions; unauthorized and invalid direct writes fail; existing module behavior remains covered; and contract generation and server/client checks pass.

### 3. Complete data and access management

- Complete dataset creation, metadata editing, safe optional field addition, dependency inspection, and confirmed deletion. Explain blocked schema changes and do not silently discard existing data.
- Complete record create, read, update, delete, search, pagination, relations, and file handling for the supported field types, with useful error and recovery states.
- Verify role and dataset permissions for normal requests, file access, relation expansion, and realtime, including account deactivation.
- Document and test backup and restoration on a disposable instance before exposing destructive operations.

**Done when:** an admin completes the agreed dataset and record journey in the web UI, denied actions fail through direct requests, and backup restoration is demonstrated.

### 4. Build page and navigation management

- Provide create, edit, preview, publish/unpublish, and delete for the agreed page types. Select datasets, fields, actions, sorting, and supported filters without raw JSON.
- Provide workspace navigation ordering and visibility, show dependencies and deletion consequences, and preserve records when pages are unpublished or deleted.
- Display published configuration consistently in separate sessions; define and test realtime or refresh behavior and save/retry errors.

**Done when:** an admin publishes and changes two agreed page views, members see the correct experience, and unpublishing does not change data permissions or delete records.

### 5. Build dashboard management

- Provide a shared dashboard editor for the agreed widgets, data sources, layout, and properties; validate against the same contracts on server and client.
- Add preview for the intended access context and publish the layout; communicate invalid data sources or permission failures clearly.

**Done when:** a published dashboard persists across sessions, respects the viewer's data permissions, and invalid or unauthorized updates are rejected.

### 6. Verify and close the release

- Run the complete fresh-instance admin journey, including two members with different access, real file upload/download, failed saves and retry, publication, direct API denial, realtime/refresh behavior, and backup restoration.
- Add repeatable automated coverage to CI where practical; run backend, contract, workspace, build, and browser checks against the final change set. Record commands, dates, outcomes, and limitations in [progress.md](progress.md).
- Update contract and SDK documentation and record release acceptance, unresolved issues, and any explicitly deferred capabilities.

**Done when:** the acceptance journey and required checks pass on the final changes and the release owner accepts any documented limitations.

## Dependencies and sequencing

Milestone 1 sets the decisions and contracts for the rest. Milestone 2 establishes authoritative state and authorization before publishing controls. Milestone 3 provides safe data and permissions for pages and dashboards. Milestones 4 and 5 can proceed in parallel after their shared contracts and data-access rules are established. Milestone 6 closes the complete integrated journey. Existing working features should be reused and verified, rather than rebuilt solely to match this sequence.

## Tracking rules

Update [progress.md](progress.md) when work starts, scope changes, or evidence becomes available. Mark a milestone complete only after its done criteria pass; distinguish implementation from tests and previous reports from fresh runs. Record blockers, decisions, test commands, and remaining limitations with dates and links. Do not infer approval or completion from a checked-in plan.
