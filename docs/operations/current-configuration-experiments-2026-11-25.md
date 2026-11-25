# Current-configuration isolated acceptance (2026-11-25)

Issues: #1677, #1683, #1684. This is synthetic isolated evidence, not a production recovery guarantee, business SLO achievement, or permission to mutate production. The policy decision source and responsible account are recorded in [business decisions](business-decisions-2026-11-25.md).

## Frozen source and reproduction

The final recovery rehearsal is frozen at `99ba6fbe955f78b7e2022a58f9930c5e0790ddd1`; the final successful RAG matrix is frozen at `176ce1d1576fdb40d299d9ed7d2591b35dffd52d`, including the real-provider filter correction, supported edge notification redirect mode and actual-citation quality assertion. Both include A's authenticated recovery/fingerprint-safe manifests and B's strict embedding identity. Config hashes distinguish recovery, invalid configuration, pre-fix RAG and final RAG phases. Later commits add evidence/cleanup tools; they are not substituted as measured runtime SHAs. Each raw operation records source/config/entrypoint hashes; early exploratory operations in the same receipt precede this freeze and are not the final rehearsal.

The isolated account/resource identity, Worker versions, D1 export hash/bookmark, timestamps and results are in the scoped evidence directory. All resources use `videoq-acceptance-20261125-c33d`; the driver checks exact account/database/index/bucket/workflow/queue identity and refuses extra production bindings. Private cookie/password/secrets, SQL export and full provider logs stay outside Git. No account plan or production resource was changed.

```sh
# Disposable services only; copy wrangler.example.json and replace its explicit placeholders.
# Provision D1/R2/Vectorize(768,cosine), main+DLQ queues, real Workflow and native auth fixtures.
# Apply every current migration. Create user_id/string, video_id/number, vector_id/string metadata indexes.
# Bind AI; use production auth mode, an isolated admin session and unique native BetterAuth secret.
# The real HTTP sink is notification-sink.worker.ts with a matching secret and isolated D1 binding.
export ACCEPTANCE_PRIVATE_DIR=/absolute/private/fixture
node apps/api/scripts/acceptance/prepare-fixture.mjs
# This generates private native-auth credentials and seed.sql, without cloud access.
# Configure/deploy an isolated main+sink Worker, then seed through the guarded target.
node apps/api/scripts/acceptance/cloud-control.mjs configure-fixture
node apps/api/scripts/acceptance/cloud-control.mjs seed-fixture
node apps/api/scripts/acceptance/cloud-control.mjs sign-in
# Fail the fixture after embedding stage, inspect native admin, then stop/drain before snapshot.
node apps/api/scripts/acceptance/cloud-control.mjs pause
node apps/api/scripts/acceptance/cloud-control.mjs drain
node apps/api/scripts/acceptance/cloud-control.mjs seed-outbox
node apps/api/scripts/acceptance/cloud-control.mjs replay
node apps/api/scripts/acceptance/cloud-control.mjs snapshot
node apps/api/scripts/acceptance/cloud-control.mjs export
node apps/api/scripts/acceptance/cloud-control.mjs bookmark
node apps/api/scripts/acceptance/cloud-control.mjs disrupt
node apps/api/scripts/acceptance/cloud-control.mjs restore-db
node apps/api/scripts/acceptance/cloud-control.mjs restore-artifacts
node apps/api/scripts/acceptance/cloud-control.mjs reconcile
node apps/api/scripts/acceptance/cloud-control.mjs resume
# resume fails closed unless exact artifact/vector reconciliation and effective-target fingerprint preflight pass.
# ACCEPTANCE_JOB_ID/VIDEO select v2/video1 or v3/v4/video2 for the bounded native Workflow experiment.
node apps/api/scripts/acceptance/cloud-control.mjs inspect
node apps/api/scripts/acceptance/cloud-control.mjs restart
node apps/api/scripts/acceptance/cloud-control.mjs verify
node apps/api/scripts/acceptance/cloud-control.mjs reindex-real
node apps/api/scripts/acceptance/cloud-control.mjs real-provenance
# Wait for actual exact-value and ANN checks, not a fixed sleep/ACK. Then measure/check/replay/clean.
node apps/api/scripts/acceptance/cloud-control.mjs measure
node apps/api/scripts/acceptance/cloud-control.mjs auth-check
node apps/api/scripts/acceptance/cloud-control.mjs delete-check
node apps/api/scripts/acceptance/cloud-control.mjs cleanup
node apps/api/scripts/acceptance/verify-cleanup.mjs
node apps/api/scripts/acceptance/summarize.mjs /private/receipt.json /public/summary.json
```

