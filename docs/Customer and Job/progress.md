# Customer & Job Tracking: pilot progress

Assessment of the seven steps in [plan.md](plan.md), based on the current
working tree, including uncommitted changes, and the checks listed below.
Implemented means code exists; it does not by itself mean the pilot acceptance
scenario has passed. Browser and full-workspace results below are reported from
previous runs; they were not rerun during the latest progress update.

## 1. Acceptance scenario — release test verified; business confirmation recorded

The [acceptance scenario](acceptance-scenario.md) describes fresh workspace
setup, two invitations, assigned jobs, phone status updates, isolation,
validation, and connection recovery. The scenario specifies that participating
members have read-only access to all customer records (`customers: { read: true, scope: "all" }`)
so they can identify customers linked to their assigned jobs without exposure to
financial or billing data.

On 2026-11-04, the pilot business formally approved this customer read-all
policy. The end-to-end acceptance scenario has been verified via both backend
integration tests (`acceptance_scenario_test.go`) and headless browser CDP automation
(`scripts/e2e-owner-member-journey.mjs` and `scripts/e2e-milestone3-sync-phone-recovery.mjs`).

## 2. Module contract — verified for the pilot

The managed module definition describes the version, supported platforms,
dataset and field roles, screens, actions, recommended permissions, and the
effect of disabling. Server mapping validation checks field types, relation
targets, status values, and unsupported required fields. Backend and SDK tests
cover valid and malformed definitions and unsupported major versions. The SDK
marks incompatible catalog entries and prevents enabling known incompatible
managed modules.

Platform support for `web` is verified across live headless browser
runs (`pnpm test:e2e`) and mobile viewport/touch emulation (`pnpm test:e2e:sync`).
Mobile shell TypeScript adapter contracts and lifecycle resume hooks are verified
in unit tests (`@lattice/mobile` and `@lattice/client`), while physical hardware
KeyStore/Keychain execution remains pending until staged on-device release testing.

## 3. Server installation state — verified across sessions

The server stores module installation, enabled state, version, and mappings.
Owner/admin configuration and authenticated reads are implemented. Dashboard
navigation loads server module state and subscribes to module changes.

In SDK unit tests (`client.test.ts`), `subscribeWorkspaceModules` verifies event
arrival on state changes. In backend integration tests (`acceptance_scenario_test.go`),
updating module state via `PUT /v1/workspace/modules/customer_job_tracking`
delivers events to a directly registered PocketBase broker subscriber while
keeping SQLite records intact.

Live multi-session synchronization and state recovery are verified end-to-end
in `scripts/e2e-milestone3-sync-phone-recovery.mjs`:
- Realtime HTTP SSE stream over `/api/realtime` with client ID lifecycle,
  event delivery upon job mutations, connection termination, and automatic
  reconnection with fresh client ID and resumed subscription delivery.
- Owner disabling the module in `WorkspaceModulesModal` immediately propagates
  via realtime SSE to separate active member sessions, hiding module navigation
  and views while preserving 100% of customer and job records in SQLite.
- Owner re-enabling the module propagates immediately to member sessions,
  restoring navigation with all records intact.

## 4. Owner setup flow — verified in browser automation

The setup UI supports suggested datasets and mapping existing datasets with
dedicated dropdowns, schema previews, and relation targets without PocketBase
admin, code, or raw JSON.

The setup dialog (`CustomerJobTrackingSetupModal`) reads the API's `created`
dataset list when suggested setup fails partially, presenting an actionable
interruption card showing preserved datasets in the workspace, the specific
error reason, blocked operations (if rule validation failed), confirmation that
existing datasets will be reused without duplicates, and a direct "Retry Setup"
action.

The server validates mappings, checks customer and job rule compatibility, protects
assigned job access, and reports incompatible rules with actionable error banners.
Tests cover repeated suggested setup without duplicate datasets, incompatible
mappings (relation target mismatches), custom rules, transactional rollback of job
protection changes without orphaned resources, and clean retries. Failures during
and after provisioning are verified:
- Partial dataset provisioning (`jobs` creation failure after `customers` exists)
  reports `created: ["customers"]`, leaves no orphaned module state, and retry
  succeeds without duplicating `customers`.
- Rule protection failure (customer dataset view rule locked to superusers) reports
  `400 Bad Request` with `incompatible_rules` and `blocked_operations`, preserves
  both datasets in SQLite with no orphaned installation state, and succeeds upon
  rule resolution and retry.
