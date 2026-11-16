# D1 bindings in the prebuilt API deployment

The normal CD pipeline builds without deployment credentials and later uploads the immutable Worker with a config generated from reviewed main. That generator previously omitted `d1_databases` and `vectorize`, so selecting D1 in Wrangler could produce an upload configuration without its database/search bindings.

The upload-only allowlist now preserves those two fields from the production environment. It also follows Wrangler's non-inheritable binding semantics for vars, Hyperdrive, R2, Durable Objects, D1 and Vectorize: omitted production bindings do not silently fall back to development resources. Build hooks, arbitrary entrypoints and containers remain excluded. See [Cloudflare environments](https://developers.cloudflare.com/workers/wrangler/environments/).

No production binding, backend flag, pause flag or resource is changed by this fix. The current production config continues to select its existing Hyperdrive and has no D1/Vectorize binding. Actual D1 selection must still pass the cutover configuration check, remote resource verification, migration/recovery and application acceptance gates.

Verification: deployment config/order tests (33 passed), all deployment security Node tests (397 passed). Actual Wrangler dry-runs accepted the generated D1 configuration with separate 1536/768 index bindings and a PostgreSQL binding configuration. The dry-run fixture uses a minimal Worker, omits the PG config's DO declarations, and proves config/schema transport only; it is not a full API or live deployment test.


## Preserve deployed cutover state

Immediately before the credentialed API upload, ordinary CD reads the fixed production API settings and checks only the pause/backend/database/index selectors. It refuses to clear a pause, change an active D1 backend back to PostgreSQL, replace its database, or replace either Vectorize index. Missing/ambiguous settings, a failed management read or an oversized response stop the upload. The credential and returned settings are not logged. Deliberate resume or inverse recovery must use the controlled cutover procedure rather than bypass this check.

This is a preflight comparison, not an atomic cross-service deployment lock. For the cutover window, suspend ordinary deployment automation, wait for active deployment runs to finish, hold AWS maintenance exclusion and retain writer fences until final reconciliation. A concurrent privileged operator can still change Cloudflare configuration; main review and the operation window remain the trust boundary.

## Unchanged D1 schema during ordinary CD

An already active D1 backend can complete the canonical migration job as a read-only no-op when the fixed database binding matches and every reviewed SQL filename exactly matches the applied ledger. The job still owns the maintenance lock and verifies its source and backend again. It does not invoke Wrangler, modify schema or infer stopped writers. Missing, duplicate, unknown or unreadable ledger entries fail closed. Pending migrations retain the explicit stopped-writer and paused-API requirements. PostgreSQL selection and its credential wrapper are unchanged.

Validation: 468 Node security tests passed, including the original D1 write boundaries and new no-op, ledger-drift, target and ownership cases. No production migration was executed.
