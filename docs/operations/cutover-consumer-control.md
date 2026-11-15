# Owned consumer pause, resume and failed-step retry

The maintenance hold now has explicit `consumers-pausing`, `consumers-paused` and `consumers-resuming` phases. The maintenance-only actions `pause-cutover-consumers`, `resume-cutover-consumers` and `retry-cutover-consumers` require a separate capability flag and the immutable prepared plan. Other invokers cannot use them. An opaque command ID binds the fixed CodeBuild stage to its current phase, source, plan and global owner.

Pause requires the production API to be explicitly paused. Before the first mapping update, the parent stores a hash-bound receipt of selected public backend bindings. Every update rechecks ownership and API state. Completion requires actual mapping read-back before recording `consumers-paused`; it does not release the hold or claim in-flight drain. Originally disabled mappings remain disabled.

This component provides the **pre-database-mutation abort/retry path**. Resume requires the API to be running, `/ready` to confirm its database connection, and the public backend bindings to match the pause receipt. It therefore refuses an unverified backend change. A verified handoff to a changed database belongs to the later full cutover coordinator; this patch does not fabricate that approval or complete the production inverse-recovery path.

## Failure and retry

Once a consumer operation starts, generic hold release/recovery cannot remove its lock. The `database_mutations_started` marker also refuses consumer-only resume/retry. Normal maintenance cannot clear any held cutover lock, including an inconsistent terminal-success record.

Before any mutation or retry, the broker compares the entire execution-bound state-machine definition with a canonical SHA-256 pin generated into its reviewed ZIP. An old definition or a changed release predicate is rejected before the phase advances; matching state names alone is insufficient.

An explicit retry first proves the same global owner, valid command/plan, no database mutation, a failed/timed-out/aborted and natively redrivable execution, and no active builds. Build inventory follows pagination; repeated tokens or an exhausted bounded scan fail closed. A stable request token uses the native redrive count, so a lost accepted response cannot create a new execution. The action calls `RedriveExecution` on the **same execution ARN**, without changing the failed command or silently resuming consumers. Native eligibility is limited to 14 days and other service constraints; ineligible retries retain exclusion and require the full recovery procedure, not deletion of the lock ([AWS RedriveExecution](https://docs.aws.amazon.com/step-functions/latest/apireference/API_RedriveExecution.html)).

AWS preserves the original state-machine definition/input on redrive. The CodeBuild project's reviewed artifact and ordinary deployment automation must still remain frozen during the operation; redrive is not a cross-service artifact lock. Deployment suspension, API pause, in-flight drain, external-effect reconciliation, database fences, inverse recovery, final data checks and approved changed-backend handoff remain coordinator work.

## Opt-in and credential boundary

`enable_cutover_consumer_control` defaults to false and requires `enable_cutover_hold`. Only the maintenance invoker gets same-machine execution definition inspection and `states:RedriveExecution`. Only the rotation project gets mapping updates, restricted to existing-account mapping ARNs and the three exact worker function ARNs. It gains neither reserved-concurrency changes nor queue/message deletion. [AWS Lambda authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_lambda.html) documents mapping-resource and `lambda:FunctionArn` constraints.

The fixed parent reads SecureString `/videoq/security/prod/cutover-control`, containing the existing account ID and an API token scoped to production Worker settings read. Cloudflare receives only that token; the public readiness request carries no credential. No DB credential is read by these stages, and no application dependencies are installed. Main review remains the administrative trust boundary; this is not a sandbox against privileged operator code.

No production token was provisioned, infrastructure applied, feature enabled, API paused or consumer changed by this implementation work.

## Verification

- Actual DynamoDB Local: 20 tests, with mocked SFN/CodeBuild/Lambda/API transports, including partial pause failure, lock retention, same-ARN retry, unready or replaced backend rejection, DB-mutation marker refusal, lost completion response and an active build on an older page.
- All 417 Node security tests passed with `--test-concurrency=2`; one VM-evaluation test exceeded its existing 100ms bound under default host concurrency, then passed independently and in that complete lower-concurrency run. No test assertion was changed or skipped.
- Python: 160 tests, 7 skipped. Infrastructure: 57 tests. Terraform mock-provider: 15 tests. AWS state-machine definition validation: OK, no diagnostics. Local Node 26.12.0 / Python 3.12.
- Isolated actual AWS Standard Workflow: a callback task was deliberately failed, redriven with the same ARN/input/definition, and completed successfully. Duplicate accepted requests yielded one redrive. Callback credentials stayed in memory and were never written to local files or tool output; AWS retains its managed execution history. The dedicated state machine, Lambda function and two roles were removed and absence checked.

The native retry fixture proves the AWS redrive contract, not a combined production consumer cutover. Actual SQS pause/message retention/resume was separately verified in [the admission adapter evidence](cutover-sqs-consumers.md). [This change's evidence](evidence/cutover-consumer-control-2026-11-16.json).
