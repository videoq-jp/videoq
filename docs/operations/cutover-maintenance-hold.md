# Cutover maintenance exclusion

This hold excludes competing AWS database maintenance. It does not stop application writers, drain queues, fence database logins, or authorize a production backend switch. Terraform `enable_cutover_hold` defaults to false; this change does not enable it or apply infrastructure.

The maintenance invoker alone can acquire `cutover-hold` for the current main source SHA. Run and global ownership records have no TTL. The state machine polls only phase and release intent; no database credentials or private recovery plans enter its execution history. The two-hour execution timeout leaves the lock intact.

Before mutations, `release-cutover-hold` records release intent with an ownership/revision transaction. The state machine condition-checks the holding phase and intent in the same transaction that deletes its own global lock. A changed phase or different owner prevents release.

For failed, timed-out, aborted or missing executions, explicit `recover-cutover-hold` first claims recovery without unlocking, then rechecks execution status and active builds. Only an unchanged pre-mutation hold can be recovered; a running execution, active build or unsupported phase retains the lock. Recovery never deletes another execution's lock. No automatic expiry or ordinary maintenance request bypasses this recovery.

DynamoDB transaction actions use ordinary item permissions, with a separate `dynamodb:ConditionCheckItem` grant for the state-machine predicate ([AWS transaction IAM documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html)). The opt-in grant is restricted to run-record keys in the existing table.

Verification uses actual DynamoDB Local with the production broker and transaction parameters, and mocked Step Functions/CodeBuild states. Six cases cover concurrent release, changed phase, active builds, late execution visibility, explicit recovery and unrelated lock ownership. This is not evidence of live production writer fencing. Production inverse recovery, writer drain and final cutover reconciliation remain separate acceptance gates.

## Protected workflow control

`Control D1 Cutover Hold` is dispatched on canonical main in the existing protected `production-db-maintenance` environment. It uses the existing restricted request role and fixed maintenance Lambda; it never retrieves database credentials. `status` is the safe default and requires an existing 32-character run ID. `start` requires an empty run ID and only acquires exclusion; it does not stop application writers. Other choices select fixed consumer/activity/release/recovery operations for the same handle.

The start token is derived from the GitHub workflow run ID, excluding attempt number, so rerunning the same workflow cannot create a second hold. The caller verifies the deterministic AWS handle. A competing hold fails immediately rather than occupying the serial control lane for two hours. Observation failures retain the same handle; they never imply cancellation, recovery or permission to start another hold. Confirmed handles alone enter the step output. `status` reports failed executions without claiming recovery.

The dedicated `production-cutover-control` concurrency group serializes these requests independently of ordinary credential maintenance, whose BUSY polling must not block urgent recovery requests. Deployment/API admission remains the separate trusted local operator. This workflow does not grant SQL, SSM or administrative DB access, enable Terraform features, or complete writer fencing/post-write handoff.

## Live build-inventory pagination correction

The first live hold check on 2026-11-16 rejected acquisition before any run/lock record was created. CloudTrail identified `ListBuildsForProject` returning `InvalidInputException` because a continuation request also supplied `sortOrder`. The broker now uses the API's default descending order on every page and sends only project identity plus the opaque continuation token. It still inspects all returned builds and rejects active or incomplete inventory. IAM was already correct and was not broadened. See the [CodeBuild request contract](https://docs.aws.amazon.com/codebuild/latest/APIReference/API_ListBuildsForProject.html).

Validation includes 469 Node security tests and the real DynamoDB fixture's older-page active-build scenario with the actual API restriction represented in the transport. The failed live attempts are not a successful hold/drain proof; the same corrected main path must be verified before production pause.
