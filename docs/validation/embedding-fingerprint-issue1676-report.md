# Embedding compatibility fingerprint implementation — issue #1676

Commits on the dispatched fingerprint worker branch:

- `ddef0b91`: identity contract, D1 provenance migration 0020, PostgreSQL metadata, production query/write gates, Workflow snapshot fence, Python contract, migration guidance.
- `9ee3317e`: read-only release preflight, real D1 old/new-schema and old-writer transition, incompatible async-upsert proof.
- `3fac0dce`: shared controlled-restore gate, on-prem lifecycle admission/rebuild/preflight, immutable orphan proof, reproducible built-node experiment and receipt.
- `876fd439`: effective inherited restore target validation and production declared-dimension fence.

## Validation

All resources were isolated and synthetic. No production data, mutation, model
provider, real queue, or production credential was used for these experiments.
The later checks used exact Node 26.13.1; native Python checks used installed
Python 3.14.2 (supported by the test's 3.12+ contract).

- `npm run typecheck --workspace @videoq/api`: passed, including application and D1 tools configurations.
- `npm run db:d1:check --workspace @videoq/api`: passed.
- `npm run db:d1:manifest:check --workspace @videoq/api`: passed with `mapping_complete: true`, no mapping issues. This does not claim execution completion of a production migration.
- Focused API suite (`vitest run --maxWorkers=1` with fingerprint D1, worker-internal D1, signed embeddings, embedding settings/contracts/indexing, scene writer): 7 files, 73 tests passed at initial coherent integration.
- Real PostgreSQL 17 `transcript-index.postgres.integration.test.ts`: 16 tests passed across 768 and 1536 dimensions, including unknown/mismatched metadata, atomic replacement, strict global startup admission, private-server declaration requirements, and compatible retrieval.
- Real D1 `embedding-fingerprint.d1.integration.test.ts`: 2 tests passed after final search/dimension/orphan additions. Covers canonical golden identity, unknown legacy migration, matching and mismatching model/revision/preprocessing/provider, stage preservation, compatible publication/retrieval, incompatible async upsert refusal, release/explicit-resume preflight, old producer cutover refusal and rebuild, immutable unheaded historical runs, and false dimensions with a matching fingerprint.
- `worker-internal.d1.integration.test.ts`: 11 tests passed after configuring each profile explicitly in the mixed-dimension ingestion fixture.
- `chat-send.test.ts`: 72 passed after updating its query mock and fingerprint filter expectation.
- Native Python HTTPS persistence plus frozen query preparation: 2 files, 2 passed with the supported Python executable on PATH. The production signer communicates with real native workerd/D1 in the first test.
- `PYENV_VERSION=3.14.2 python -m pytest apps/worker/tests/test_embeddings.py -q`: 44 passed, including cross-language golden fingerprint and signed request/response contract.
- Focused management release/traffic/adapter scripts: 25 passed before the effective-target refinement; final release/transport suite 18 passed, including target model+DB changes in one PATCH and inherited paused metadata edits.
- `npm run build:node --workspace @videoq/api`: passed.
- Built-node lifecycle experiment: `PERSISTENCE_TEST_DATABASE_URL=<isolated-test-PG> node apps/api/test/helpers/embedding-lifecycle-probe.mjs` passed. It launches the actual built entrypoint, rejects unknown provenance before HTTP listen, performs actual paused rebuild using one synthetic local model call, passes independent resume preflight, serves compatible HTTP health, and rejects a same-model/same-dimension changed revision. See `embedding-fingerprint-onprem-2026-11-25.json`.

The broad sequential API run completed after 658 seconds: 336 files / 3,588
tests passed; 128 files / 1,579 tests skipped; 3 tests failed. It started before
the query-mock expectation correction and selected an unsupported system Python
for the two Python subprocess tests. All three failing cases subsequently passed
in the focused reruns described above. This is not presented as a fully green
broad-suite result. The coordinator's integrated checkout remains the authority
for final combined verification.

## Integration and operational contract

Worker A owns persisted R2 manifest/source-envelope fingerprint checks and typed
recovery diagnostics. Worker D owns CD selectors and explicit preflight ordering.
Worker C owns 0021 policy facts and integrated cloud rehearsal. The fingerprint
worker did not modify 0021 or recovery implementation files.

Cloud serving releases must pass the read-only target preflight after migration
and before activation. Every real controlled traffic-restoring settings PATCH
also resolves inherited effective target bindings and checks that target's D1
provenance. Paused metadata edits are permitted without declaring them ready.
These are point-in-time checks, not proof that old producers are drained: keep
the existing owned freeze/drain/handoff protections. Legacy fingerprints remain
NULL and are never backfilled from today's configuration.

On-prem entrypoint admission checks once before listening; `/ready` does not scan
all vectors. Operators must pause/drain general producers, use the explicit
paused rebuild command (or a separate isolated rebuilt environment), run resume
preflight, and only then enable traffic. Rollback needs a matched old storage
pair or a real rebuild. `provider-managed` cannot attest unannounced remote
weights changes; private endpoints require explicit declared immutable revision
and preprocessing identities for admission/rebuild.
