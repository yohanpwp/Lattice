# PocketBase collections

`outbox.json` is the PocketBase-compatible base collection definition for the
platform event outbox created by `backend/internal/migrations`. It is included
for review and provisioning parity; normal startup applies the Go migration.

The collection has null API rules, so PocketBase exposes it only to
superusers. Application clients and plugins should use the outbox service, not
write records through the collection API. `event_id` is unique, due records are
read oldest-first with event ID as the deterministic tie-breaker, and status is
one of `pending`, `delivered`, or `failed`. Delivery is at-least-once; handlers
must be idempotent and use the event ID as their idempotency key. Retries do not
block newer events, so strict aggregate ordering is not promised.

The event `data` field may contain domain payloads only. Never put secret values
in outbox records, examples, or logs.