The fixed unique namespace is a deliberate safety guard. For another disposable run, change the namespace/origin guards together with all example resource names; never point these controls at production. The deleted Vectorize name can retain a provider tombstone. Native fixture credentials are freshly generated and never printed.

Run cloud-control commands sequentially: the scoped receipt is a single writer. Native admin inspect/restart binds the actual deployment origin; stale inspection and unauthenticated calls are denied. Never use this disposable entrypoint as a production Worker. Its controls require a native authenticated admin and the exact isolated origin. Fixture creation/terminal injection uses the official Workflow API, not a public bypass endpoint.

Local boundary experiments:

```sh
mkdir -p /tmp/videoq-current-evidence
RUN_CURRENT_ACCEPTANCE=1 ACCEPTANCE_EVIDENCE_DIR=/tmp/videoq-current-evidence npm exec --workspace @videoq/api -- vitest run test/persistence/current-configuration.acceptance.test.ts
npm exec --workspace @videoq/api -- vitest run test/persistence/operational-policy.d1.integration.test.ts test/persistence/scene-index-sync.d1.integration.test.ts test/persistence/worker-transcription.d1.integration.test.ts
node_modules/.bin/tsc -p apps/api/tsconfig.acceptance.json
npm run lint --workspace @videoq/api
npm run typecheck --workspace @videoq/api
npm run db:d1:check --workspace @videoq/api
npm run db:d1:manifest:check --workspace @videoq/api
```

## Recovery fidelity and limits

The final cloud rehearsal stops queue delivery and new application traffic (`/ready` 503), verifies all Workflows terminal and active DB/outbox/index leases drained, preserves a full D1 SQL export and Time Travel bookmark, snapshots original R2 bytes and current physical 768-vector values, injects two known post-snapshot DB writes plus object/index loss, performs real D1 Time Travel restore, restores R2/vector data, and verifies object hashes/vector values plus intentional loss/corruption reversal. It resumes only after reconciliation and B's effective-config embedding provenance admission check. One attempted resume correctly failed closed during inconsistent observations; a later successful reconciliation admitted traffic. Pause propagation is checked rather than inferred from CLI exit.

Queue and Workflow platform state are retained in the same isolated managed resources while D1/R2/index data is restored. Pending queue duplicates, terminal resumable Workflow state/artifacts, DB intent and audit state are exercised together, but this is **not portable export/import of managed Queue messages or Workflow checkpoints**. Complete account-loss reconstruction is not established. Test R2 media objects are synthetic bytes, not a playable video/transcription integration. Unknown external email outcomes are deferred in the local boundary experiment; no live email or production external side effect was sent.

The Workflow subclass executes the actual SearchIndexWorkflow and real D1/R2/recovery controls, but injects deterministic vectors to force failure after staging. Its matching configured fingerprint does **not** prove real model generation. After every successful resumed publication, `reindex-real` calls actual `embedTexts` with `@cf/google/embeddinggemma-2` document preprocessing for every current scene and upserts those vectors. A separate R2 provenance manifest records Float32 output hashes. `real-provenance` requires exact current vector hashes, source metadata, matching active fingerprint and actual ANN visibility. The RAG endpoint fails closed before measurement if any scene fails this check. A pending/invisible write was observed and measurement was withheld until both current scenes passed. No synthetic Workflow vector is presented as provider/model quality proof.

Local real workerd D1/R2 boundary tests additionally cover missing/duplicate/stale/forged index entries, deletion, foreign owner, lease conflicts, restore losses and conservative unknown external outcomes; their external providers/queue/Workflow are explicitly simulated. The cloud receipt separately proves native auth denial, completed job duplicate fencing, current scene identity, native admin recovery and retained-index deletion denial. Production-sized recovery, arbitrary in-flight producer races, backup retention restoration and approved production RPO/RTO remain separate acceptance work; measured fixture timings cannot define those targets.

