# apps/client

The user-facing app (Vite + React + TypeScript). One codebase for **web** and, wrapped by Tauri, **desktop** (`apps/desktop`). It talks to a tenant backend only through `@yourproduct/sdk`.

## What it does (M3)

1. Connects to a tenant backend: fetches and validates `GET /v1/config`, refuses to run if this build is older than `min_client_version`.
2. Restores a saved session (and checks it with the server), otherwise shows a sign-in form.
3. Shows the user's dashboard: a saved layout from the `dashboards` collection if one exists, otherwise a default (one count KPI per collection). Widgets supported: `kpi` (count), `table`, `list`. `chart` and `form` show a "not supported yet" placeholder.

## Where the backend address comes from

| Situation | How |
|---|---|
| Web, served for one tenant | set `VITE_BACKEND_URL` at build time (see `.env.example`) |
| Desktop / mobile (one app, many tenants) | leave `VITE_BACKEND_URL` unset; the app asks for a workspace address once and remembers it |

Addresses must be `https://`; plain `http://` is accepted only for `localhost` / `127.0.0.1` (development).

## Run

```bash
# from the repo root
pnpm install
cp apps/client/.env.example apps/client/.env     # points at http://127.0.0.1:8090
pnpm --filter @yourproduct/client dev            # http://localhost:5173
```

The PocketBase backend allows cross-origin requests by default, so no dev proxy is needed.

```bash
pnpm --filter @yourproduct/client test
pnpm --filter @yourproduct/client build          # type-checks, then builds to dist/
```

## Deploying the web build

- Serve `dist/` as static files. Single-page app: no server rendering.
- Set a Content-Security-Policy header. The app needs **no** `unsafe-eval`: contract validators are generated at build time, not compiled at runtime. Allow `connect-src` to your tenant hosts.
- `style-src` needs `'unsafe-inline'` (or `style-src-attr`) because widget placement uses inline CSS variables.

## Known limits

- The saved layout is read-only here. Editing/saving layouts belongs to the Builder (later milestone), and the `dashboards` collection (fields `name`, `layout` JSON, owner) does not exist in the backend yet; until then everyone sees the default layout.
- KPI metrics other than `count` (`sum:`, `avg:`, ...) need a server aggregate endpoint that does not exist yet. The widget says so instead of showing a wrong number.
- Realtime updates are not wired into widgets yet.
- The session token is kept in `localStorage` on web (and in the webview's storage on desktop). Keep the app free of XSS (React escapes output; no raw HTML is rendered).
