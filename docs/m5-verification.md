# Milestone M5 Verification & Audit Report

**Date:** 2026-10-15  
**Reference Document:** `Scaffold Spec: Product ต่อยอดจาก PocketBase.md`  
**Target Repository:** `Lattice`  
**Target Scope:** Milestone M5: Mobile Capacitor Shell & CI License Scan  
**Status:** **100% PASS & VERIFIED END-TO-END**

---

## 1. Executive Summary

Milestone M5 delivers the native mobile application shell and automated license compliance infrastructure:
1. **Mobile Application Shell (`apps/mobile`)**: Built on Capacitor 7 with pinned dependencies (`@capacitor/core: 7.0.1`, `@capacitor/android: 7.0.1`, `@capacitor/ios: 7.0.1`, `@capacitor/app: 7.0.0`, `@capacitor/cli: 7.0.1`, and `@aparajita/capacitor-secure-storage: 7.1.6`).
   - Hardware-backed secure storage: Keystore AES-256-GCM on Android, Keychain Services with `afterFirstUnlockThisDeviceOnly` on iOS.
   - Missing keys return `null` without throwing. OS/hardware lock errors propagate cleanly to `@lattice/sdk` as `AuthPersistenceError`.
   - Runnable native Android (`apps/mobile/android/`, compileSdk 34, minSdk 24, network security config enforcing HTTPS) and iOS (`apps/mobile/ios/`, bundle ID `com.lattice.app`, Privacy Manifest `PrivacyInfo.xcprivacy`).
2. **Client Bootstrap & Platform Precedence**:
   - `packages/ui-core/App.tsx`: `AppProps` accepts `platform?: PlatformAdapters`. `platform` takes strict precedence over `storage`. Workspace persistence (`saveWorkspace`, `loadSavedWorkspace`, `forgetWorkspace`) operates through `resolvedPlatform.storage`.
   - `apps/client/src/bootstrap.ts`: Runtime platform detection via `Capacitor.isNativePlatform()`. Configures mobile storage and SSE realtime reconnection on application resume with debounce/lock guarding against duplicate event streams or memory leaks.
   - `apps/client/src/main.tsx`: Awaits `bootstrapPlatform()` prior to mounting `<App platform={platform} />`.
   - Unidirectional dependencies strictly preserved: `apps/mobile` &rarr; `apps/client` &rarr; `@lattice/ui-core` &rarr; `@lattice/sdk` &rarr; `@lattice/types`.
