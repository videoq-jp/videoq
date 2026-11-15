# D1 bindings in the prebuilt API deployment

The normal CD pipeline builds without deployment credentials and later uploads the immutable Worker with a config generated from reviewed main. That generator previously omitted `d1_databases` and `vectorize`, so selecting D1 in Wrangler could produce an upload configuration without its database/search bindings.

The upload-only allowlist now preserves those two fields from the production environment. It also follows Wrangler's non-inheritable binding semantics for vars, Hyperdrive, R2, Durable Objects, D1 and Vectorize: omitted production bindings do not silently fall back to development resources. Build hooks, arbitrary entrypoints and containers remain excluded. See [Cloudflare environments](https://developers.cloudflare.com/workers/wrangler/environments/).

No production binding, backend flag, pause flag or resource is changed by this fix. The current production config continues to select its existing Hyperdrive and has no D1/Vectorize binding. Actual D1 selection must still pass the cutover configuration check, remote resource verification, migration/recovery and application acceptance gates.

Verification: deployment config/order tests (33 passed), all deployment security Node tests (392 passed). Actual Wrangler dry-runs accepted the generated D1 configuration with separate 1536/768 index bindings and a PostgreSQL binding configuration. The dry-run fixture uses a minimal Worker, omits the PG config's DO declarations, and proves config/schema transport only; it is not a full API or live deployment test.
