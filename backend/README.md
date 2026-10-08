# Lattice backend (M0-M2)

This Go service uses the pinned PocketBase v0.40.4 runtime. The current core
provides tenant config, authenticated feature flags, plugin registration,
contract validation, and a persistent transactional outbox. It does not include
the M3 client app or the M4 payments plugin and payment routes.

## Core routes

| Route | Access | Purpose |
|---|---|---|
| `GET /v1/health` | Public | Liveness response |
| `GET /v1/config` | Public | Validated non-secret tenant settings |
| `GET /v1/features` | PocketBase user token required | Validated feature flags and non-secret options |

PocketBase's `/api/*` routes remain PocketBase's responsibility. The outbox
collection has null API rules and is superuser-only.

## Configuration

The runnable examples are [tenant.example.json](tenant.example.json) and
[features.example.json](internal/platform/features/features.example.json). Both
examples enable no plugins. Create local runtime files in `backend/`:

```sh
cp tenant.example.json tenant.json
cp internal/platform/features/features.example.json features.json
go run ./cmd/server serve --http=127.0.0.1:8090 --dir=./pb_data
```

`TENANT_CONFIG` and `FEATURES_CONFIG` select the runtime files; their local
defaults are `tenant.json` and `features.json`. The feature file is the source
of truth for the `features` list served by `/v1/config`.

Secrets are private runtime values and never belong in either JSON file, feature
options, event data, or public responses. If `SECRETS_DIR` is set, the service
reads canonical uppercase identifiers from regular files directly under that
directory and does not fall back to environment variables. Otherwise, a lookup
for `PAYMENT_API_KEY` reads `LATTICE_SECRET_PAYMENT_API_KEY`. Missing secrets
return `secrets.ErrNotFound`; providers are lazy and load values only when an
enabled plugin asks for them. Cloud secret stores are deferred.

## Run and verify

```sh
curl http://127.0.0.1:8090/v1/health
curl http://127.0.0.1:8090/v1/config
curl -H 'Authorization: <PocketBase user token>' http://127.0.0.1:8090/v1/features
go test ./...
go vet ./...
```

PocketBase CLI commands such as `superuser create` and `migrate` do not require
tenant configuration because runtime files are loaded only while serving.
The registered migration command applies the Go-registered core migrations:

```sh
go run ./cmd/server migrate up --dir=./pb_data
go run ./cmd/server superuser create you@example.com 'a-strong-password' --dir=./pb_data
```

## Plugins and the outbox

Plugins implement `registry.Plugin` and provide a JSON manifest validated by
`registry.ParseManifest` against the shared PluginManifest schema. The registry
starts only enabled plugins, in dependency order. `registry.Host` carries the
event bus, non-secret feature options, and the injected private secret store.

The PocketBase migration creates the outbox represented by
[`contracts/collections/outbox.json`](../contracts/collections/outbox.json).
Use `pbstore.Store.EnqueueTx(txApp, event)` inside
`app.RunInTransaction` to commit the event atomically with business data.
Delivery is at-least-once. Handlers must be idempotent and use the event ID as
the idempotency key. Batches are ordered by occurrence time and event ID;
failed events retry without blocking newer events, so strict aggregate ordering
is not guaranteed. Retries use exponential backoff from 5 seconds to 15 minutes
and stop after 8 attempts.

## Docker

```sh
docker build -t lattice-backend .
docker run --rm -p 8090:8090 \
  -v "$PWD/pb_data:/pb_data" \
  -v "$PWD/tenant.json:/config/tenant.json:ro" \
  -v "$PWD/features.json:/config/features.json:ro" \
  lattice-backend
```

The image defaults to `/config/tenant.json` and `/config/features.json`,
matching the paths shown above. Set `SECRETS_DIR` to a read-only mounted
directory to select the file provider.

## Milestones

M0-M2 are the supported core. M3 (client UI), M4 (payments), and M5 (mobile and
license scanning) remain future work. The active OpenAPI file lists only
implemented M0-M2 routes.