## RAG measurement meaning

The cloud endpoint uses native BetterAuth session authentication and the actual `streamRag` agent/MCP, shared query embedding, real Vectorize, strict D1 hydration and real configured answer provider. It excludes the public chat HTTP route's billing/rate-limit/course setup. The fixed English sampling question is hashed. There are 1/100/1000 selected-video scopes, sequential and concurrency-two requests, one first logical request plus four warm observations per cell. The database contains 1000 video metadata rows and two transcribed scenes; this measures scope/filter/bind scaling, not production corpus density or broad semantic recall. The first request after deployment and each cell's first request are labeled logical cold; Cloudflare isolate and model-cache cold state cannot be guaranteed.

Trace phases distinguish authentication, query embedding binding, Vectorize, D1 hydration, answer-provider binding, first answer and complete stream. Binding-response spans do not claim streamed model generation has finished. Provenance validation is an explicit additional safety span. Spans may overlap and their sums must not be treated as a serial critical path. Nearest-rank p50/p95/p99 are descriptive; with four warm samples p95/p99 equal the maximum and do not establish tail confidence or a business SLO.

D1 query calls and per-SQL hashed timings are collected without changing raw/first return semantics. Those native methods omit row metadata: recorded rows-read values are a **known subset**, with unavailable-metadata counts, never fabricated total read counts. Provider D1 Insights is collected separately over a broader dedicated-fixture time window and can include setup/recovery/maintenance. It is not attributed to individual RAG requests. Dominant measured phases/SQL are ranked before any optimization proposal; no SQL/index change is justified solely from synthetic local elapsed time.

Quality assertions require nonempty text, the sampling concept and only the fixture's expected citation. Authorization checks use real owner/foreign-owner search; deletion deliberately retains stale vectors and requires authoritative hydration to deny them. These are bounded fixture checks, not comprehensive answer correctness/security proof.

## Notification delivery and remaining operational acceptance

The runtime uses durable facts and delivery leases/backoff, not console output as notification evidence. A separately deployed HTTPS sink verifies secret auth and idempotency keys and stores unique sanitized deliveries in isolated D1. Same-zone Worker-to-Worker HTTP requires Cloudflare's `global_fetch_strictly_public` flag (enabled only for the isolated fixture); see [official fetch documentation](https://developers.cloudflare.com/workers/runtime-apis/fetch/). The edge runtime also rejects `redirect: "error"`; the runtime adapter now uses `manual` and rejects all non-2xx results, including redirects, without forwarding credentials. Initial failed delivery/backoff is retained as a failure, then real delivery/dedup is checked. Synthetic sink acceptance is not human acknowledgement, production destination configuration, or production notification achievement.

Authoritative source: [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) and [Vectorize metadata indexing](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/). Metadata indexes must exist before re-upsert; ACK/get-by-ID alone is insufficient to infer ANN visibility.

## Observed results and acceptance boundary

The [raw cloud receipt](evidence/2026-11-25-current/cloud-receipt.json) retains exploratory and failure runs with per-operation identities. Use the [final RAG summary](evidence/2026-11-25-current/rag-final-summary.json), [recovery summary](evidence/2026-11-25-current/recovery-summary.json) and [cleanup verification](evidence/2026-11-25-current/cleanup-verification.json) for the final phases. The evidence README maps files and limits.

Recovery restored eight original objects and two current 768-dimensional vectors. D1 Time Travel took **2082ms**; the known synthetic post-snapshot write window was **12227ms**. Resume was admitted after **81581ms**, including operator work and reconciliation. First observed all-scene real-model value/ANN readiness was **261348ms** after restore started, including resumed Workflow work, operator sequencing and provider propagation. These are fixture observations; comparison to approved production RPO/RTO is **unavailable** because neither production target has been approved. A full SQL export was 509590 bytes, SHA256 `7a2eaaee04d5843efa117ed4101c866b5640abab9aacdddc36d5b0f7412fb501`. One new outbox intent was intentionally lost and one corruption write reverted.

