# @lattice/ui-core

Shared UI components, hooks, layout calculations, and headless dashboard logic for Lattice client applications.

## Overview

This package contains:
- **Components & Pages:** `App`, `DashboardPage`, `Dashboard`, `LoginForm`, `WorkspaceForm`, and widgets (`kpi`, `table`, `list`).
- **Headless Logic:** layout sorting (`layout.ts`), metrics extraction (`metrics.ts`), widget data loading (`useWidgetData.ts`), workspace normalization (`workspace.ts`), format helpers (`format.ts`).
- **Contracts Integration:** Directly consumes contracts from `@lattice/types` as the single source of truth.
- **Styling Tokens:** CSS custom properties defined in `styles.css`.

## Usage

```tsx
import { App } from "@lattice/ui-core";
import "@lattice/ui-core/styles.css";

export function Root() {
  return <App />;
}
```