- Installation-state saving failure (database error writing `workspace_modules`)
  reports `500 Internal Server Error` with `save_failed`, preserves datasets without
  orphaned module records, and completes cleanly upon retry.

The complete setup flow is verified in repeatable browser automation (`scripts/e2e-owner-member-journey.mjs`)
operating forms directly against a live running backend without initial state injection.

## 5. Team access and onboarding — verified in browser automation

The product includes invitations, roles, a dataset permission matrix, a
Customer & Job Tracking permission preset, and an owner/admin assignee picker.
Backend hooks enforce assigned-scope job creation and overwrite rogue assignments
to the caller. UI components (`WorkspaceMembersModal`, `AcceptInviteForm`,
`CustomerJobTrackingView`) render the preset matrix, relation expansion (`👤`, `📞`),
and member auto-assignment.

Verified in repeatable browser automation (`scripts/e2e-owner-member-journey.mjs`)
against a running PocketBase server with headless Chrome CDP:
- Owner invites two members with the Customer & Job Tracking preset.
- Members accept invitations, authenticate, and access their workspaces in separate sessions.
- Assigned jobs display expanded customer relations (`👤 Acme Corp`, `📞 555-0100`).
- Two-member isolation: Member 1 views only their assigned job; Member 2's job is hidden in UI.
- Direct API requests by Member 1 for Member 2's job (`GET` and `PATCH`) return `404 Not Found`.
- Account deactivation: Owner disables Member 2's account; subsequent requests in that session
  are immediately rejected with `401 Unauthorized` ("Your account has been disabled.").
- Create-job draft clearing: Modal cancel and close handlers clear the draft title,
  error, and extra field values. The browser script checks title clearing; reducer
  tests check that a cancelled attachment is absent from the next payload. An
  interactive file upload and cancel/reopen journey has not been independently verified.

## 6. Phone workflow — mobile viewport reported; native device verification pending

The shared UI includes customer and job lists, server-side search and
pagination, job creation and status updates, a customer picker, and owner/admin
assignee selection.

Verified in `scripts/e2e-milestone3-sync-phone-recovery.mjs` across mobile browser
and native test runners:
- **Mobile Browser (375x667 viewport, touch emulation, Mobile Safari UA)**:
  - Responsive CSS layout stacking verified (`@media (max-width: 720px)` enforces `flex-direction: column` on headers and toolbars).
  - Inline form validation error surfacing verified (`Field "Title" is required` in `.lattice-alert-error`).
  - Permission-denied enforcement verified (member attempt to delete customer record rejected).
  - Network disconnection (`offline: true`) handled gracefully without application crash; restoration (`offline: false`) and retry reload reloaded records cleanly.
- **Native Mobile Shell (`@lattice/mobile` & `@lattice/client`)**:
  - SecureStorage storage adapter unit tests passed 6/6 tests using a mocked `SecureStorage` plugin, verifying adapter configuration, missing-key semantics (`StorageErrorType.missingKey`), and error translation to `AuthPersistenceError`.
  - App resume lifecycle (`appStateChange`) and SSE reconnect passed 8/8 unit tests in `@lattice/client`, verifying idempotent resume locks and background/foreground transitions.
  - **[Pending] Physical Hardware / Emulator Verification**: Storage execution against native Android Keystore (AES-256-GCM) or iOS Keychain hardware on a physical device or native emulator is kept pending.

## 7. End-to-end and recovery tests — browser runs reported; final verification pending

The following end-to-end and recovery coverage is reported from earlier runs:
1. `scripts/e2e-owner-member-journey.mjs` (`pnpm test:e2e`):
   - Fresh compilation of `backend/server.exe` and `apps/client/dist` from source prior to test execution.
   - Clean session credentials read directly from browser `localStorage` (`window.__client` removed from production).
   - Fresh instance bootstrap with 24-hour setup token.
   - Owner setup and module enablement.
   - Two-member invitation, registration, and role assignment.
   - Work order dispatch and member status updates.
   - Assigned-only row-level security isolation and direct API 404 enforcement.
   - Instant 401 session revocation on account disabling.
   - Incompatible mapping rejection and clean recovery.
