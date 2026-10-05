# contracts

Source of truth for everything clients and plugins depend on.

- `openapi.yaml`: custom `/v1/*` routes only. PocketBase's `/api/*` is not redefined here.
- `schemas/*.json`: JSON Schema (draft-07). `schemas/events/` holds event envelopes.
- `packages/types`: generated TypeScript types, schema constants, and browser-safe standalone validators.
- `packages/sdk`: one ProductClient and injected storage/realtime adapters for every app.
- `backend/internal/platform/tenant/schema_bundle.go`: generated schema copy compiled into the backend; the Docker image does not need the repository root.
- `schemas/events/`: versioned event/webhook payloads.

## Rules

1. Never put secrets in any schema or example.
2. Breaking change = new version (`/v2`, new `interface_version`, new event `version`). Never edit a published meaning in place.
3. Every schema has a `title`; it becomes the generated TypeScript type name.
4. Backend and clients must pass the shared fixtures in `fixtures/contracts/`.

## Generate and check

```bash
pnpm gen
pnpm gen:check
pnpm check:openapi
pnpm check:browser
```

Edit schemas first, then run `pnpm gen` and commit the generated TypeScript and Go artifacts with the schema change. Run `pnpm gen:check` to catch drift. Breaking contract changes require a new API, plugin interface, or event version; `schema_version` remains an opaque tenant supplied identifier.
