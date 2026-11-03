# Customer & Job Tracking: pilot progress

Assessment of the seven steps in [plan.md](plan.md), based on the current
working tree, including uncommitted changes, and the checks listed below.
Implemented means code exists; it does not by itself mean the pilot acceptance
scenario has passed.

## 1. Acceptance scenario — partial

The proposed [acceptance scenario](acceptance-scenario.md) describes fresh
workspace setup, two invitations, assigned jobs, phone status updates,
isolation, validation, and connection recovery. The new HTTP integration test
executes workspace setup, invitations and acceptance, sign-in, job creation,
status updates, isolation, and revocation using a PocketBase test server with
production authorization hooks. It does not exercise the product UI or a phone.

**Remaining:** agree on the scenario as the pilot release test, including
validation and lost-connection behavior, and confirm with the pilot business
that all participating members may read all customers.

## 2. Module contract — implemented for the pilot

The managed module definition describes the version, supported platforms,
dataset and field roles, screens, actions, recommended permissions, and the
effect of disabling. Server mapping validation checks field types, relation
targets, status values, and unsupported required fields. Backend and SDK tests
cover valid and malformed definitions and unsupported major versions. The SDK
marks incompatible catalog entries and prevents enabling known incompatible
managed modules.

**Remaining:** platform names in the contract still require actual device and
client verification; contract validation alone does not establish platform support.

## 3. Server installation state — implemented; cross-client verification pending

The server stores module installation, enabled state, version, and mappings.
Owner/admin configuration and authenticated reads are implemented. Dashboard
navigation loads server module state and subscribes to module changes. The API
test covers disable and re-enable; disabling is defined to retain data and does
not revoke dataset permissions.

**Remaining:** verify state after refresh and synchronization in two separate
web sessions and the mobile client, including retained records after disable
and re-enable.

## 4. Owner setup flow — implemented; pilot verification pending

The setup UI supports suggested datasets and mapping existing datasets. The
server validates mappings, checks customer and job rule compatibility, protects
assigned job access, and reports incompatible rules. Tests cover repeated
suggested setup, incompatible mappings, custom rules, and transactional rollback
of job protection changes.

**Remaining:** exercise both paths as an owner without PocketBase admin, code,
or raw JSON. Verify previews and error messages are actionable; test a failed
setup followed by retry, including what was created and whether any orphaned
resources remain. Repeat successful setup and confirm no duplicates.

## 5. Team access and onboarding — partial

The product includes invitations, roles, a dataset permission matrix, and a
Customer & Job Tracking permission preset. The job form has an owner/admin
assignee picker; assigned-scope creation and access are enforced on the server.
The HTTP acceptance test now uses invitation and sign-in endpoints for two
members, checks assigned-scope isolation and revocation, and exercises
all-scope assignment behavior.

**Remaining:** demonstrate invitations and the specified permission matrix
through the UI without silently granting access. Verify relation expansion,
realtime delivery, and permission changes for existing sessions in the running
product. The API test covers self-assignment and selected direct requests; keep
browser and realtime checks separate from that evidence.

## 6. Phone workflow — partial

The shared UI includes customer and job lists, server-side search and
pagination, job creation and status updates, a customer picker, and owner/admin
assignee selection. UI tests cover rendering and selected mapping behavior;
they do not establish the full interactive phone journey.

**Remaining:** verify the acceptance scenario at a narrow viewport and on a
physical phone or representative device, including slow or lost connection,
empty, validation, and permission-denied states. Check that available actions
reflect permissions and that members need neither raw record IDs nor owner
assistance. Record mobile-browser and native-client results separately.

## 7. End-to-end and recovery tests — partial

Backend tests cover provisioning, mapping validation, rule reconciliation,
rollback for a protection update, and an HTTP acceptance scenario using a
PocketBase test server. The scenario also covers compatible and rejected
mappings, repeat setup, disable/re-enable and record retention. The UI suite
tests component rendering and selected behaviors. These checks do not replace a
browser journey against a running server.

**Remaining:** add repeatable browser coverage for the full owner/member
journey, isolation and revocation; verify failed setup after partial provisioning
and retry without orphaned resources; check disable/re-enable across clients;
and add an optional field through the product and see its updated form after
navigation and on another client. The current optional-field API test directly
changes test data; it does not verify those UI steps.

## Next target

Run the complete pilot scenario from a clean isolated instance using the actual
owner and member interfaces. Record failures and fix the blockers, then
automate the critical browser path and direct API isolation checks. The pilot
is ready when the seven steps' completion criteria in the plan have been
verified, including cross-client and device evidence.

## Deferred beyond this pilot

The current pilot has one known managed module, Customer & Job Tracking.
Fresh-client identification of additional managed modules when catalog lookups
fail is an extensibility concern to revisit before supporting more managed
modules; it is not a demonstrated blocker for this pilot.

## Verification for this assessment

- On 2026-11-03, `go test -count=1 ./internal/platform/modules ./internal/api`
  passed, including the HTTP acceptance test.
- `pnpm --filter @lattice/sdk test` passed 42 tests outside the sandbox.
- `pnpm --filter @lattice/ui-core test` passed 56 tests outside the sandbox;
  sandboxed Vitest runs could not start a worker (`spawn EPERM`).
- No browser end-to-end, second-client, native mobile, or physical-phone test
  was run for this assessment.
