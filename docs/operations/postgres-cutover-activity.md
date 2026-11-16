# PostgreSQL cutover activity observation

The managed-login fence CLI now accepts `--mode activity --state <private-existing-plan>`. It retains the existing exact host/database/plan checks and connects through the same private credential boundary. The new mode starts a Read Committed, READ ONLY transaction, reads aggregate activity and rolls the transaction back. It does not install/release a fence, alter login admission, acknowledge/delete queue messages, complete jobs or rewrite leases.

The JSON envelope contains `activity`, the target purpose and `upstreamStoppedByThisCommand:false`. `activity` has a server timestamp, database name, integer counts, and explicit `inFlightDrainProven:false`. It includes neither record identifiers, lease tokens, prompts, transcript/content nor credentials. Production administrator credentials must remain inside AWS; this mode does not authorize copying them to an operator machine.

The shared `readPostgresCutoverActivity` helper uses a single read-only statement snapshot and server clock. Repeatable Read and read-write transactions are refused, so a long-lived stale transaction cannot appear to be a fresh empty observation. Missing application tables/columns fail the query; they are not treated as zero. Counts are validated as nonnegative safe integers.

| Observation | Meaning |
|---|---|
| Active job/chat leases | DB execution leases still have time remaining. `assertNoActivePostgresLeases` refuses them. |
| Malformed job/chat leases | Missing or inconsistent lease fields remain blockers. No automatic repair is attempted. |
| Expired leases, started answer attempts | Require reconciliation. Expiry alone never completes a job or resolves external charges/effects. |
| Processing/indexing videos, incomplete transcription/visual runs | Business progress diagnostics; these counts alone do not prove a live process. |

`assertNoActivePostgresLeases` checks the strict report and derived flags, then rejects live/malformed leases. An expired lease can satisfy that narrower check while `requiresReconciliation` remains true. The coordinator must inspect both; passing the helper is **not** permission to import/switch databases.

The complete drain still requires stopped application/deployment/SQS admission, verified AWS builds and invocations, appropriate runtime grace, PostgreSQL login/session fencing, reconciliation of queues/external effects and a final consistent snapshot. Two empty observations, missing metrics or elapsed time alone are not global drain evidence. Direct administrator activity is outside the normal automation trust boundary.

## Owned AWS execution

The maintenance-only requests `inspect-cutover-activity` and `retry-cutover-activity` accept only a run ID. The existing opt-in consumer-control capability is required; it remains disabled by default. There is no SQL, target, buildspec, environment or project override in the public request. The broker checks the exact execution-definition pin, original run/source/global owner, stopped API/deployment/consumer markers and the absence of DB mutation before moving into `activity-auditing`.

The same Standard Workflow starts the fixed rotation project's `cutover-activity-audit` stage. It installs/signature-verifies only the locked operator tools. The parent rechecks actual paused mapping states, the original public API backend receipt and real pre-auth/readiness pause responses, then reads the existing administrator parameter inside AWS. The prepare/activity children receive only the explicit DB URL, read-only PGOPTIONS and minimal process environment. AWS/OIDC/Cloudflare credentials and other PG/Node overrides are not forwarded.

The parent validates the exact source target, strict aggregate report and derived flags, then rechecks admission before atomically recording the report/hash, preparation plan/hash, build and command ID under the same global owner. It returns to `consumers-paused`. Public status exposes only `activity_observed`, not the private report or role plan. That flag means an observation was recorded; an active-lease count can still be nonzero. This step installs no writer fence and makes no readiness decision.

A completion response lost in transit is reconciled by exact readback. Replaying the same completed stage reuses its timestamped observation without claiming a fresh DB read. A new inspection request after completion allocates a new command and replaces the latest observation only after its conditional completion. Old commands cannot overwrite that result. A failed stage retains exclusion; explicit retry redrives the same execution/command after terminal/build checks. It does not start another maintenance run or automatically restore traffic. Native retry eligibility limits still apply; full recovery beyond that path remains a separate gate.