Final RAG: **30/30 HTTP success and 30/30 bounded fixture quality checks passed**, including sequential and concurrency-two 1000-video scopes. Warm observations per cell are 4; the table's p95/p99 equal the observed maximum.

| Selected videos | Concurrency | Warm p50 ms | Warm p95/p99 ms | Failures / requests | D1 query calls per request (median) |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | 7218 | 7994 | 0/5 | 6 |
| 1 | 2 | 6372 | 6750 | 0/5 | 6 |
| 100 | 1 | 5209 | 7787 | 0/5 | 7 |
| 100 | 2 | 6079 | 7147 | 0/5 | 7 |
| 1000 | 1 | 7353 | 14885 | 0/5 | 18 |
| 1000 | 2 | 8691 | 9096 | 0/5 | 18 |

Answer-provider binding spans dominate: 120calls/125399ms versus D1 hydration190calls/22756ms and authentication120DBcalls/14078ms. Spans overlap; this is an operation ranking, not additive critical-path attribution. The correction is provider filter partitioning, with **no new SQL, DB index, write path or service split**.1000 selected IDs now issue10 properly scoped Vectorize queries instead of failing the first oversized query, increasing necessary provider read operations; this is a correctness cost, not an asserted free performance improvement.

The initial512-token fixture failed configuration validation30/30 before model calls. After correcting to the current4096-token setting, the pre-fix matrix had20/30HTTP success and10/10failures at1000scope. Real provider diagnostics reported code40001/2048 normalized bytes; an independent REST probe reported code40029 for more than100list entries. The runtime now caps lists100 and uses a conservative normalized-size budget. The old100scope quality check incorrectly treated every retrieved registry entry as an actual citation; corrected checks inspect segment sourceIds, then passed the new complete matrix. Failed batches remain separate and are not pooled with final latency/quality results.

Native D1 raw/first provide **0metadata-covered calls /310query calls** in the final matrix: observed-subset rows-read is0, but total rows-read is **unknown/null**, never0. [Exact-window provider analytics](evidence/2026-11-25-current/d1-insights-exact.json) requests hourly buckets02/03UTC on2026-11-25, top20SQLgroups by duration, with a query/filter hash and observed collection time. It reports2040executions/84046rows-read in those selected groups, including setup/recovery/maintenance; it is adaptive aggregate coverage, not a total database count or a per-request allocation. SQL text and bound literals are withheld. This unavailable exact per-request read attribution is an explicit measurement limit.

The actual native admin path rejected unauthenticated calls401 and stale/completed recovery500, accepted recovery200, and the real Workflow completed with its ledger attempts stable at3. The preserved pending outbox intent completed once (attempt1); completed job duplicate delivery did not add another run. A separate real stale-vector reinsert was ANN-visible after video2deletion while scoped authenticated search returned0. The runtime collector delivered one synthetic active-cleanup incident to the separate HTTPS sink with204; repeat observation delivered0 and the receiver retained one event (excluding a separately labeled direct transport probe).

Cleanup removed every active isolated resource, explicitly retired both Durable Object namespaces and detached the queue consumer without force-deleting dependencies. D1/R2/Worker/sink/Workflow return404; both queues have no matching entries; DO namespaces have no matching entries. Vectorize returns410/code3005 `vectorize.index.deleted`, an explicit provider deletion tombstone. This proves active-resource removal, not provider-internal backup erasure. Cleanup tooling retained a retry-only queue handler during class retirement; missing-handler and consumer-dependency guards were observed and resolved without forcing deletion.

Still open: approved production RPO/RTO and RAG latency/cost targets; production-volume/corpus-density and statistically reliable cold/tail measurement; exact per-request DB rows-read attribution; portable managed Queue/Workflow checkpoint recovery; production notification destination and human acknowledgement; PostgreSQL lifecycle observation; backup retention/restoration policy acceptance. Provider-managed embedding/answer aliases do not expose immutable weight receipts. The delegated15m/24h policies are decided, but these isolated experiments do not establish production achievement or close those operational acceptance gaps.
