# Audit Report & Issues: Verification Against Scaffold Spec

**Date:** 2026-10-05  
**Spec Document:** `Scaffold Spec: Product ต่อยอดจาก PocketBase.md`  
**Target Repository:** `Lattice`  
**Status:** In Progress (M0–M2 Mostly Complete, M3 Blocked by Structure Issues, M4–M5 Pending)

---

## 1. Executive Summary

This report documents the verification and test execution of the Lattice codebase against the architectural and functional requirements defined in `Scaffold Spec: Product ต่อยอดจาก PocketBase.md`.

All backend Go tests, core contract generators, and TypeScript SDK packages compile and pass their respective test suites. However, critical discrepancies were discovered in the UI application structure (`M3`), OpenAPI specification validation (`M1`), and placeholder/draft plugin declarations (`M4`).

### Milestone Status Summary

| Milestone | Scope | Status | Notes |
|---|---|---|---|
| **M0** | `backend/` runs on PocketBase + Dockerfile + `/v1/config` | **Complete (100%)** | All Go tests pass, Dockerfile is configured properly, `/v1/config` and `/v1/health` verified. |
| **M1** | `contracts/` + gen types + `sdk` with platform adapters | **Partial (80%)** | Types, standalone browser validators, and SDK adapters are fully tested; `check-openapi.mjs` fails due to unreleased payment endpoints and missing schemas. |
| **M2** | Platform: `registry` + `outbox` + `features` | **Mostly Complete (90%)** | Registry topological sorting, outbox transactional worker, and features flag validation pass unit tests; `internal/platform/secrets` is not yet implemented. |
| **M3** | `apps/client` (login, dashboard) wrapped with Tauri | **Blocked / Broken Structure** | Client SPA code was erroneously placed inside `packages/ui-core/` with stale package references (`@yourproduct/*`) and no `package.json`. `apps/client` and `apps/desktop` are empty. |
| **M4** | Payments plugin (ledger + initial provider) | **Not Started (0%)** | `internal/plugins/payments/` missing; SDK payments client is only a stub. |
| **M5** | Mobile (Capacitor) + CI License Scan | **Not Started (0%)** | `apps/mobile` is empty; `tools/license-scan/` and product license files are missing. |

---

## 2. Test Execution & Verification Log

### 2.1 Backend Tests (`go test ./...`) — PASS
All packages under `backend/` compiled and passed their automated test suites:
- `github.com/Lattice/backend/internal/api`: **OK** (0.37s)
- `github.com/Lattice/backend/internal/platform/features`: **OK** (1.18s)
- `github.com/Lattice/backend/internal/platform/outbox`: **OK** (1.12s)
- `github.com/Lattice/backend/internal/platform/registry`: **OK** (1.08s)
- `github.com/Lattice/backend/internal/platform/tenant`: **OK** (1.33s)

### 2.2 Codegen Freshness (`node tools/codegen/gen.mjs --check`) — PASS
- Contract schemas (`app-config.json`, `features.json`, `dashboard-layout.json`, `plugin-manifest.json`, `events/envelope.json`) correctly match generated TypeScript definitions in `packages/types/src/generated/` and the Go schema bundle in `backend/internal/platform/tenant/schema_bundle.go`.

### 2.3 Browser Bundle Compatibility (`node tools/codegen/check-browser-bundle.mjs`) — PASS
- Generated standalone validator code (`packages/types/src/generated/standalone.mjs`) compiles cleanly for browser targets without Node runtime dependencies (`fs`, `path`, etc.) and passes contract test fixtures.

### 2.4 TypeScript Unit Tests (`pnpm -r test`) — PASS
- `packages/types`: 24/24 tests passed (Vitest).
- `packages/sdk`: 12/12 tests passed (Vitest).

### 2.5 TypeScript Typecheck (`pnpm -r typecheck`) — PASS
- `packages/types`, `packages/sdk`, and `examples` pass `tsc --noEmit`.

### 2.6 OpenAPI Validation (`node tools/codegen/check-openapi.mjs`) — FAIL
- Execution failed with:
  ```
  Error: OpenAPI must describe only implemented /v1 routes; found: /v1/config, /v1/features, /v1/health, /v1/payments/checkout, /v1/payments/{id}, /v1/webhooks/payments/{provider}
  ```
- **Cause:** `contracts/openapi.yaml` declared future payment endpoints whose `$ref` target files (`contracts/schemas/payments/checkout-request.json` and `payment.json`) do not exist.

---

## 3. Detailed Issues Identified

### Issue 1: UI Code Misplaced in `packages/ui-core` & Empty `apps/` Folders [Severity: HIGH]
- **Location:** `packages/ui-core/`, `apps/client/`, `apps/desktop/`
- **Description:** 
  The codebase intended for the React SPA client (`App.tsx`, `LoginForm.tsx`, `Dashboard.tsx`, `WorkspaceForm.tsx`, `styles.css`) was placed in `packages/ui-core/` instead of `apps/client/`.
- **Symptoms:**
  1. `packages/ui-core` lacks a `package.json`, causing pnpm workspace to ignore it.
  2. `packages/ui-core/App.tsx` imports from `@yourproduct/sdk` and `@yourproduct/types` rather than `@lattice/sdk` and `@lattice/types`.
  3. `packages/ui-core/tauri.conf.json` belongs to `apps/desktop/src-tauri/tauri.conf.json`.
  4. Extracted path artifacts exist: `packages/ui-core/mnt/user-data/outputs/yourproduct/apps/desktop/README.md`.
  5. `apps/client` and `apps/desktop` are empty directories.
