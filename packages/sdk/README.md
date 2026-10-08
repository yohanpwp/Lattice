# @lattice/sdk

`ProductClient` is the shared client entry point for web, desktop, and mobile. Applications import it and `@lattice/types` instead of maintaining separate backend contracts.

```ts
import { ProductClient, createWebStorage } from "@lattice/sdk";

const client = await ProductClient.connect({
  backendUrl: "https://acme.app.example.com",
  clientVersion: "1.2.3",
  platform: { storage: createWebStorage() },
});
```

Desktop and mobile apps pass a `HostStorageApi` implementation to `createDesktopStorage` or `createMobileStorage`. The host owns secure storage, native fetch, and any global `EventSource` polyfill; the SDK has no Tauri, Capacitor, or React Native dependency. Use `initializeRealtime` to await installation of that polyfill before the client is returned.

`connect` fetches and validates `GET /v1/config`; `fromConfig` validates cached or embedded config. Both await auth restoration. `getFeatures()` calls authenticated `GET /v1/features` and validates the response against the shared Features schema. Storage operations remain ordered, and login, logout, and session refresh wait for persistence and surface failures. Auth keys include the normalized backend URL and tenant ID. The configured realtime URL must equal the backend URL plus `/api/realtime`.

`ProductClient.filter` delegates placeholder binding to PocketBase. Put untrusted values in the params object instead of concatenating them into filter text. `collection` exposes PocketBase collection APIs. Dashboard layouts, plugin manifests, and event envelopes are shared schemas and types; payment APIs are deferred to M4.

Run `pnpm gen` after editing a source schema. The package pins PocketBase JS SDK 0.28.1; backend PocketBase is pinned separately at v0.40.4. Review the relevant release notes before either version changes.
