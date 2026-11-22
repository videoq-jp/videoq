# Canonical AWS migration routing

The existing `migration` operation retains its fixed CodeBuild project, canonical source download and global maintenance lock. The immutable operator now selects PostgreSQL or D1 from `apps/api/wrangler.jsonc` in that exact source. Missing edition retains the current PostgreSQL path. Invalid or incomplete D1 configuration fails; it never falls back to a PostgreSQL migration.

PostgreSQL continues through the existing Neon credential wrapper and migration script. D1 uses the separately locked deployment-tools Wrangler to apply `DB` migrations from the production environment's `drizzle-d1` directory. Before D1 execution the parent verifies the AWS build context, run/global ownership and requested source, requires the stopped-writer acknowledgement, reads the fixed D1 credential, and verifies the production API is explicitly paused. The selected database/index state must preserve any already-active D1 target. Ownership and pause are rechecked after migration. The command never resumes application traffic.

The D1 child receives only allowed host environment fields and Cloudflare credentials; AWS/OIDC, inherited Node options and PostgreSQL settings are not passed. Captured child output and credential values are not logged. This is credential/environment separation, not a filesystem sandbox against malicious reviewed operator code. Main review remains the administrative trust boundary.

## Opt-in and credentials

Terraform `enable_d1_migrations` defaults to false. Opt-in grants only the fixed migration project's read of SecureString `/videoq/security/prod/d1-migration` and read-only access to its existing run/global lock records. Other projects cannot read that parameter. The JSON contains `CLOUDFLARE_ACCOUNT_ID` for the existing VideoQ account and `CLOUDFLARE_API_TOKEN`, scoped to D1 migration and production Worker settings read. Provision and verify that token in the controlled operation window before selecting D1; never put its value into a PR or command argument.

This implementation does not provision a credential, apply Terraform, pause production, or run production migrations. The shared stop acknowledgement is not proof of drain. The cutover still needs deployment suspension, completed in-flight drain, reconciled external effects, final backup/import/verification and controlled resume. D1 row-fence triggers may intentionally reject data-changing migrations; do not silently remove them or bypass their recovery procedure.

A D1 migration failure keeps the application paused and fails the existing state-machine execution. Do not treat a failed execution or partially applied migration history as permission to resume. Inspect the fixed migration history and complete/recover the operation while preserving writer exclusion.

## Cloudflare background workers

When queue/Workflow bindings are present (even while job routing is still `sqs`),
schema-changing migrations also verify the fixed production account/search queues
and search Workflow before and after the Wrangler child. Both queue consumers must
belong to `videoq-api`, retain their expected DLQs, and have delivery paused. The
queue's last modification must be at least 16 minutes old: the documented
[consumer wall-time limit](https://developers.cloudflare.com/queues/platform/limits/)
is 15 minutes, with one additional minute allowed before observing Workflows.
All search Workflow instances must be paused or terminal; `waitingForPause`,
sleeping, queued and rollback executions are not stopped. Unknown states and read
failures refuse the migration. These checks do not pause or resume resources.

The migration token additionally needs read access to Queues and Workflow execution
metadata. Its transport permits only fixed queue metadata and the fixed Workflow
instance listing; it cannot retrieve instance parameters/output or write resources.
Provision those read permissions through the existing controlled credential process
before binding deployment. Ordinary code-only CD with an exact migration ledger
continues to perform no schema write and does not require a forced background pause.

Operators must keep deployment automation and other control-plane writers excluded
throughout the maintenance window. A timestamp/read check is evidence under that
exclusion, not a substitute for it. The recoverable pause/restore components still
need a durable owned operator execution path before production transport cutover.


## Verification

Six parent/selection tests, all 404 Node security tests, 57 infrastructure tests and 10 Terraform mock-provider tests passed. A real allowlisted operator ZIP with no application dependencies applied all 20 SQL migrations to a dedicated remote D1 using separately locked Wrangler 4.151.3; a second execution found no pending migrations. Remote migration-history equality, zero foreign-key errors and empty users/videos were checked. That fixture mocked AWS metadata and Worker settings, so it does not prove live AWS IAM or production pause/drain. The dedicated D1 was deleted and absence verified. No Vectorize index or Worker was created or modified. [Evidence](evidence/d1-aws-migrations-2026-11-16.json).

D1 SQL, D1 Drizzle configuration and production Wrangler selection changes trigger the same coordinated migration-before-API/worker deployment graph. Deploy and verify this operator bundle before merging the eventual production D1 selection.
