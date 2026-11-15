# SQS consumer admission control

The fixed consumer-control adapter prepares a metadata-only plan for the three VideoQ production mappings or three explicitly named isolated-rehearsal mappings. Production targets are exactly `videoq-worker-prod`, `videoq-worker-search-prod` and `videoq-worker-account-prod`, each paired with its same-name SQS queue in the existing account/region. A mapping replacement, additional mapping, cross-account ARN or unsupported transition fails closed.

Pause changes only an originally enabled mapping's `Enabled` flag. Resume enables only mappings that were enabled in the saved plan. An originally disabled mapping stays disabled. The adapter never purges queues, deletes messages, changes function code/configuration, or changes reserved concurrency. The zero-concurrency shortcut is intentionally absent: asynchronous invocation behavior has separate retention/destination implications ([AWS asynchronous invocation retention](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-retain-records.html)).

Every mutation requires the caller's ownership verifier, checked before individual changes and again afterwards. There is no default mutating authority, no registered production broker operation and no new production IAM grant in this change. Integration must bind that verifier to the durable cutover phase and global owner; an arbitrary caller-supplied no-op verifier is not evidence of production exclusion. Main-reviewed operator code remains the administrative trust boundary.

A failed or lost response never automatically resumes partial state. The same saved plan can inspect/retry completed requests. Intermediate `Disabling`/`Enabling` states are reported without reversing direction; explicit read-back is required for completion. See [AWS mapping states](https://docs.aws.amazon.com/lambda/latest/api/API_GetEventSourceMapping.html).

## Admission is not drain

All mappings being `Disabled` means only that their admission configuration is paused. It does not prove that Lambda invocations, outstanding polls, direct invocations, DB leases or external effects are finished. The production coordinator still needs application pause, deployment suspension, observed in-flight drain, login/row fences, immutable snapshots, reconciliation and a controlled resume. The adapter's result deliberately has no `drained` assertion.

Readonly inspection of the actual three production mappings found all enabled. This inspection changed no production resources and established no active fence. Prepare a fresh plan within the owned operation window; the inspection copy is not an active lease or permission to replay an old plan.


## Verification

Seven state/ownership tests, all 411 Node security tests and 57 infrastructure tests passed. The isolated AWS fixture used three actual Lambda functions, three actual SQS queues/mappings and a temporary role limited to those queues/log groups. It prepared two enabled and one disabled mapping, paused all, retained two synthetic messages after an isolated 40-second quiet period, restored the original states and observed both deliveries in the owned function logs. The 40 seconds is a fixture condition, not a production drain threshold. The fixture's ownership verifier used its isolated operation record; no production coordinator was tested.

A single-read fixture attempt returned an empty SQS response; bounded retrieval and the isolated quiet period were added before the successful run. Both attempts' mappings, functions, queues, log groups and temporary roles were deleted and their absence independently checked. No production mutation, IAM grant or reserved-concurrency change occurred. [Evidence](evidence/cutover-sqs-consumers-2026-11-16.json).
