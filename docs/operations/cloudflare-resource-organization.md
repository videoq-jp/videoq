# Cloudflare resources for VideoQ

## Account and billing

VideoQ stays in the existing account `12daec56fdba43f677f2766ee26a5a39`.
The operator chose shared billing on 2026-11-17. Do not provision a second
Workers Paid subscription or transfer the production zone as part of resource
organization. Tags classify resources; they do not create a billing or access
control boundary.

In the dashboard, open **Manage Account → Resource Tagging** and filter by
`project=videoq`. All seven production resources below were tagged and read back
on 2026-11-17 with `project=videoq` and `environment=production`.

| Resource type | Current physical name | Component tag | Intended name for a future replacement |
| --- | --- | --- | --- |
| D1 | `videoq-d1-migration-staging-v4` | `database` | `videoq-prod-db` |
| Vectorize | `videoq-scenes-migration-v3-1536` | `scene-search-1536` | `videoq-prod-scenes-1536` |
| Vectorize | `videoq-scenes-migration-v3-768` | `scene-search-768` | `videoq-prod-scenes-768` |
| Worker | `videoq-api` | `api` | Keep current name |
| Worker | `videoq-web` | `web` | Keep current name |
| Worker | `videoq-docs` | `docs` | Keep current name |
| R2 | `videoq-media-prod` | `media` | Keep current name |

The live D1 database ID is `e57d0931-18cb-4f00-ae7f-b0068030fb04`.
Names containing `migration` or `staging` in this table are still production
resources. They must not be deleted as rehearsal artifacts.

## Naming work still required

Tagging is complete for the table above. Replacement Vectorize indexes
`videoq-prod-scenes-1536` and `videoq-prod-scenes-768` have been created in the
existing account; they are candidates, not the live bindings. Existing live D1
and Vectorize names have not changed. The documented APIs do not provide a direct rename operation for
these resources. Editing the name in Wrangler alone does not rename a resource.

A replacement must preserve data and authentication state, vector dimensions,
metric and metadata indexes; verify ownership filters and search quality; drain
writers; switch bindings and the reviewed AWS maintenance target configuration;
and verify production before retiring the previous resources. Keep the existing
account, billing, R2 bucket, Worker identities, secrets and DNS while doing this.
Use the existing migration and recovery runbooks for the data validation gates.

## Scope exclusions and temporary account

Resources belonging to other projects are not tagged or changed. Older rehearsal
resources and `videoq-design-review` need a separate ownership and usage check
before being classified or deleted.

The accidentally created, empty `VideoQ` account
`3663df35267b7e3368c2cefdc370ea35` has no subscriptions. Its individual deletion
was requested by the operator, but the documented API returned HTTP 403/code1002.
Support case #02436355 was submitted with the operator’s explicit authorization;
account deletion remains pending. Never delete the user profile to remove this account:
that can also delete the existing production account.

## References

