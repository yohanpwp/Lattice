# @lattice/client

The user-facing client application (Vite + React + TypeScript). One codebase for **web** and, wrapped by Tauri, **desktop** (`apps/desktop`). It communicates with the tenant backend through `@lattice/sdk`.

## What it does (M3)

1. Connects to a tenant backend: fetches and validates `GET /v1/config`, refusing to run if this build is older than `min_client_version`.
2. Restores a saved session (and checks it with the server), otherwise presents a sign-in form.
3. Renders the user dashboard: loads the saved layout from the `dashboards` collection if present, otherwise provides a default layout. Supported widgets: `kpi` (count), `table`, `list`. `chart` and `form` show placeholders.

## Where the backend address comes from

| Platform / Deployment | Method |
|---|---|
| Web (single tenant) | Set `VITE_BACKEND_URL` at build time (see `.env.example`) |
| Desktop / mobile (multi-tenant) | Leave `VITE_BACKEND_URL` unset; the app asks for workspace address and remembers it |

Addresses must be `https://`; plain `http://` is allowed only for `localhost` / `127.0.0.1` (local development).

## Run

```bash
# from repo root
pnpm install
cp apps/client/.env.example apps/client/.env
pnpm --filter @lattice/client dev      # http://localhost:5173
```

## Build

```bash
pnpm --filter @lattice/client build    # typechecks and builds to dist/
```
