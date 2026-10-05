# backend (M0 + M2 + M4)

Go server built on PocketBase (pinned: v0.40.4) with our custom `/v1/*` routes.

## What is here

| Path | What it does | Verified here? |
|---|---|---|
| `cmd/server/main.go` | PocketBase app; loads tenant config + feature flags, starts the platform, registers `/v1` routes | syntax only |
| `internal/platform/tenant` | tenant config loader/validator | tests pass |
| `internal/platform/features` | feature flags loader (rejects secret-looking option keys) | tests pass |
| `internal/platform/registry` | plugin manifest + registry: dependency order, interface-version check, enable by flag | tests pass |
| `internal/platform/outbox` | events, dispatcher, retrying worker, in-memory store | tests pass (`-race`) |
| `internal/platform/outbox/pbstore` | PocketBase-backed outbox store | syntax only |
| `internal/platform/platform.go` | wires registry + outbox worker into the app | syntax only |
| `internal/migrations` | creates `outbox`, `payments`, `payment_events` (all superuser-only) | syntax only |
| `internal/api` | `GET /v1/health`, `GET /v1/config`, `GET /v1/features` (auth required) | syntax only |
| `internal/platform/deps.go` | `Deps` for plugins that need PocketBase (router, app, tenant, secrets via env) | syntax only |
| `internal/plugins/payments` | payments core: ledger rules, checkout, webhooks, HTTP handlers, options, sandbox provider (see its README) | tests pass (`-race`), mutation-checked |
| `internal/plugins/payments/pb` | PocketBase store, order resolver, plugin wiring, provider factories | syntax only |

"syntax only" means gofmt-clean and written against the PocketBase v0.40.4 source, but not compiled: the sandbox had no Go 1.27 and could not download PocketBase's dependencies. Run `go mod tidy && go vet ./... && go test ./...` before trusting it.

## Configuration

Two files, both provisioned per tenant by the control plane:

- `tenant.json` (`TENANT_CONFIG`): public client config. See `config/tenant.example.json`.
- `features.json` (`FEATURES_CONFIG`): feature flags and non-secret options. See `config/features.example.json`.

`features.json` is the single source of truth for enabled features: at startup it overwrites `features` in the tenant config that `/v1/config` serves. Never put secrets in either file; secrets belong in a secret store.

## Run locally

```bash
cd backend
go mod tidy                      # generates go.sum
cp config/tenant.example.json tenant.json
cp config/features.example.json features.json
go run ./cmd/server serve        # http://127.0.0.1:8090

curl http://127.0.0.1:8090/v1/health
curl http://127.0.0.1:8090/v1/config
curl http://127.0.0.1:8090/v1/features   # 401 until you send a user token
```

Create the first superuser (internal admin UI only):

```bash
go run ./cmd/server superuser create you@example.com 'a-strong-password'
```

## Test

```bash
go vet ./... && go test -race ./...
```

## Docker

```bash
docker build -t yourproduct-backend .
docker run --rm -p 8090:8090 \
  -v "$PWD/pb_data:/pb_data" \
  -v "$PWD/config:/config:ro" \
  -e TENANT_CONFIG=/config/tenant.example.json \
  -e FEATURES_CONFIG=/config/features.example.json \
  yourproduct-backend
```

## Writing a plugin

1. Implement `registry.Plugin` (`Manifest()` and `Start(ctx, host)`).
2. Register it:
   - plugin that only needs events and options: `registry.MustRegister(...)` from `init()` plus a blank import in `cmd/server/main.go`;
   - plugin that needs PocketBase (routes, collections): build it with `platform.Deps` and register it in `main.go` inside the `OnServe` hook before `platform.Start` (see `payments/pb`).
3. Enable it with a feature of the same name in `features.json`; `host.Options` carries its non-secret options.

A plugin that is compiled in but not enabled is never started.

## Events (outbox)

- Emit with `host.Events.Emit(ctx, "payment.succeeded", 1, data)`; subscribe with `host.Events.Subscribe(type, handler)`.
- Delivery is **at-least-once**. Handlers must be idempotent; use `Event.ID` as the key.
- Failed deliveries retry with exponential backoff (5s doubling, capped at 15m) up to 8 attempts, then the event is marked `failed`.
- Run one worker per instance (one SQLite database per tenant).
- To write an event atomically with your own data, call `pbstore.Store.EnqueueTx(txApp, event)` inside `app.RunInTransaction`. The plain `Emit` path writes the event in its own save.

## Known follow-ups

- Delivered outbox rows are never pruned yet; add a retention job before production.
- `registry.Host` exposes only events and options; plugins that need PocketBase get it through `platform.Deps` instead.
- Strict per-aggregate event ordering is not guaranteed.
- Payments: no real provider adapter yet, no staff tooling for `needs_review` payments, refunds not exposed over HTTP (see `internal/plugins/payments/README.md`).

## Rules

- `/v1/config` is public: only non-secret fields belong in `tenant.Config`.
- PocketBase's own `/api/*` endpoints are untouched; clients reach them through our SDK.
- Pin the PocketBase version and read its release notes before upgrading.
- License: keep PocketBase's MIT notice in anything you distribute (see root `NOTICE`).
