# Application traffic pause for database cutover

`MIGRATION_TRAFFIC_STATE` is an operator-only setting shared by the cloud and Node API. Unset or `running` preserves normal dispatch. Every other value, including an empty string or a typo, pauses new work. No HTTP request can change this setting. This change does not configure or enable a production pause.

While paused, application requests return 503 with `MIGRATION_PAUSED`, `Retry-After: 60` and `Cache-Control: no-store` before authentication or business route dispatch. This includes GET requests that can refresh sessions or complete OAuth, internal Worker operations, billing webhooks, tRPC, media and readiness. GET/HEAD `/health` remains available for process liveness. CORS preflight can still complete without business work. `/ready` returns 503 without opening the database.

The edge chat dispatcher and chat Durable Object also reject new work. Retention cron and recovery sweeps skip business operations. The task-scheduler alarm and reschedule paths preserve an alarm for a later wakeup without querying or mutating the business database while paused. Durable Object scheduling storage is still used to retain that wakeup. The Node configuration explicitly passes the same setting.

## Cutover boundary

This is admission control, not a drain receipt or a database fence. A deployment/configuration update does not prove that invocations using an older environment have finished. Maintain the AWS exclusion hold, stop SQS consumers/direct PostgreSQL writers, verify the deployed API and Durable Object environment and wait for in-flight requests, streams, external tasks and leases to settle. Retain the database login/row fences for the snapshot and inverse recovery. Do not infer a frozen snapshot from `/ready` returning 503 alone.

Already issued object-storage upload URLs and previously submitted external operations are not revoked by the API pause. Reconcile those object/queue/billing effects before the final snapshot and before reopening traffic. A paused webhook is rejected for retry rather than acknowledged without processing. The release sequence must verify the selected backend and restored scheduler wakeup before traffic resumes.

## Verification

Local Node 24.12.0: four files / 48 tests verify paused route behavior without supplying a database, fail-closed configuration, unchanged normal dispatch, skipped maintenance side effects and Node propagation. Actual local Workers runtime: three files / 10 tests cover scheduler persistence, paused wakeup, paused chat dispatch and existing Durable Object behavior. These tests do not demonstrate a production drain, a live config change, AWS consumer suspension, or a complete production cutover.
