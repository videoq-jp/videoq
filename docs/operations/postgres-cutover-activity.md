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

## Integration scope

The activity helper is in the explicit operator allowlist and both runtime-fixture CI and canonical maintenance-deployment selectors. The existing AWS audit action still prepares its login-fence plan; this patch does not add a public arbitrary command, new IAM grant, scheduled activity query or automatic production caller. The full cutover coordinator must invoke this mode under its owned hold and preserve the observation/reconciliation evidence. No production DB activity query or fence mutation was performed for this implementation.

## Verification on 2026-11-16 JST

The actual application schema was generated into disposable PostgreSQL/pgvector, not simplified in-memory tables. All 9 tests in the managed-login/activity integration file passed, including the 3 new activity cases: fresh/read-only isolation, live/expired/malformed leases, unfinished answer/media records, unchanged row fingerprints, strict derived flags and private-plan CLI behavior. The existing actual D1/fenced recovery regression remained green. The final integration run used Node 26.12.0 and a digest-pinned PostgreSQL image.

A separate actual operator-ZIP fixture used only the minimal operator dependencies and real loopback PostgreSQL. The packaged activity command detected a synthetic live job lease, exposed no job ID/password and preserved role login flags. Existing-plan overwrite refusal and read-only enforcement still passed. The fixture uses a minimal query-shaped schema; the application-schema test above supplies full schema compatibility evidence.

All 442 Node security tests, 4 AWS parent isolation tests and 57 infrastructure tests passed. Both API typecheck configurations and targeted lint passed. The final bundle was generated from a clean committed tree. Dedicated containers/volumes and the test credential copy were removed. [Evidence](evidence/postgres-cutover-activity-2026-11-16.json).
