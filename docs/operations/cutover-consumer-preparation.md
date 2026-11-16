# Consumer preparation inside the maintenance hold

`prepare-cutover-consumers --run-id <hold>` is a maintenance-invoker-only control action. It changes an owned, running hold from `holding` to `consumer-preparing` with a revision/ownership transaction. Release is refused in that phase. Step Functions runs the fixed rotation project's `cutover-consumer-prepare` stage, then returns to polling the same hold.

The stage reads only the three fixed production SQS mappings and persists their original enabled states, UUIDs and function/queue identities in the run record. The plan is written once, hashed, read back, and bound to the hold source, execution and producing build. A conditional transaction updates the run record only while the same global owner remains. Lost successful responses reconcile the exact stored plan; repeated requests reuse it rather than replacing the baseline.

The state-machine history projects only phase/release intent. The CLI observes the same run until its `consumer_prepared` flag is true, without treating an already released/recovered hold as successful preparation. A failed read-only stage retains exclusion. Explicit terminal recovery requires no active builds and claims recovery before removing the lock. A parent finishing late cannot overwrite that claim. The record has no TTL.

## Permissions and scope

The existing hold opt-in defaults to false. When enabled, only the rotation project gains `lambda:ListEventSourceMappings` and a read/condition-check of the global lock key. Existing run-record update permissions remain separate. AWS lists this action without resource-level scoping, so its IAM resource is `*`; the fixed stage itself requests and validates only the three expected functions ([AWS service authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_lambda.html)). It gains no mapping update or concurrency authority, reads no DB or Cloudflare credential, and installs no application/database dependencies.

This prepares immutable admission state only. Production consumer pause/resume, durable mutation phases, terminal recovery after mutations, API/deployment suspension, in-flight drain, DB fences and inverse recovery remain part of the unfinished cutover coordinator. Preparing a plan neither pauses the application nor establishes a frozen snapshot. No production preparation, infrastructure apply or feature activation was performed for this change.

## Verification

Actual DynamoDB Local: 12 integration tests cover the existing hold and new preparation phase, blocked release, competing requests, conditional rejection after owner change, lost-response readback, corrupt plan rejection and explicit terminal recovery with active-build refusal. Step Functions/CodeBuild and Lambda responses are test transports in these cases. All 414 security Node tests, 159 Python tests (7 skipped), 57 infrastructure tests and 12 Terraform tests passed. Local Node was 26.12.0 and Python 3.12; CI is responsible for the repository's pinned runtime.

The actual operator ZIP loads the preparation stage without application dependencies. The revised state machine passed AWS's validation API with no diagnostics. Dedicated DynamoDB containers were removed. [Evidence](evidence/cutover-consumer-preparation-2026-11-16.json).
