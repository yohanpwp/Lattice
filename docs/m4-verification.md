# Milestone M4 Verification & Audit Report

**Date:** 2026-10-09  
**Reference Document:** `Scaffold Spec: Product ต่อยอดจาก PocketBase.md`  
**Target Repository:** `Lattice`  
**Target Scope:** Milestone M4: Payments Plugin (Ledger + Provider + Transactional Outbox + Webhook Verification + SDK)  
**Status:** **100% PASS & VERIFIED END-TO-END**

---

## 1. Executive Summary

Milestone M4 specifies the end-to-end implementation of the Payments subsystem:
- Ledger schema (`payment_ledger` collection with indexes on `provider_charge_id` and `idempotency_key`)
- Repository and service layer utilizing the PocketBase service layer exclusively (no direct SQLite queries)
- Transactional Outbox integration: all payment state transitions atomically enqueue events (`payment.created`, `payment.succeeded`, `payment.failed`, `payment.refunded`) within `app.RunInTransaction`
- `PaymentProvider` interface supporting `context.Context`, client-supplied idempotency key, and partial refunds
- `MockProvider` featuring HMAC-SHA256 signature calculation and verification
- Tamper-proof webhook handling: verifies raw request body signature, strictly validates amount and currency against the ledger record, and enforces valid state transitions
- Idempotency deduplication, ownership isolation, and conflict detection (409 on reused key with differing payload or cross-user access)
- Cumulative refund balance accounting and idempotent refund replays
- Startup configuration preservation across platform lifecycle hooks
- Full contract generation: JSON Schemas, OpenAPI 3.0 specs, TypeScript types, and Ajv standalone validators
- SDK `PaymentsClient` on `ProductClient.payments` supporting `checkout` and `getPayment`
- Live end-to-end smoke probe against a compiled PocketBase binary

---

## 2. Review Defect Resolutions

| Issue | Severity | Resolution Details |
|---|---|---|
| **Plugin Startup Ordering & Secret Retention** | P1 | Updated `Plugin.Start` and `InitService` in `plugin.go` to retain startup configuration and apply configured secret and default provider regardless of whether `Plugin.Start` runs before or after `InitService`. Also updated `main.go` to initialize the payments service before platform activation when payments are enabled. |
| **Checkout Replay Ownership Isolation** | P1 | Updated `CreateCheckout` in `service.go` to assert matching ownership (`existing.UserID == in.UserID`) and matching resolved provider (`existing.Provider == provider.Name()`) on idempotency replays; returns `ErrIdempotencyConflict` (409) if a user attempts to replay another user's key. |
| **Cumulative Refund Accounting** | P2 | Track cumulative refund history in `metadata["refunds"]` and `metadata["refunded_amount"]`. Subsequent refunds validate against remaining balance (`rec.Amount - totalRefunded`). When total refunds reach `rec.Amount`, the status accurately transitions to `"refunded"`. |
| **Refund Idempotency Replay** | P2 | Replays of previous refunds with matching idempotency key return the existing record directly without re-invoking the provider or causing duplicate outbox enqueue failures. Key reuse with mismatched amounts triggers `ErrIdempotencyConflict`. |
| **Webhook Status Transition Validation** | P2 | Enforce valid state transitions (`pending -> succeeded/failed`, `succeeded -> partially_refunded/refunded`) inside `RunInTransaction`. Delayed `failed` webhooks arriving after `succeeded` are rejected with `ErrInvalidStatusTransition` (400), preventing corruption and contradictory events. |

---

## 3. Test Execution & Verification Matrix

### 3.1 Go Backend Tests (`backend/`)
- `go vet ./...`: **PASS (0 warnings / errors)**
- `go test -race -count=1 ./...`: **PASS (12 packages, 0 data races)**
  - `github.com/Lattice/backend/internal/api`: **PASS**
  - `github.com/Lattice/backend/internal/platform`: **PASS**
  - `github.com/Lattice/backend/internal/platform/features`: **PASS**
  - `github.com/Lattice/backend/internal/platform/outbox`: **PASS**
  - `github.com/Lattice/backend/internal/platform/outbox/pbstore`: **PASS**
  - `github.com/Lattice/backend/internal/platform/registry`: **PASS**
  - `github.com/Lattice/backend/internal/platform/secrets`: **PASS**
  - `github.com/Lattice/backend/internal/platform/tenant`: **PASS**
  - `github.com/Lattice/backend/internal/plugins/payments`: **PASS** (includes `TestPaymentsServiceLifecycle`, `TestCheckoutReplayOwnershipAndProviderCheck`, `TestRefundAccountingAndReplay`, `TestWebhookStatusTransitions`, `TestPaymentsPluginStartupOrderingAndSecretPreservation`)
  - `github.com/Lattice/backend/internal/plugins/payments/ledger`: **PASS**
- `go build -o server.exe ./cmd/server`: **PASS (Clean compilation)**

### 3.2 Contract & Codegen Verification
- `pnpm gen:check`: **PASS** (Generated TypeScript types and Go bundle match JSON schemas exactly)
- `pnpm check:openapi`: **PASS** (OpenAPI paths strictly document `/v1/payments/checkout`, `/v1/payments/{id}`, and `/v1/webhooks/payments/{provider}`)
- `pnpm check:browser`: **PASS** (Browser standalone validator bundle validates all shared fixtures without Node runtime dependencies)

### 3.3 TypeScript Monorepo Verification
- `pnpm -r typecheck`: **PASS** (7 workspace projects clean with zero TypeScript errors)
- `pnpm -r test`: **PASS (69 tests total)**
  - `@lattice/types`: 27 tests passed
  - `@lattice/sdk`: 21 tests passed
  - `@lattice/ui-core`: 21 tests passed
- `pnpm build`: **PASS** (Vite production bundle compiled cleanly)

### 3.4 Live Smoke Probe (`backend/smoke_test.ps1`)
- Step 1: Config endpoint verified (`GET /v1/config` -> 200 OK)
- Step 2: PocketBase test user 1 created (`POST /api/collections/users/records`)
- Step 3: Test user 1 authenticated and JWT session established
- Step 4: Checkout charge created (`POST /v1/payments/checkout` -> `pending` status, `provider_charge_id` generated)
- Step 5: Idempotency replay returns identical record for User 1; mismatched amount triggers 409 Conflict; cross-user replay by User 2 triggers 409 Conflict
- Step 6: Mock Webhook HMAC-SHA256 signature verified over raw body; ledger state transitioned to `succeeded`; verified via `GET /v1/payments/:id`
- Step 7: Delayed `failed` webhook arrives after `succeeded` -> rejected with 400 Bad Request (`invalid_transition`); database record remains `succeeded`
