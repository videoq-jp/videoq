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