- [Resource Tagging](https://developers.cloudflare.com/resource-tagging/)
- [Supported resource types](https://developers.cloudflare.com/resource-tagging/reference/resource-types/)
- [Manage tags](https://developers.cloudflare.com/resource-tagging/how-to/manage-tags/)
- [Account deletion API](https://developers.cloudflare.com/api/resources/accounts/methods/delete/)

## Private vector copy preparation

`infra/scripts/snapshot_scene_vectors.py` reads the fixed current indexes using
only index info, paginated ID listing and `get_by_ids` (at most 20 IDs per call).
It preserves vector values, metadata and namespaces. REST `namespace: null`
means the default namespace and is normalized to omission for later upsert.
It does not call an embedding model or write any remote resource.

Supply an operator token privately in `CLOUDFLARE_API_TOKEN`, create an empty
mode-0700 output directory, then run:

```sh
python3 infra/scripts/snapshot_scene_vectors.py --output-dir /private/vector-copy
```

The tool refuses duplicate/missing IDs, invalid dimensions/non-finite values,
changed index-info or changed ID inventory. Output files are mode 0600 and a
failed snapshot removes files it created. Keep the NDJSON out of Git, logs and
CI artifacts; delete it after migration verification. Aggregate receipts contain
counts and hashes. Repeated reads are diagnostic consistency checks and do not
prove writer quiescence or provide an atomic snapshot. Final transfer must run
under the reviewed maintenance hold, writer drain and deployment exclusion.

[Aggregate preparation evidence](evidence/cloudflare-resource-organization-2026-11-17.json)
records the read-only snapshot counts and hashes. All 2,190 current 1536d vectors
were retrieved without model calls; the 768d index was empty. This is preparation,
not proof of a final writer fence, target verification or completed cutover.


## Replacement candidate validation

The unbound D1 candidate `videoq-prod-db` has UUID
`587bd210-6d9d-4f32-abb7-a490013e65d3`, APAC placement and disabled read replicas.
It remains empty after synthetic compatibility checks. Production still uses
its original D1 UUID and Vectorize bindings.

The 2,190 stored 1536d vectors were copied to `videoq-prod-scenes-1536` and all
values, metadata and normalized namespaces matched the source on readback.
Both 768d indexes contain zero vectors. Queries using one stored scene vector
per each of 80 video scopes returned identical top-five IDs, ordering and scores;
160 wrong-owner queries across source and candidate returned no hits. This is a
filtered self-query comparison, not a human question or generated-answer eval.
No model calls were made. These candidates still require final synchronization
under a proven write fence before production use.

`infra/scripts/d1_resource_write_fence.py` plans owner-bound BEFORE INSERT,
UPDATE and DELETE abort triggers for every inventoried application table. It
preserves existing application triggers, refuses virtual tables and conflicting
fences, and refuses removal if the schema or fence coverage changed. The module
only returns SQL and verifies schema metadata; it never executes SQL or claims
a maintenance lock. It does not provide deployment exclusion, admissions pause,
consumer control, final transfer, binding promotion or post-write recovery.
A production coordinator must supply those before this can be used on live D1.
Cloudflare-reserved `_cf_` and SQLite-reserved `sqlite_` objects are excluded.
An empty-table UPDATE/DELETE may succeed without invoking row triggers because
it changes no rows; actual row mutations are rejected while fenced.


[Real-D1 planner evidence](evidence/d1-resource-write-fence-2026-11-17.json): on
an unbound candidate, two synthetic tables and an existing audit trigger were
created. The exact planner's six triggers blocked six row mutations; removing
only the owned fence triggers restored writes and the audit trigger still ran.
Both tables were removed and the candidate's empty schema was rechecked. This
proves the primitive on real D1, not a production-wide fence or final cutover.

## D1 resource-replacement ownership hold

The opt-in `d1-resource-hold` operation uses the existing AWS migration starter
and the existing maintenance state machine. `enable_d1_resource_hold` defaults
to `false`; this change does not enable or start a production hold. It provisions
no new CodeBuild job or starter and grants the starter no SSM, IAM or function
update capability. It does not restore the retired Neon cutover operation.

The starter requires the current canonical `main` SHA, rejects target/build/data
plane overrides, checks existing builds and atomically creates the shared owner
and non-expiring run journal before starting its named execution. Concurrent
maintenance requests see the lock. A terminal hold retains ownership and refuses
automatic replacement by an ordinary migration/deploy request.

The state machine waits without running builds. Release requires the same
execution, kind and pinned source; a `verified` or `aborted` phase; restored API,
consumer and deployment admission markers; and a nonempty completion receipt
with a SHA-256-length digest. These are trusted coordinator attestations, not
independent Cloudflare probes or a cryptographic check performed by Step
Functions. Only the reviewed administrative coordinator may write them after
verifying the underlying state. Routine callers cannot supply these fields.

Keep the feature disabled until the coordinator implements and rehearses
ownership-bound deployment freeze, admissions/consumer stop, D1 row-write
fencing, private final transfer and full validation, binding/config promotion,
post-write recovery and actual end-to-end probes. A timed-out or failed hold
must be recovered explicitly from its journal; do not manually remove its lock
merely to unblock CI. The ownership primitive alone proves none of those
production conditions.

[Ownership-hold validation evidence](evidence/d1-resource-hold-2026-11-17.json)
records local conditional-transaction tests, Terraform mock tests and AWS
definition validation. It does not attest an actual production hold or cutover.

## Replacement progress journal and execution engine

`d1-resource-journal.cjs` binds the twelve fixed replacement steps to a running
`d1-resource-hold`, its canonical source SHA, immutable execution-definition
hash and shared maintenance owner. Each step stores an intent before mutation
and a receipt digest after verification, using revision-conditional DynamoDB
transactions. Completed steps and their plan/proof digests cannot be replaced.
Lost transaction responses reconcile exact durable readback. A promotion intent
blocks a simple pre-promotion abort even if the promotion response was lost.
The journal stores only step names, operation IDs and digests; no customer data,
SQL exports, vector values or credentials belong in it.

`d1-resource-coordinator.cjs` advances one step at a time and requires explicit
prepare/probe/apply adapters for every step plus environment/ownership checks.
It probes before applying and after the single apply attempt. Unknown state
stops for reconciliation; an applied result can reconcile a lost response
without reapplying. A probe may authorize a retry only after authoritative
readback establishes that applying the planned operation is safe. The engine
never releases the hold, marks production safe or supplies placeholder adapters.
Both journal and engine are disabled by default and have no production CLI.

`d1-resource-plans.cjs` retains transient original operator metadata in a private
mode-0700 directory with exclusive mode-0600 files, fsync and bounded readback.
Only fixed step filenames are permitted. Symlink roots/files, changed directory
identity, public files, overwrites and malformed/oversized data are rejected.
Plans are limited to 1 MiB each. Losing an intent's original private plan stops
the engine; it cannot infer the original state from an already changed service.
Keep these working plans until verified completion/recovery, then remove them.
Do not put tokens, application secrets, exports or customer rows in plans.
This local store does not provide independent cross-host disaster recovery.

The engine/journal were exercised against real DynamoDB Local conditional
transactions with explicit test transports for Step Functions and data-plane
adapters. Private-file tests cover durable reopening and permission checks.
These tests prove control flow and metadata ownership, not actual deployment
freeze, consumer drain, final database transfer, binding promotion or E2E.
Concrete production adapters, final release and recovery remain required before
`enable_d1_resource_hold` can be enabled.

[Journal and execution-engine validation evidence](evidence/d1-resource-journal-2026-11-17.json)
records the test scope and the production operations that remain unverified.

`d1-resource-deployments.cjs` supplies the GitHub admission freeze/restore
adapters using the existing fixed workflow controller. Both operations require
the saved original freeze plan and ownership before mutation. Frozen workflows
with accepted runs still active return unknown and cannot advance the journal.
Restore reuses the original plan, preserving workflows that were already
disabled. Lost responses reconcile read-only admission state. This adapter
covers GitHub workflow admission only, not AWS build drain or D1 writes; it has
no production transport, credentials or caller enabled by this change.

`d1-resource-consumers.cjs` supplies the SQS mapping pause/resume adapters for
the three existing production Lambda consumers. Mapping identity and original
enabled state are preserved in the private pause plan. The adapter requires
ownership and a backend-safety verifier before every mutation, rejects mapping
replacement and unexpected states, and waits for asynchronous transitions by
returning unknown. It reads no Lambda environment or application credentials.
Disabled mappings prove admission pause only; they do not prove running or
direct invocations have drained. The D1 source row-write fence remains required.

`d1-resource-api.cjs` supplies API traffic pause/resume adapters. The original
private pause plan remains immutable. After binding promotion, a new restore
plan can be prepared only while paused, under ownership, with a verified
backend-handoff binding hash and the unchanged runtime-settings hash. The
original plan cannot silently accept a changed database. Resume rechecks the
handoff before each write and reconciles metadata readback; secrets are inherited
by name. The handoff verifier is a mandatory trusted coordinator dependency;
this change does not implement its production proof of database/vector transfer
and target fence removal. API admission pause is not an in-flight write fence.

`d1-resource-bindings.cjs` implements the fixed same-account binding promotion
from the recorded live D1/Vectorize resources to the named candidates. It
requires API pause, unchanged runtime and original binding hashes, a stable
paused version, ownership and a trusted transfer-verification callback. Only
`DB`, `SCENE_VECTORIZE_1536` and `SCENE_VECTORIZE_768` change; all other bindings,
including traffic pause and secrets, inherit by name. Complete target readback
can reconcile a lost response without another write. Partial or unrelated
binding changes return unknown and cannot authorize another mutation. No
rollback operation is supplied. This does not yet implement the production
transfer verifier or activate any provider mutation.

The settings PATCH contract is documented in the
[Cloudflare API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/edit/).
The D1 readback includes both `id` and `database_id`; the adapter checks both
against the fixed source and computes the expected target readback shape.
Unexpected extra DB/vector metadata fails closed for review.

`infra/scripts/d1_resource_fence_control.py` applies the existing owner-bound
fence plan to the fixed source and removes only those exact triggers from the
fixed target. Each mutation requires ownership and rechecks schema/trigger
identity. Partial installation/removal can be reconciled after a lost response;
unknown trigger definitions, missing original triggers or changed tables stop
further writes. Target removal additionally requires a trusted target-safety
verifier. Source removal is deliberately unavailable in this controller.
The coordinator bridge is not implemented by this change.
SQLite tests prove trigger behavior and retry control, not the full live-D1
schema, API transport or production ownership handoff.

`infra/scripts/d1_resource_fence_transport.py` implements the fixed-account D1
query transport for schema reads and exact owner-plan fence SQL only. Mutations
are disabled by default; enabling them requires a valid fence plan. It permits
source trigger creation and target trigger removal only, refuses redirects and
unbounded responses, sanitizes provider errors and never retries a query after
an uncertain response. Ownership remains the controller's responsibility.
Actual schema-only readback found 68 application tables on the source, none on
the candidate, and no resource fence triggers on either. No fence was installed.
The query payload/result contract follows the
[D1 query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/).

`infra/scripts/d1_resource_verify.py` compares schema, columns, all row values,
foreign-key integrity and `sqlite_sequence` high-water marks under a mandatory
fence verifier. It includes application indexes, views and triggers, excluding
provider-reserved schema. SQLite encodes type and value bytes before JSON
transport so 64-bit integers are never rounded by a JavaScript number. Sorted,
bounded pages preserve duplicate rows and ignore physical insertion order;
independent counts reject shortened/truncated reads. Only aggregate digests and
counts are returned. SQLite tests cover changed integer/type/blob values,
sequence-only differences, schema changes, lost fencing and missing rows.
The full D1-to-D1 comparison remains unperformed; this module does not attest a live copy.

`infra/scripts/d1_resource_verify_transport.py` permits schema, column metadata,
counts, foreign-key checks and exact generated value pages for the two fixed
D1 databases. Tables come from the validated fence plan; each database's column
identity must be observed before pages are allowed. Generic reads/writes,
unknown tables, appended statements and oversized/negative paging parameters
are refused. The bounded, no-redirect, no-retry HTTP transport is shared with
fence control. The real source accepted the generated encoding SQL for 14
`sqlite_sequence` metadata rows. This read made no mutations, read no customer
rows, asserted no write fence and performed no full database comparison.

`infra/scripts/d1_resource_transfer_api.py` supplies the fixed source export and
fixed target import API operations, with ownership and source-fence/import-file
safety dependencies. Each call is attempted once; an uncertain response is not
replayed automatically. The coordinator must durably record intent and returned
bookmarks before continuing. A lost initial export or ingest response requires
reconciliation, not a new operation. Export polling keeps the same bookmark and
checks ownership without querying the source while the provider blocks it.
This module does not implement durable transfer substeps, signed-URL file
transfer, file validation or recovery, and has no production caller/CLI.
See the [export API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/)
and [import API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/import/).

`infra/scripts/d1_resource_files.py` handles private SQL artifacts using
provider-supplied HTTPS R2 signed URLs. No bearer token is accepted or forwarded.
The existing owned mode-0700 directory is pinned, downloads use exclusive
mode-0600 files, completion fsyncs the file and directory, and final promotion
cannot overwrite an existing artifact. Interrupted downloads remain `.partial`
and require explicit recovery. Uploads recheck SHA-256/size and the R2 MD5 ETag;
MD5 is a provider-required transport checksum, not the integrity authority.
Redirects and automatic retries are disabled. Files are limited to 1 GiB, and
unexpected URL hosts are refused. Tests use private local files and fake HTTP;
no signed production URL has been downloaded or uploaded. Durable transfer
substeps, dump validation and full recovery remain required before live use.

`infra/scripts/d1_resource_dump.py` validates the private source SQL before
upload by restoring it to an isolated in-memory SQLite database. It checks the
file proof before and after, retains transaction boundaries while reading
complete SQL statements, denies database attachment/extensions/unsafe pragmas,
and compares full schema/values/sequence plus exact owned fences against the
frozen source snapshot. The SQL artifact is unchanged. An unexpected dump
format or incomplete restore fails closed; the validator does not repair a dump
or substitute maximum visible IDs for sequence high-water marks. Tests cover
round-trip equality, corrupted values/sequence, missing fences/indexes and
attempted filesystem access. No production export has been restored yet.

`d1_resource_transfer_journal.py` stores eleven fixed ordered transfer records in
a dedicated owned mode-0700 directory, using exclusive mode-0600 files, file and
directory fsync, pinned directory identity, run/source/plan context and a digest
chain. Reopening preserves exact records; gaps, partial writes, altered proofs,
unsafe files and context changes refuse recovery. Signed URLs remain private.
This local working journal does not provide a distributed execution lease or
independent disaster recovery; the owned coordinator must serialize callers.

`d1_resource_transfer_control.py` connects the export, private download, dump
verification, import initialization/upload/ingest/polling and final database
comparison stages. Export/ingest intent is durable before the request; a lost
start response stops for explicit reconciliation rather than issuing another
start. Polling keeps the original bookmark. File proof drift and negative dump
or database verification refuse advancement; reentry after verification checks
the actual target again. The controller advances one stage per call and has no
live caller. Tests use real private journal files with explicit provider/file
and ownership fixtures. Integration with the AWS owner, an exclusive executor,
full live data adapters and lost-start reconciliation remains required.

The resource journal can claim a single executor token before any steps start.
Only its SHA-256 digest is stored in DynamoDB; subsequent ownership checks and
conditional journal writes require that exact executor. A competing token,
tokenless journal or replaced digest refuses access. Claims have no automatic
expiry or takeover. The production coordinator must persist its private token,
claim it before steps and use `assertExecutor` for all data-plane callbacks.
Unclaimed journal primitives remain available for metadata tests; they must not
be used to run production transfer operations.

`infra/scripts/d1_resource_executor_lock.py` supplies the additional local
nonblocking kernel lock for the private artifact directory. It keeps the lock
file inode, rejects replacement/unsafe permissions and releases descriptors on
exception. Never delete a lock file to bypass contention. This local lock and
the AWS token must both guard the production executor; they do not by themselves
connect the Node/Python adapters or provide lost-start reconciliation. Tests
cover real DynamoDB Local competing claims and actual filesystem lock contention.

`d1-resource-bridge.cjs` connects the claimed Node executor to the one-shot
`infra/scripts/d1_resource_worker.py` over private stdin/stdout pipes. The worker
requests fresh executor/operation authorization before and after work and at
fence mutations; target removal additionally requests target-safety approval.
Tokens and plans do not enter argv, inherited credentials or public errors.
The protocol bounds messages, serializes checks and terminates failed/timed-out
children. The worker supports fixed fence prepare/inspect/install/remove actions
and an ownership-only diagnostic. It is disabled unless explicitly enabled.
The parent is trusted reviewed code, not a credential security boundary.

Tests launch real Python children and connect them to real DynamoDB Local
executor claims and pending-operation checks. These tests prove protocol and
ownership behavior; they perform no production D1 mutation. The full production
factory, local-lock lifetime, transfer worker action, final vector sync and
recovery/release are still required before enabling execution.

`d1_resource_transfer_runtime.py` composes source snapshot verification, the local
executor lock, private files and transfer journal, provider API operations, local
dump restoration and final source/target comparison. Import initialization and
ingest require parent safety approval, a still-fenced source, an empty target,
and a matching validated file proof. It never merges into a populated target.
Status queries revalidate a completed copy before returning its receipt digest.

The pipe worker now supports copy prepare/advance/status actions and requests
an additional import-safety authorization. `d1-resource-data.cjs` binds source
fencing, database copy and target unfencing to the same persisted plans. A copy
advances one durable stage per invocation. The coordinator reports explicit
pending progress while keeping its intent unverified; unknown start outcomes
still require reconciliation and cannot restart an operation.

The runtime integration test uses actual private files, filesystem locks,
append-only records, SQL restoration and SQLite source/target comparisons with
HTTP-shaped provider responses. It checks exact int64 values, sequence high-water
marks, retained target fencing, refusal of populated targets and uncertain export
starts. This is not a real Cloudflare transfer rehearsal. The full production
factory and environment checks, lost-start reconciliation, final vector sync,
release/recovery and live E2E remain required before execution is enabled.

`d1_resource_vector_plan.py` derives desired vectors from current D1 scenes and
current staging heads using the application's authority rules. Pending deferral
requires an unaccepted incomplete upsert with an exact scope and retained,
valid, nonzero float32-compatible embedding payload. Cleared/accepted payloads
cannot justify missing source vectors. The pure planner preserves exact source
values/metadata, validates owner/video/scene/revision and legacy IDs, removes
obsolete candidate IDs, and records deferred work without modifying the outbox
or calling a model. Nondefault namespaces require explicit review.

`d1_resource_vector_authority_transport.py` permits only the fixed source's
count and bounded authority pages. The real source count query returned 2,190
rows in an unfenced read-only preview. This is not final synchronization proof.
The planner and SQL tests cover scope/version mismatches, current staging,
invalid retained embeddings, orphan deletion, legacy IDs and missing vectors.
Provider mutation, async processing/readback and runtime integration of the
final vector sync remain required before switching resources.

`d1_resource_vector_transport.py` limits reads to the two fixed source/candidate
pairs and mutations to the candidates only. Writes default to disabled and
require fresh ownership plus a D1/plan-safety callback. Upserts use the `vectors`
NDJSON multipart field; deletes have bounded unique IDs. Unexpected paths,
methods, queries, dimensions or payloads refuse execution. Responses are bounded,
redirects refused, provider errors sanitized and uncertain requests never retried
by the transport. `snapshot_index` can now read back either fixed member of a
source/candidate pair using the same complete-inventory validation.

`candidate_status` compares every stored value and metadata field against the
planned payload and rejects completion while vectors differ or obsolete IDs
remain. Deferred outbox work stays explicit in the receipt. Acceptance of a
mutation ID is never treated as completion. Read-only service inspection found
2,190 vectors in both 1536-dimensional indexes and zero in both 768-dimensional
indexes. This unfenced count preview is not a final value or search-quality
comparison. No vector mutation was made by this validation; mutation journal,
async runtime and final owned synchronization remain to be connected.

`d1_resource_vector_batches.py` records per-batch intent, acceptance and verified
readback using the same private hash-chained journal with a fixed three-phase
profile. It never reposts an unmatched intent after a lost response. Matching
readback can reconcile that response; accepted but unprocessed work remains
pending. A verified batch that later differs refuses continued success.

`d1_resource_vector_runtime.py` stores large payload batches in bounded private
mode-0600 files, with an immutable manifest/digests in the Node plan. Under the
local lock it rechecks source fencing and D1 authority, advances candidate-only
batches, and performs final complete candidate inventory/value comparison.
Existing matching batches become verified no-ops. Source authority, artifacts
or scope changes stop writes. Deferred outbox work is reported explicitly.
The worker now exposes prepare/advance/status vector actions, requires a separate
parent vector-safety approval and connects them through `d1-resource-vectors.cjs`
to the fixed synchronization step. No large vector values enter DynamoDB/argv.

Async integration tests use real files, locks and journals, a SQLite-backed D1
fixture and delayed Vectorize responses. They cover orphan removal, accepted
but unprocessed updates, lost acceptance reconciled without repost, fence loss
and artifact corruption. These are not production mutations or Cloudflare
rehearsal. Full environment/factory checks, final proof/release/recovery, native
E2E and the live switch remain outstanding.


## Completion gate

`d1-resource-completion.cjs` requests release only after all twelve fixed steps
are verified and the same executor still owns the running hold. A mandatory
trusted verifier must freshly attest restored API/consumer/deployment admission,
retained source fencing, removed target fencing, the exact account/D1/Vectorize
targets, stable API version and the pinned native E2E result. The E2E proof must
match the verified E2E step receipt. The gate itself validates the attestation's
shape and identity; it does not implement those Cloudflare/AWS probes.

The gate atomically saves the completion receipt/digest and restored-admission
markers while requiring unchanged source, executor, revision, complete step
journal and shared owner. A lost write response reconciles exact durable
readback. Reentry validates the stored receipt and step chain; it reports a
historical release request, not current production health. The gate never
issues a lock delete. The existing state machine performs its own conditional
release after the receipt is durable, retaining the run journal.

The gate defaults to disabled and has no production caller. Pre-promotion abort,
post-promotion forward recovery, fresh environment/native-E2E verification and
final wiring remain necessary before enabling it.
[Completion-gate evidence](evidence/d1-resource-completion-2026-11-17.json)
records unit tests and actual DynamoDB Local conditional release with explicit
provider/E2E fixtures; no production hold was released.


`d1-resource-smoke-proof.cjs` verifies native E2E provenance using read-only
CodeBuild project/build metadata. Preparation requires the fixed smoke project,
S3 version pin, canonical reviewed-source tag, D1 mode and single-build limit.
Verification checks unchanged project/source/buildspec/role/runtime, an exact
execution environment with AI verification enabled, successful completion and
start/end times after the recorded resume boundary. AWS SDK Date objects retain
subsecond precision. No build is started and no logs or SSM values are read.
The resource-owned launcher/worker guard still needs to be connected.

`d1-resource-current-state.cjs` composes completion observations from the persisted
plans and their verified journal hashes. It reads stable fixed API bindings,
original consumer/deployment admission, exact source/target fence state and the
native smoke proof. The native proof is tied to the E2E step's API version and
binding hash; API/journal state is rechecked after the parallel probes. It returns
only the fixed completion attestation. Tests use explicit provider fixtures;
production probes have not been run and no production release is authorized by
these test results. Pre-promotion abort, post-promotion recovery, owned native
smoke execution and the full production factory remain outstanding.


## Owned native smoke worker guard

`d1-resource-smoke-guard.cjs` protects opt-in resource smoke jobs before their
existing credential reads, before child launch and after child completion. It
requires the live D1 resource hold, matching executor and definition hashes,
verified preceding steps, pending E2E plan, action ID, immutable source version
and registered exact CodeBuild ARN. A starting registration may settle for a
bounded interval; a conflicting registration or terminal/lost hold refuses
execution. Resource smoke mode cannot fall back to PostgreSQL. Ordinary smoke
mode remains unchanged when the resource-specific flag is absent.

The operator bundle includes the guard and digest dependency, and both runtime
fixture CI and canonical maintenance deployment track these inputs. Optional
IAM additions give only `GetItem` on owner/run records and the two describe APIs
on the fixed maintenance execution ARN, gated by both existing opt-ins. There
are no new jobs, starters, lock writes or control permissions. The execution
resource scope follows the [AWS authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_stepfunctions.html).

Native proof now binds the action, complete E2E plan hash, executor hash and
execution-definition hash to the exact build environment. The source/version,
AI and stable-API checks remain required. The disabled owned launcher below implements registration and ambiguous-start
reconciliation; production factory wiring is still required.
[Guard evidence](evidence/d1-owned-smoke-guard-2026-11-17.json) records local unit,
bundle-input and Terraform mock checks. No IAM configuration or AWS job was
started by this validation.

## Owned native build launch and reconciliation

`d1-resource-smoke-launcher.cjs` uses the existing fixed smoke project under the
claimed resource hold. Its default is disabled. It records action, full E2E plan
hash and immutable source version in the owned run before one `StartBuild`
attempt, then registers the exact build ARN after verifying reviewed code, role,
runtime and the complete environment. Registration uses revision-checked
transactions with a condition on the shared maintenance owner. Worker credential
access waits for that registration through the guard above. No role, image,
buildspec or credential override is accepted by the launch input.

An ambiguous start is never automatically retried, even after the provider's
idempotency window. Reentry scans bounded project metadata and registers only
one exact matching action. Missing, duplicate or incomplete inventory stops for
reconciliation. A crash between durable intent and dispatch can therefore need
explicit recovery; it cannot silently create a second build. Lost DynamoDB
responses reconcile only against the exact durable revision and fields.

This module has no CLI or production caller yet. Production factory wiring,
real provider rehearsal and recovery remain prerequisites to enabling the hold.
No AWS job, IAM apply or live cutover was performed by these tests.
[Launcher evidence](evidence/d1-owned-smoke-launcher-2026-11-17.json) records
the local checks and their limits.

## E2E coordinator adapter

`d1-resource-e2e.cjs` connects the owned launcher to `verify-e2e`. It requires
all ten preceding steps verified, matching saved resume/promotion plans and the
actual stable production Worker with the fixed named D1/Vectorize targets. The
private E2E plan pins the active Worker version and binding digest. Native start
time must follow a fresh post-resume observation. Every probe and launch checks
that the Worker still matches the plan.

A running or unregistered build remains pending; the latter uses the launcher's
metadata reconciliation. Failed builds cannot mark the step verified. Successful
proof is hashed together with the exact API version and binding digest, matching
the final current-state verifier. The registered build can be read after E2E is
verified without requiring the step still pending. Application credentials stay
inside the existing AWS smoke worker.

Local validation: 612 Node tests and 10 DynamoDB Local integration tests passed.
The latter exercises the real registration transactions, lost write response,
reentry without restart, post-verification lookup and changed shared ownership.
Cloudflare/CodeBuild transports in these checks are explicit fixtures. Production
factory wiring, recovery and real provider rehearsal remain outstanding.

## Pre-promotion abort isolation

`requestAbort()` in the owned resource journal conditionally records a durable
abort request before any source-unfence action. The revision check serializes
this decision against ordinary step progress. Normal executor/step operations
then refuse to continue; `assertAbortExecutor()` requires the same live claimed
executor and shared maintenance owner. Any recorded promotion intent prohibits
this abort path. The request retains the hold and does not authorize release.

`d1-resource-abort-safety.cjs` requires the original private fence/pause/freeze
plans to match the journal and freshly observes the old source D1 binding, paused
API, disabled SQS admission, frozen deployment workflows and drained accepted
runs. A mandatory runtime callback must also prove that in-flight workers have
stopped; disabled admission alone is insufficient. The private Python bridge
requires this separate source-safety approval throughout removal.

Source removal uses an explicit transport mode permitting only exact owned
source trigger drops. Ordinary transport still refuses source drops; abort
transport refuses target drops and source trigger creation. The SQLite control
rechecks ownership and safety before every removal, preserves original triggers,
and reconciles a partial lost response without duplicating removals.

The abort recovery controller below connects admission restoration and durable
abort completion. Production executor wiring and real provider rehearsal remain
required before enabling the resource hold. No source fence or
other production resource was changed during validation.
[Abort evidence](evidence/d1-prepromotion-abort-2026-11-17.json) records the local
fixture and real DynamoDB Local transaction checks.

## Pre-promotion recovery and conditional release

`d1-resource-abort-recovery.cjs` advances one restoration stage per call under the
durable abort intent. It uses only original private plans whose hashes match
recorded normal intents; absence of an intent cannot authorize an admission
mutation. It reconciles source fence removal before restoring original API
traffic, original SQS admission, then original deployment admission. Originally
disabled entry points remain disabled. Changed bindings, private plans or
ownership refuse further restoration.

The final probe requires old source D1 and Vectorize bindings, a stable API, a
fresh source-unfenced schema proof and restored planned admissions. Only then
does a revision/owner-checked transaction store the hashed abort receipt, all
three restore markers and the release request. The controller never deletes the
maintenance lock. The existing state machine conditionally releases it after
that durable proof. A lost completion write response is reconciled against the
exact stored receipt; completed reentry reads retained historical proof rather
than claiming current service health.

Validation includes 624 Node tests and 12 DynamoDB Local integration tests.
The real-DynamoDB recovery test demonstrates durable abort completion followed
by the existing conditional ASL release and retention of the receipt. Separate
fixtures cover ordered restoration, originally disabled admissions, early abort,
changed plans/bindings/ownership and provider error sanitization. No production
recovery or cutover was executed. Production source-fence bridge and in-flight
worker-drain wiring still need to be supplied by the full executor.

### Native build inventory pagination

Reconciliation omits `sortOrder` on every `ListBuildsForProject` request. AWS
rejects an explicit order once a project has more than 100 builds; the default
order is descending. The first read-only page of the actual smoke project on
2026-11-17 contained 100 IDs and a continuation token, so this is a live
compatibility requirement. A fixture locates the one matching owned build on
the second page without starting another build. Full inventory is still bounded
and incomplete or repeated pagination refuses registration. See the
[AWS API reference](https://docs.aws.amazon.com/codebuild/latest/APIReference/API_ListBuildsForProject.html).

## Maintenance build runtime guard

`d1-resource-builds.cjs` inventories only the three retained maintenance projects,
including all bounded pages and exact batch readback. Missing records, foreign
project/ARN identities, duplicate IDs, malformed completion state or incomplete
pagination refuse an idle claim. It returns only build counts and active build
identity/status, without logs, credentials or application configuration.

The owned guard normally requires all three projects idle. Only a pending E2E
step may permit one active build on the existing smoke project, and only if the
full private E2E plan hash matches the journal and native provenance matches
reviewed source, role, runtime and environment. This also permits the exact
unregistered build to reach reconciliation after a lost start response, while
the credential guard continues to require registration. Abort mode exempts no
active build. This read-only guard complements deployment admission and the
shared maintenance hold; it does not prove Lambda invocations have drained.

A complete read-only production preview observed 45 migration builds, 151 smoke
builds and 28 deploy builds, with zero active at that observation. This is a
point-in-time preview, not a cutover receipt. The composed runtime below invokes this guard at its stage boundaries; a
reviewed operator entry point is still required.
[Runtime inventory evidence](evidence/d1-resource-build-inventory-2026-11-17.json)
records the aggregate preview and fixture limits.

## Composed resource runtime

`d1-resource-runtime.cjs` connects all twelve coordinator adapters, private Python
bridge, native AWS E2E proof, current-state completion and pre-promotion abort
recovery. Construction contacts no provider and defaults to disabled. Claim,
advance, completion and abort use the same pinned executor/ownership context.
Enabled construction requires a bounded private Cloudflare token and explicit
reviewed-runtime/exclusive-executor and in-flight-worker assertions; it does not
discover credentials or supply permissive production callbacks.

Stage boundaries check complete maintenance build inventory and the appropriate
deployment, queue, API and source/target fence state. Initial bindings must name
the old source resources before even freezing deployment admission. The private
bridge permits only the corresponding pending operation and exact saved input.
Fresh full copy/vector readback is required before promotion. During incremental
target-unfence, the runtime instead uses durable verified transfer receipts, the
intact source fence, paused target API and closed admissions. After target writes
are resumed it verifies target bindings and source/target fences, rather than
trying to compare live target data to a frozen historical snapshot.

The composed integration exercises real DynamoDB Local ownership transactions
and real private plan files through all twelve stages, native build registration,
completion receipt and conditional release. A second scenario aborts after source
fencing and restores only the old backend/admissions; another refuses an
unexpected initial DB before any mutation intent. Cloudflare, Lambda, GitHub,
SQL/vector transfer and native model execution are explicit fixtures in these
composition scenarios. Existing Python tests separately cover SQLite/files and
HTTP-shaped provider transport behavior. This is not provider rehearsal or RAG
quality evidence.

Local validation: 632 Node tests and 15 DynamoDB Local integration tests passed.
Production operator entry point, real exclusive-lock/drain assertions, canonical
configuration handoff, post-promotion forward recovery and actual isolated
provider rehearsal remain outstanding. The production hold remains disabled.
[Composition evidence](evidence/d1-resource-runtime-2026-11-17.json) distinguishes
implemented wiring from unexecuted production behavior.

## Local coordinator lock lifetime

`withLockedResourceRuntime` now wraps a runtime invocation in a real kernel lock
held by a small Python keeper. Its `coordinator.lock` is separate from each SQL
or vector worker's `executor.lock`, so a guarded transfer can still acquire its
inner lock. The keeper receives only a private directory, parent PID and random
owner nonce through stdin; cloud credentials are absent from its environment,
arguments and protocol. Serialized checks cover service calls, plan access and
runtime/drain assertions before and after execution.

The lock inode and a private identity record are retained. A changed inode,
unsafe directory/file or changed parent record refuses continuation. An abnormal
keeper exit leaves its parent recorded as holding the lock; a replacement cannot
enter while that parent remains alive. There is no timeout takeover or automatic
keeper restart. Normal completion releases the kernel lock without unlinking it.
The AWS executor claim is still required; this local lock does not replace it or
provide cross-host exclusion for deliberately copied credentials/artifacts.

The wrapper permits only one runtime action at a time. If its caller fails after
starting an action, it waits for that action to settle before releasing the
keeper; retained runtime handles cannot start work after the callback finishes.
The keeper never changes any AWS hold or admission flag.

Validation: 640 Node tests, 161 Python tests and 16 DynamoDB Local integration
tests passed. Actual subprocess tests cover competing keepers, async checks,
callback failure, inode replacement, abnormal EOF with a live parent, retained
handle refusal and action draining. The composed real-DynamoDB scenario holds
the real local lock through claim and early abort, then proves conditional ASL
release. Cloud provider and model transports remain explicit fixtures in that
scenario. Real canonical-source/runtime and in-flight Lambda/Worker drain checks
and the reviewed operator entry point are still required; no production cutover
was performed. [Lock evidence](evidence/d1-resource-executor-lock-2026-11-17.json)
records the implementation and remaining limits.

## Reviewed source and provider metadata preflight

`d1-resource-preflight.cjs` checks the clean exact operator checkout against
canonical main history, fixed AWS account and smoke role/source/runtime, the
immutable operator version and reviewed-source tag, and all six D1/Vectorize
resource identities/configurations. All legacy/backup flags must remain false,
D1 smoke must be enabled, both D1 replication modes must remain disabled and
each Vectorize index must retain its expected dimensions and cosine metric. A
pinned project digest refuses configuration drift; advancing main does not
prevent recovery from the clean reviewed held commit. D1 metadata table counts
are not used as data or emptiness proof: Cloudflare deprecates that field.

The dedicated AWS transport allows only caller identity and the fixed smoke
project metadata. The Cloudflare transport allows only six fixed GET paths,
refuses redirects and bounds/sanitizes responses. Neither transport reads logs,
app/PG credentials or database rows. References: [D1 metadata](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/get/),
[Vectorize configuration](https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/get/).

`run-d1-resource-preflight.cjs --source <reviewed-sha>` is a read-only local
entry point. An optional `--project-sha256 <digest>` rechecks an existing pin. It
validates the checkout before acquiring credentials, then captures the installed
Wrangler 4 `auth token --json` output in memory with an isolated child environment.
It accepts only OAuth/API bearer tokens; it does not install/upgrade Wrangler,
launch browser login or print authentication output. A trusted absolute
`VIDEOQ_WRANGLER_BIN` can select an already installed executable. See
[Wrangler authentication](https://developers.cloudflare.com/workers/wrangler/commands/general/).

The smoke project's `ReviewedSource` must equal the held source; this is not
weakened to accept stale code. Before starting a hold, let main CI succeed and
run the existing **DB Maintenance CD** workflow through `workflow_dispatch` if a
refresh is needed. That existing path forces an immutable bundle refresh even
when main advanced only in files outside normal bundle selection. Wait for it
and verify the resulting project/source digest before fixing the run context.
Do not refresh the companion bundle during a held operation.

A read-only actual provider preview verified both DB identities/disabled
replication and all four index names/dimensions/cosine configurations. Its smoke
project still reported reviewed source `1eb7ae145265dda7c22afaa39299bab2cb418031`;
this preview therefore does not certify readiness for a later held source. An
expired OAuth token was refreshed with the existing Wrangler, and official token
retrieval was checked without secret output. No DB data or bindings changed.

Validation: 651 Node tests passed. [Preflight evidence](evidence/d1-resource-preflight-2026-11-17.json)
separates actual metadata/authentication reads from fixture source/drift checks.
The mutating operator entry point, actual worker-drain proof, canonical config
handoff, forward recovery and isolated provider rehearsal remain outstanding.

## Durable private run context

`d1-resource-context.cjs` pins run/source, execution-definition digest, verified
project/platform digests and a generated executor capability in one private
`resource-context.json`. Its artifact root path/device/inode are immutable, so
copying the file to another directory cannot retarget a run. Root ownership and
0700 permissions, file ownership and 0600 permissions, no symlinks, bounded JSON
and unchanged file metadata are checked on every read. There are no application,
Cloudflare or model credentials, SQL rows or generic extra fields in this file.

Initialization first proves the exact live unclaimed D1 hold and shared owner
through consistent DynamoDB reads and the bound Step Functions definition. A run
with an executor claim, prior step journal, abort request or noninitial revision
cannot generate another capability when its context is missing. Required resume
reads never silently initialize. Existing matching contexts are reused; changed
pins or corrupt records are retained and refused.

Publication writes/fsyncs a private temporary file, links it exclusively without
overwriting an existing context, fsyncs the directory and verifies exact readback.
Concurrent initializers converge on one record. The public summary contains only
source/proof pins and the executor digest; the capability stays private and is
never a command argument or log value. The store itself performs no AWS writes,
claim, release, build start or provider configuration change.

Validation: 657 Node tests and 17 DynamoDB Local integration tests passed. Actual
DynamoDB ownership is claimed with the stored capability in the new scenario;
after simulated local file loss, initialization refuses replacement and preserves
the original AWS owner and digest. Fixtures also verify atomic initialization,
root-copy refusal, symlinks, malformed data and summary redaction. This does not
activate the production hold. The mutating operator entry point, worker-quiescence
proof, configuration handoff and real provider rehearsal remain outstanding.
[Context evidence](evidence/d1-resource-context-2026-11-17.json) records scope and
limits.

## Scoped AWS operation transport

`d1-resource-aws.cjs` exposes only the fixed run/maintenance metadata, bound
execution descriptions, three retained project inventories, the fixed smoke
project and the three production queue mappings. Writes default to disabled.
Enabled writes require executor/definition pins and the private plan store.
The reviewed-source/account preflight remains mandatory before operational use.

DynamoDB writes are exactly one allowlisted run update plus the matching shared
owner condition. Update and condition expressions, table/key, source/executor
pins, revision increment and hashed JSON metadata are checked. Direct row writes,
owner deletion, arbitrary fields and weakened ownership/CAS expressions are
refused. Completion requests only store proof; ASL still owns conditional release.

Native build start accepts only the saved E2E action/source version and its ten
fixed plaintext metadata overrides. There is no role, image, buildspec, arbitrary
environment or project override. Queue updates require the original validated
production mapping and cannot resume an originally disabled consumer. No SSM,
IAM, log, SQL, function-code or execution-control operation is exposed.

CLI requests use private temporary JSON files, fixed region, explicit manual
pagination and an AWS-only environment. Provider failures are sanitized; request
files are removed and calls are not retried.

Validation: 663 Node tests and 19 DynamoDB Local integration tests passed. The
full composed twelve-stage scenario and early abort use this transport's actual
validation/file serialization with real DynamoDB Local transactions; other
provider/model operations are explicit fixtures. No real AWS job, queue update
or production hold mutation was executed. The mutating operator entry point,
worker-quiescence proof and real provider rehearsal remain outstanding.
[Transport evidence](evidence/d1-resource-aws-transport-2026-11-17.json) records
the scope and fixture limits.
