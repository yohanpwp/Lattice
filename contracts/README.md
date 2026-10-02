# contracts

Source of truth for everything clients and plugins depend on.

- `openapi.yaml`: custom `/v1/*` routes only. PocketBase's `/api/*` is not redefined here.
- `schemas/*.json`: JSON Schema (draft-07). `packages/types` generates TypeScript types and runtime validators from these.
- `schemas/events/`: versioned event/webhook payloads.

## Rules

1. Never put secrets in any schema or example.
2. Breaking change = new version (`/v2`, new `interface_version`, new event `version`). Never edit a published meaning in place.
3. Every schema has a `title`; it becomes the generated TypeScript type name.
4. Backend and clients must pass the same contract tests (see `packages/types` tests, which validate the backend's example config).

## Regenerate types

```bash
pnpm gen
```