The observation-time fence preparation is not a replacement for an immutable original-state record when installing a writer fence. Final mutation/recovery stages must bind that separate intent before changing role state. API/deployment restoration, DB fences, final snapshots, Lambda/build drain and external-effect reconciliation remain required. The new stage and fixed metadata controls are in the operator/broker bundles and CI/CD selectors. This connected held stage remains unactivated. The separate production readonly fence-plan audit described below was executed through the reviewed main workflow; it installed no fence.

## Verification on 2026-11-16 JST

The actual application schema was generated into disposable PostgreSQL/pgvector, not simplified in-memory tables. All 9 tests in the managed-login/activity integration file passed, including the 3 new activity cases: fresh/read-only isolation, live/expired/malformed leases, unfinished answer/media records, unchanged row fingerprints, strict derived flags and private-plan CLI behavior. The existing actual D1/fenced recovery regression remained green. The final integration run used Node 26.12.0 and a digest-pinned PostgreSQL image.

A separate actual operator-ZIP fixture used only the minimal operator dependencies and real loopback PostgreSQL. The packaged activity command detected a synthetic live job lease, exposed no job ID/password and preserved role login flags. Existing-plan overwrite refusal and read-only enforcement still passed. The fixture uses a minimal query-shaped schema; the application-schema test above supplies full schema compatibility evidence.

All 442 Node security tests, 4 AWS parent isolation tests and 57 infrastructure tests passed. Both API typecheck configurations and targeted lint passed. The final bundle was generated from a clean committed tree. Dedicated containers/volumes and the test credential copy were removed. [Evidence](evidence/postgres-cutover-activity-2026-11-16.json).

## Owned-stage verification

The connected path passed 35 actual DynamoDB Local tests, with SFN/CodeBuild/Lambda/Cloudflare/DB-child transports mocked. Cases include nonzero active work, stopped-admission drift before child execution, stripped child credentials, lost completion readback, stale command rejection, contradictory child flags, and same-execution retry after failure. All 445 Node security tests, 4 existing AWS parent tests, 10 request-client tests and 57 infra tests passed. Both API typecheck configurations/lint and the 9 real PG integrations still pass. AWS definition validation returned OK without diagnostics. A clean ZIP loads the new parent with only operator dependencies and its broker definition pin matches the packaged state machine. This does not claim an actual combined AWS/production drain rehearsal. [Owned-stage evidence](evidence/postgres-held-activity-2026-11-16.json).

## Native completion boundary

Publishing a result in DynamoDB does not prove the parent CodeBuild task has completed. Each producer now records its exact latest build. Status readiness flags and subsequent phase changes wait for the same execution's native `TaskSucceeded` event for `codebuild:startBuild.sync`, with matching successful build ARN/ID. Missing, truncated, malformed or bounded-out history fails closed. A redriven committed operation binds the new build while preserving its original plan/report. Request clients retry the same action while that native completion is pending.

The final local checks passed 448 Node tests, 38 DynamoDB Local integration tests and 17 Terraform mock plans. The latter preserve the existing archive in their test configuration; no infrastructure apply occurred. History permissions are limited to the maintenance broker/fixed rotation job and the production maintenance execution prefix, behind existing opt-ins. [Evidence](evidence/postgres-held-activity-2026-11-16.json).

## Production readonly audit

[Main workflow 43779197615](https://github.com/videoq-jp/videoq/actions/runs/43779197615) successfully ran the fixed `postgres-login-fence` inspection inside AWS. Its private plan target/hash were verified: 28 managed roles, 7 originally accepting login. All 51 deployed operator files matched reviewed commit `eb8c43f32aec9333ca77904dd2817b42d5f46511`. The native completion helper also recognized the actual successful CodeBuild event in this execution. The application remained ready afterward. This proves the separate readonly production audit, not the combined held-stage/drain procedure. It changed no login flags, paused no application traffic and switched no database. [Sanitized evidence](evidence/production-postgres-fence-audit-2026-11-16.json).
