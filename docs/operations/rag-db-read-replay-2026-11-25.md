# Supplemental RAG database rows-read measurement — 2026-11-25

This addresses #1683's workload read-quantity gap alongside the [original authenticated actual-model RAG experiment](current-configuration-experiments-2026-11-25.md). It is a **new D1-only replay**, not recovery of the original requests' missing metadata. The original 310 calls remain 0 covered / 310 unavailable, with historical totals unknown/null. No original receipt or latency/quality result is rewritten.

## Measured result

The [raw replay receipt](evidence/2026-11-25-rag-read-replay/measured-replay.json) and [derived summary](evidence/2026-11-25-rag-read-replay/summary.json) record **310/310 metadata-covered SELECT calls**, **33,470 rows read**, and **zero rows written** in 30 requests. These provider counters include index reads, not merely returned rows. Setup/import/schema checks are excluded from these totals. No model, Vectorize, Worker, Queue, Workflow or R2 resource was created or called for this supplemental experiment.

| Selected videos | Concurrency | Requests | Queries/request | Rows read/request (each of five observations) | Rows written/request |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | 5 | 6 | 12 | 0 |
| 1 | 2 | 5 | 6 | 12 | 0 |
| 100 | 1 | 5 | 7 | 318 | 0 |
| 100 | 2 | 5 | 7 | 318 | 0 |
| 1000 | 1 | 5 | 18 | 3017 | 0 |
| 1000 | 2 | 5 | 18 | 3017 | 0 |

The original actual-model source is `176ce1d1576fdb40d299d9ed7d2591b35dffd52d`; the measured replay tool source is `741c8d78` (full SHA and script hash in the receipt). Native BetterAuth session validation and the actual D1 scene-search repository reconstruct the catalog offline. Every SQL SHA256 and multiplicity matches **each of the 30 original traces**, not just one representative cell. Two authentication SQL hashes occur twice per request; provenance/hydration supply the remaining calls. Bound SQL and parameters remain private. The public summary gives hash-level operation counts and rows read.

The metadata-preserving replay adapter uses D1's [raw REST response](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/raw/), which supplies column names, positional rows and metadata. It preserves positional results, including duplicate column names; `first`/`all` shaping is tested separately. This avoids the metadata omission of native binding [`raw()` and `first()`](https://developers.cloudflare.com/d1/worker-api/prepared-statements/). No production adapter or SQL was changed.

## Schema, dataset and isolation

The private snapshot is the same synthetic D1 export used by recovery: SHA256 `7a2eaaee04d5843efa117ed4101c866b5640abab9aacdddc36d5b0f7412fb501`. It has 1000 video metadata rows, two scenes and 174 indexes. All **202 snapshot-defined objects**, including every application definition, match exactly after import: table SQL retains columns/types/defaults/nullability/keys/foreign keys; index SQL retains expressions/predicates; trigger SQL retains full bodies. No application definition is normalized away. Exact equality is stronger than accepting superficially similar column lists. The private expected/actual catalog and diff were saved before assertions.

The only additional definition is the specifically named `_cf_KV` table. Cloudflare documents this as [reserved underlying storage](https://developers.cloudflare.com/d1/best-practices/import-export-data/). Its type/name/table identity is checked and its definition hash recorded; no wildcard provider-object exclusion is used. Tests reject missing/changed application definitions and unrecognized `_cf_*` objects.

The first database failed the original whole-catalog digest guard before workload execution. It was immediately deleted and verified absent; its [failed receipt](evidence/2026-11-25-rag-read-replay/failed-schema-guard.json) is retained. After coordinator authorization, one replacement database passed the explicit application comparison and completed the bounded replay. The only cloud resources created were these two uniquely named disposable D1 databases. Measurement is SELECT-only and checks every response has rows-written=0. The finally block deletes the owned database. A [separate read-only verifier](evidence/2026-11-25-rag-read-replay/independent-cleanup.json) subsequently received HTTP404/code7404 for both; no active resource remains.

## Fidelity limits and decision

The snapshot predates the resumed Workflow's final publication and genuine-model reindex. Physical scene/run IDs and provider-managed physical layout can differ from the original final RAG database. The reconstruction retains schema/index definitions, data cardinality, owner/scope, query text and complete query-call profiles, but **does not assert bit-identical historical parameters, physical pages, or historical row counters**. Vector matches are deterministic candidates from snapshot scenes; there is no new semantic quality or provider inference claim.

The new D1 is in APAC, accessed through raw REST from local Node. This is not a new Worker-binding latency comparison. The original cold/warm/concurrency latency and quality evidence remains authoritative for those metrics. Replay concurrency1/2 is retained, with one initial request followed by four repeated requests per cell. Read counts are fully observed for the instrumented 310-query workload; the original uninstrumented provenance-validation safety operation remains separately excluded, just as in the original traces. This does not claim total account cost, all setup reads, provider inference cost or production corpus density.

The workload's DB-read quantity is now explicitly measured with coverage and limits, alongside the prior real-model phase timings. It does not prove that the historical requests consumed exactly 33,470 rows. No SQL/index/schema/write-path change is proposed from these counts: the original answer-provider spans dominated, and this bounded metadata-video corpus does not justify speculative database tuning.

## Reproduction and checks

Use a private mode0700 directory containing the synthetic `snapshot.sql`, private auth state and original scoped `receipt.json`. Do not publish those inputs. The resource runner refuses a pre-existing exact owned name; do not repeat resource creation without a fresh coordinator-reviewed namespace and bound.

```sh
# Offline: reconstruct actual auth/search query profiles and compare all original hashes/counts.
ACCEPTANCE_PRIVATE_DIR=/private/fixture npx tsx apps/api/scripts/acceptance/prepare-read-replay.ts
# Creates one exact-name isolated D1, imports snapshot, compares schema, executes at most310 SELECTs, deletes in finally.
ACCEPTANCE_PRIVATE_DIR=/private/fixture node apps/api/scripts/acceptance/measure-read-replay.mjs
# Read-only independent checks of the two specifically authorized attempt IDs.
ACCEPTANCE_PRIVATE_DIR=/private/fixture node apps/api/scripts/acceptance/verify-read-replay-cleanup.mjs
node --test apps/api/scripts/acceptance/compare-read-schema.test.mjs
npm exec --workspace @videoq/api -- vitest run test/persistence/d1-read-replay.test.ts
npx tsc -p apps/api/tsconfig.acceptance.json
```

Local Node26.12.0: adapter test1 passed, schema guard test1 passed, acceptance TypeScript check passed, and focused ESLint for all new tooling/tests passed. The first attempt also encountered expired cached OAuth at the read-only list step before creating any resource; supported `wrangler whoami` refreshed authentication without printing credentials. Failed attempts are not pooled into successful workload counts.
