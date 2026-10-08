# @lattice/desktop

Desktop wrapper using Tauri v2 for the `@lattice/client` web application.

## Overview

- Wraps the static build output from `apps/client` (`frontendDist: "../../client/dist"`).
- Uses native OS keychain via desktop platform adapter in `@lattice/sdk`.
- Communicates directly with the PocketBase backend over HTTP and SSE.

## Commands

```bash
# Run in development mode (starts @lattice/client dev server automatically)
pnpm --filter @lattice/desktop dev

# Build production desktop binary
pnpm --filter @lattice/desktop build
```
