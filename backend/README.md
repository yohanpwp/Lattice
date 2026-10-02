# backend (M0)

Go server built on PocketBase (pinned: v0.40.4) with our custom `/v1/*` routes.

## What is here (M0)

- `cmd/server/main.go`: PocketBase app + `OnServe` hook that registers `/v1` routes
- `internal/platform/tenant`: loads and validates the per-tenant config
- `internal/api`: `GET /v1/health`, `GET /v1/config`
- `config/tenant.example.json`: example tenant config
- `Dockerfile`

Registry, outbox, features and the payments plugin come in later milestones (M2, M4).

## Run locally

```bash
cd backend
go mod tidy                      # generates go.sum
cp config/tenant.example.json tenant.json
go run ./cmd/server serve        # http://127.0.0.1:8090

curl http://127.0.0.1:8090/v1/health
curl http://127.0.0.1:8090/v1/config
```

Create the first superuser (internal admin UI only):

```bash
go run ./cmd/server superuser create you@example.com 'a-strong-password'
```

## Test

```bash
go test ./...
```

## Docker

```bash
docker build -t yourproduct-backend .
docker run --rm -p 8090:8090 \
  -v "$PWD/pb_data:/pb_data" \
  -v "$PWD/config:/config:ro" \
  -e TENANT_CONFIG=/config/tenant.example.json \
  yourproduct-backend
```

## Rules

- `/v1/config` is public: only non-secret fields belong in `tenant.Config`.
- PocketBase's own `/api/*` endpoints are untouched; clients reach them through our SDK.
- Pin the PocketBase version and read its release notes before upgrading.
- License: keep PocketBase's MIT notice in anything you distribute (see root `NOTICE`).