2. `scripts/e2e-milestone3-sync-phone-recovery.mjs` (`pnpm test:e2e:sync`):
   - Live HTTP SSE realtime delivery, drop, and reconnect.
   - Multi-session disable/re-enable with 100% record retention.
   - Dynamic optional field addition (`notes`) through UI `AddFieldModal`, navigation, and second-client sync to updated form and TableView.
   - Full typed field support: select dropdowns, relation picker, boolean toggles, dates, numbers, JSON, and text fields.
   - Mobile viewport (375x667) with strict column-stacking CSS verification.
   - Form validation error surfacing and permission-denied enforcement without discarded timeouts.
   - Offline connection drop and automatic application SSE stream reconnection: live server update propagates to the member's browser DOM without manual refresh.
   - Native mobile shell unit test suite passed; physical device hardware Keystore/Keychain execution remains pending.

## Milestone Status Summary

1. **Milestone 1: Finish setup recovery** (Completed)
   - UI surfaces partially created datasets, failure explanation, and retry guidance.
   - Failures during mapping validation, rule protection, and installation-state saving tested with SQLite assertions and duplicate-free retries.
   - API tracks datasets actually created by each attempt and reports exact lists on failures without labeling pre-existing datasets as created.
2. **Milestone 2: Prove the owner and two-member journey** (Completed)
   - Started a fresh isolated instance with a known setup secret.
   - Drove the complete pilot scenario (setup, two-member invite, customer creation, job assignments, member status updates, assigned-only isolation, direct API 404 enforcement, and account deactivation) in repeatable browser automation (`pnpm test:e2e`) without initial-state injection or production debug globals.
3. **Milestone 3: Verify synchronization, phone use, and recovery** (Mobile browser verified; native hardware pending)
   - Earlier browser runs reported multi-session sync, disable/re-enable retention, realtime delivery over HTTP SSE with disconnect/reconnect, optional field addition, and narrow viewport checks (`pnpm test:e2e:sync`). File controls have component coverage; an actual upload remains to be tested.
   - Web application automatic online reconnection listener and live SSE DOM mutation updates verified.
   - Physical device hardware KeyStore/Keychain execution kept pending.
4. **Milestone 4: Close the pilot** (Pending final verification and sign-off)
   - [x] The acceptance document records pilot business confirmation on the customer read-all policy dated 2026-11-04; retain a reference to the actual decision for release review.
   - [ ] Confirm release acceptance and record any native-device limitation or complete native device/emulator verification if native mobile is included in the pilot.
   - [ ] Rerun final verification against the final changes, including the browser E2E suites, and record the results.

## Remaining before completion

- Verify the native mobile workflow and secure storage on a device or native
  emulator, or explicitly agree that native hardware verification is outside
  the pilot release scope.
- Exercise an actual file upload and cancel/reopen in an interactive browser or
  device test. The current attachment regression test uses reducer and payload
  assertions rather than a real file upload.
- Rerun the full backend, workspace tests, typecheck, build, and both browser
  suites against the final change set. Record the results and release sign-off.

## Deferred beyond this pilot

The current pilot has one known managed module, Customer & Job Tracking.
Fresh-client identification of additional managed modules when catalog lookups
fail is an extensibility concern to revisit before supporting more managed
modules; it is not a demonstrated blocker for this pilot.

## Verification for this assessment

- **Latest focused review**: `cd backend; go test -count=1 ./internal/platform/modules ./internal/api` passed; `pnpm --filter @lattice/ui-core typecheck` passed; `pnpm --filter @lattice/ui-core test` passed 68 tests and `pnpm --filter @lattice/sdk test` passed 44 tests outside the sandbox.
- **Earlier reported backend run**: `cd backend; go test -count=1 ./internal/...` passed across 14 packages, according to the existing project record.
- **Earlier reported workspace test run**: `pnpm -r test` passed 161 tests across workspace packages:
  - `@lattice/types`: 35 tests passed
  - `@lattice/sdk`: 44 tests passed (including HTTP SSE reconnection and mocked callbacks)
  - `@lattice/ui-core`: 68 tests passed (including setup recovery banner, typed controls, file uploads, and draft clearing on cancel/reopen)
  - `@lattice/client`: 8 tests passed (online event listener, app resume, and teardown lifecycle)
  - `@lattice/mobile`: 6 tests passed (secure storage adapter contract with mocked SecureStorage; physical hardware pending)
- **Earlier reported checks**: `pnpm -r typecheck`, `pnpm -r build`, the Go binary build, and `pnpm test:e2e` / `pnpm test:e2e:sync` were reported as passing; they were not rerun for this update.
- **Mobile assets**: Android and iOS both reference `index-C-Mvhnr5.js`, which contains the updated file-control code. This check does not establish behavior on a native device.