3. **Resolved Dependency License Scanner (`tools/license-scan/`)**:
   - `spdx.mjs`: Boolean expression AST evaluator for `AND`, `OR`, and `WITH`. Enforces permissive allowlist (`MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `0BSD`, `CC0-1.0`, `Unlicense`, `Python-2.0`, `BSL-1.0`, `BlueOak-1.0.0`, `CC-BY-4.0`) and forbids copyleft/source-available (`GPL*`, `AGPL*`, `LGPL*`, `BUSL-1.1`, `SSPL-1.0`, `MPL-2.0`, etc.).
   - `scan.mjs`: Audits resolved graphs across NPM (`pnpm-lock.yaml`, resolved `node_modules`), Go modules (`go list -deps ./...`), Tauri Rust (`Cargo.lock` / `Cargo.toml`), Android Gradle (`dependencies.json`), and iOS CocoaPods (`Pods-App-acknowledgements.plist`).
   - Modes: `--check` (fails on policy violations, unknown licenses, missing license files, or stale reports) and `--generate` (updates `THIRD_PARTY_LICENSES.md` and packaged notices).
   - Test suite `scan.test.mjs` verifying all AST rules and edge cases. Added `"check:licenses"` script to root `package.json`.
4. **Legal Notices & Shipped Packaging**:
   - Pristine upstream PocketBase `LICENSE.md` restored (Copyright Gani Georgiev).
   - Product license `LICENSE-PRODUCT.md` created (Copyright 2026 Lattice Authors & Contributors).
   - Notice file `NOTICE` created with upstream and third-party attributions.
   - `THIRD_PARTY_LICENSES.md` generated with full table and notices for 335 resolved dependencies.
   - Legal notices packaged into Dockerfile (`/licenses/`), client web bundle (`dist/assets/notices.txt`), desktop installer resources, native mobile assets (`android/app/src/main/assets/notices.txt` and `ios/App/App/notices.txt`), and backend Docker packaging context (`backend/NOTICE`, `backend/LICENSE.md`, `backend/LICENSE-PRODUCT.md`, `backend/THIRD_PARTY_LICENSES.md`).
5. **GitHub Actions CI Workflow**:
   - Committed `.github/workflows/ci.yml` running on pull requests and pushes to `main`.
   - Five isolated jobs: `license-compliance`, `backend-verification`, `monorepo-verification`, `android-build` (debug APK with `chmod +x gradlew` and JDK 17), and `ios-build` (macOS unsigned simulator build with `xcodebuild ... CODE_SIGNING_ALLOWED=NO`).

---

## 2. Test Execution & Verification Matrix

### 2.1 License Scanner & Policy Compliance
- `node tools/license-scan/scan.test.mjs`: **PASS (24 tests, 0 failures)**
  - Dual-license `(MIT OR GPL-3.0)` passes and records choice `MIT`
  - Dual-license `(GPL-3.0 OR Apache-2.0)` passes and records choice `Apache-2.0`
  - Combined `(MIT AND GPL-3.0)` fails with violation `GPL-3.0`
  - Exception `(Apache-2.0 WITH LLVM-exception)` passes
  - Unapproved exception `(Apache-2.0 WITH UnknownException)` fails
  - Copyleft `MPL-2.0`, `BUSL-1.1`, and `SSPL-1.0` strictly prohibited
  - Permissive allowlist verified across all target licenses
  - Nested parenthesized expressions evaluated correctly
  - Markdown report generation verified
  - Stale report detection verified
  - Missing license file detection verified
  - Prohibited copyleft detection verified
  - Audits all resolved Rust crates from `Cargo.lock` and matches metadata
  - Resolved versions extracted for iOS CocoaPods from `Podfile.lock` (`AparajitaCapacitorSecureStorage: 7.1.6`, `CapacitorApp: 7.0.0`, `Capacitor: 7.0.1`, `CapacitorCordova: 7.0.1`)
  - Audits Android dependencies covering full resolved runtime graph (31 packages dynamically checked against `variables.gradle`)
  - Verifies zero `MPL-2.0` copyleft crates across all scanned Rust dependencies
  - Asserts that Rust notice texts do not contain announcement stubs and meet length requirements ($\ge 200$ chars)
  - Verifies that all Rust crates contain authentic license texts matching the chosen license
  - Asserts that `auditDependencies` rejects any Rust dependency with `MPL-2.0` license
  - Asserts that `scanRustDependencies` rejects crates with mismatched license text
  - Extracts both literal and variable runtime dependencies from Gradle build files (P1 resolved)
  - Parses Gradle dependency tree output into resolved coordinates and versions (P1 resolved)
  - Verifies Gradle runtime graph transitive closure coverage without hardcoded count thresholds (P1 resolved)
  - Propagates missing-dependency errors when live Gradle resolution contains unlisted dependencies outside execution try/catch (P1 resolved)
- `node tools/license-scan/scan.mjs --check`: **PASS** (766 resolved dependencies audited across NPM, Go, Rust, Android, and iOS, 0 policy violations, report up-to-date)
- `pnpm run check:licenses`: **PASS**

### 2.2 Contract & Codegen Verification
- `node tools/codegen/gen.mjs --check`: **PASS** (Generated TypeScript and Go contract artifacts are current)
- `node tools/codegen/check-openapi.mjs`: **PASS** (OpenAPI paths and schema references valid)
- `node tools/codegen/check-browser-bundle.mjs`: **PASS** (Browser bundle pure, zero Node runtime imports)

### 2.3 Monorepo TypeScript & Unit Tests
- `pnpm -r typecheck`: **PASS (8 workspace packages clean, 0 errors)**
  - `@lattice/types`: clean
  - `@lattice/sdk`: clean
  - `@lattice/ui-core`: clean
  - `@lattice/ui-web`: clean
  - `@lattice/client`: clean
  - `@lattice/mobile`: clean
  - `examples`: clean
- `pnpm -r test`: **PASS (88 unit tests total, 0 failures)**
  - `@lattice/types`: 27 tests passed
  - `@lattice/sdk`: 25 tests passed (including automatic realtime offline backoff retries and storage error propagation)
  - `@lattice/ui-core`: 22 tests passed (including platform precedence and workspace persistence)
  - `@lattice/client`: 8 tests passed (including runtime platform detection, EventSource validation, and SSE resume idempotency)
  - `@lattice/mobile`: 6 tests passed (including hardware error propagation, missing keys, and SDK integration)

### 2.4 Client & Mobile Build Verification
- `pnpm build`: **PASS** (Vite builds client bundle and generates `dist/assets/notices.txt`)
- `pnpm --filter @lattice/mobile build`: **PASS**
  - Triggers client Vite build
  - Runs `cap sync` copying web assets to Android and iOS shells
  - Updates native plugins (`@aparajita/capacitor-secure-storage@7.1.6` and `@capacitor/app@7.0.0`)
  - Sync finishes cleanly

### 2.5 Backend Go Verification
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
  - `github.com/Lattice/backend/internal/plugins/payments`: **PASS**
  - `github.com/Lattice/backend/internal/plugins/payments/ledger`: **PASS**

### 2.6 Shipped Artifact Notices Inspection
All required distribution channels verified to bundle legal notices and third-party inventory:
1. `backend/Dockerfile`: Copies `NOTICE`, `LICENSE.md`, `LICENSE-PRODUCT.md`, `THIRD_PARTY_LICENSES.md` to `/licenses/`
2. `apps/client/dist/assets/notices.txt`: Present (617 KB, combines `NOTICE` + `THIRD_PARTY_LICENSES.md`)
3. `apps/desktop/src-tauri/tauri.conf.json`: Bundles `NOTICE`, `THIRD_PARTY_LICENSES.md`, `LICENSE.md`, `LICENSE-PRODUCT.md` into installer resources
4. `apps/mobile/android/app/src/main/assets/notices.txt`: Present and verified
5. `apps/mobile/ios/App/App/notices.txt`: Present and verified