- **Spec Reference:** Section 1, Section 4 (UI Structure).

### Issue 2: OpenAPI Contract Inconsistency & Missing Payment Schemas [Severity: MEDIUM-HIGH]
- **Location:** `contracts/openapi.yaml`, `tools/codegen/check-openapi.mjs`
- **Description:**
  `contracts/openapi.yaml` lists endpoints for `/v1/payments/checkout`, `/v1/payments/{id}`, and `/v1/webhooks/payments/{provider}`. These reference schema files in `./schemas/payments/` that have not been authored.
- **Impact:** 
  Running `npm run check:openapi` halts with an error. The API documentation is ahead of the actual backend implementation.
- **Spec Reference:** Section 3 (Contracts), Section 7 (Milestone M1 & M4).

### Issue 3: Missing Secret Store Loader [Severity: MEDIUM]
- **Location:** `backend/internal/platform/secrets/`
- **Description:**
  The spec mandates `internal/platform/secrets/` to read secrets from a dedicated store. Currently, tenant config and features reject secrets, but no dedicated secret loader package exists.
- **Spec Reference:** Section 2.1 (`internal/platform/secrets/`).

### Issue 4: Missing Tenant Collections Definitions [Severity: LOW-MEDIUM]
- **Location:** `contracts/collections/`
- **Description:**
  Section 3 specifies `contracts/collections/` for defining per-tenant collections and features without secrets. This directory is currently missing.
- **Spec Reference:** Section 3 (`contracts/collections/`).

### Issue 5: Payments Plugin Unimplemented (Milestone M4) [Severity: PLANNED / PENDING]
- **Location:** `backend/internal/plugins/payments/`, `packages/sdk/src/payments.ts`
- **Description:**
  `backend/cmd/server/main.go` has lines 16 and 41–44 commented out for `payments` registration. `packages/sdk/src/payments.ts` is an empty stub.
- **Spec Reference:** Section 2.3, Section 7 (Milestone M4).

### Issue 6: Missing Compliance Documents & License Scan Tooling [Severity: LOW]
- **Location:** Repository Root, `tools/license-scan/`
- **Description:**
  While PocketBase's upstream `LICENSE.md` (MIT) is preserved, the repository lacks:
  - `LICENSE-PRODUCT.md`
  - `NOTICE`
  - `THIRD_PARTY_LICENSES`
  - Automated scanner script in `tools/license-scan/`
- **Spec Reference:** Section 6 (License & Compliance).

---

## 4. Architectural Rules Compliance Matrix

| Rule from Spec | Compliance | Evidence / Reference |
|---|---|---|
| Use PocketBase as Go framework without modifying core | **COMPLIANT** | `backend/go.mod` imports `github.com/pocketbase/pocketbase v0.40.4`. No core source edits. |
| All PocketBase hooks must call `e.Next()` | **COMPLIANT** | Verified in `cmd/server/main.go` and `internal/platform/platform.go`. |
| Plugins must not access SQLite directly (must use service layer) | **COMPLIANT** | `pbstore.go` exclusively uses `core.NewRecord`, `app.Save()`, and `app.FindRecordsByFilter()`. |
| Outbox must be transactional with main data | **COMPLIANT** | `pbstore.EnqueueTx(txApp, event)` supports atomic execution inside `app.RunInTransaction`. |
| Public config must not contain secrets | **COMPLIANT** | `internal/platform/tenant/config.go` & `features.go` strictly validate and block secret keys. |
| Parameter binding must be used for queries (no string concatenation) | **COMPLIANT** | `ProductClient.filter()` uses PocketBase parameter binding; `pbstore` uses `dbx.Params`. |
| Check `res.ok` before parsing JSON responses | **COMPLIANT** | `packages/sdk/src/config.ts` verifies `res.ok` before `res.json()`. |

---

## 5. Recommended Remediation Plan

1. **Restructure UI Application (`apps/client` & `apps/desktop`)**:
   - Move React client source files from `packages/ui-core/` into `apps/client/src/`.
   - Create `apps/client/package.json` with correct workspace dependencies (`@lattice/sdk`, `@lattice/types`, Vite, React).
   - Update imports in `App.tsx` from `@yourproduct/*` to `@lattice/*`.
   - Move `tauri.conf.json` to `apps/desktop/src-tauri/tauri.conf.json`.
   - Remove lingering extraction directory `packages/ui-core/mnt/`.
2. **Align OpenAPI Contracts**:
   - Either create the missing schemas in `contracts/schemas/payments/` or comment out unreleased `/v1/payments/*` routes from `contracts/openapi.yaml` so `check:openapi` passes cleanly in CI.
   - Update `tools/codegen/check-openapi.mjs` route list to include `/v1/features`.
3. **Implement Remaining Milestones**:
   - Implement `contracts/collections/` examples.
   - Begin Milestone M4: Scaffold `backend/internal/plugins/payments/` with `PaymentProvider` interface and ledger collection migrations.
   - Add license scanner in `tools/license-scan/` and create `LICENSE-PRODUCT.md`.
