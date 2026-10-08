# M0-M2 closure verification

This note records the core closure work against
[`agy-2026-10-05-scaffold-spec-audit.md`](../agy-2026-10-05-scaffold-spec-audit.md)
and the product scaffold spec. The original audit report is preserved.

## Resolved in M0-M2

- OpenAPI now documents exactly the implemented `GET /v1/health`,
  `GET /v1/config`, and authenticated `GET /v1/features` operations. The
  checker rejects extra paths, methods, missing success responses, or a missing
  PocketBase token requirement, and checks schema/security references.
- The Features, PluginManifest, and EventEnvelope Go paths validate raw/public
  payloads through the generated shared JSON Schemas, then enforce their
  domain-specific secret/name rules. The registry parses JSON manifests and
  tests checked-in valid and invalid shared fixtures.
- The SDK exposes authenticated `getFeatures()` and validates its response.
  Session refresh persists the changed token before returning, clears expired
  or rejected sessions, retains sessions through network failures, and surfaces
  persistence failures. The constructor-only payment stub has been removed;
  payment SDK work remains M4.
- `contracts/collections/outbox.json` is accepted by PocketBase and its
  normalized schema is compared with the migrated outbox. Integration coverage
  checks API rules, transaction commit/rollback with a business record,
  duplicate IDs, deterministic oldest-first due order, retry/delivery/failure,
  and persistence after reopening an isolated test database.
- Worker cancellation stops later handlers/events and does not consume a retry
  attempt. Plugin activation failure cancels plugins that already started and
  closes an injected closable secret store. Normal termination also waits for
  the active worker handler to stop before the next termination hook, then
  closes the secret store.
- Runtime examples and Docker defaults point to matching tenant and feature
  files. The examples start with no plugins enabled. Secret providers use
  canonical `LATTICE_SECRET_<NAME>` environment keys or a selected mounted-file
  directory; selecting files never falls back to the environment.
- Backend and SDK documentation describe M0-M2 behavior and identify M3-M5 as
  deferred.

## Deferred milestones

M3 client UI, M4 payments APIs/plugin/ledger/provider, and M5 mobile and license
scanning remain outside this closure. The active OpenAPI spec contains no
payment routes or payment schemas.

## Verification commands

Run from the repository root unless noted:

```sh
pnpm gen:check
pnpm typecheck
pnpm test
pnpm check:browser
pnpm check:openapi
cd backend
go test ./...
go vet ./...
go test -race ./...
```

The `pbstore` tests use PocketBase test apps created under Go's temporary test
directory; they do not use or modify `pb_data`.

## Native smoke results

On 2026-10-05, from `backend`, `go build -o .tmp/lattice-m0-m2-smoke-20261005/server.exe ./cmd/server` passed.
The server ran with isolated configs and data under
`backend/.tmp/lattice-m0-m2-smoke-20261005`; its stdout and stderr were captured
in `serve.stdout.log` and `serve.stderr.log` in that directory. It returned
`200` from `/v1/health`, `200` from `/v1/config` with
`tenant_smoke`, and `401` from unauthenticated `/v1/features`. PocketBase created
the isolated `data.db`; the separate migration test confirms the outbox
collection is present and synchronized. With no tenant config environment
variables, `migrate up --dir=<temporary-cli-data>` and `superuser create`
completed successfully on separate temporary data. The smoke server process was
stopped after the requests completed.

## Final check results

On the completed source snapshot, `pnpm gen:check`, `pnpm typecheck`,
`pnpm test` (25 type tests and 16 SDK tests), `pnpm check:browser`,
`pnpm check:openapi`, `go test ./...`, `go vet ./...`, and `go test -race ./...`
passed. The backend race suite ran successfully on Windows; no C compiler
limitation applied.

## Environment limitations

The Docker CLI is installed in the development environment, but its Linux
engine is unavailable (`dockerDesktopLinuxEngine` named pipe is missing). A
Docker image build or container launch therefore has not been verified.
