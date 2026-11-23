# Production maintenance coordinator

Status: implementation prepared; production cutover and AWS retirement have not
been performed. The committed Worker configuration rejects operation requests
until `MAINTENANCE_ENABLED=true`. A separately authorized read-only status route
works while admission is disabled; it never acquires or clears ownership. An absent repository variable keeps both existing
GitHub workflows on their AWS execution paths.

The replacement runs D1 migration checks and the existing guarded production
smoke on GitHub-hosted runners. A separate Cloudflare Worker authenticates GitHub
OIDC tokens and stores the database's single owner and immutable recovery plans
in a SQLite Durable Object. It has no D1, R2, AWS or application-secret binding.
The runner receives only its environment's purpose-specific credentials, after
public dependency installation and signature verification.

## Ownership and recovery

Only this repository's main-branch `cd.yml` migration job and `operations.yml`
smoke job, plus the fixed read-only `database-migrate.yml` verification job,
in their respective production environments, may acquire ownership.
The Worker verifies GitHub's signature, repository numeric IDs, environment,
workflow, source SHA, hosted runner and live run attempt. New ownership also
requires current main and successful push CI. An existing owner may recover its
original source after main advances; it still requires live GitHub identity and
successful original push CI.

The owner has no expiry. A canceled runner or failed request cannot free it.
Queue/workflow plans persist before changes; conflicting rewrites are refused.
A retry uses the same workflow run ID with a newer attempt. Use **Re-run failed
jobs** on that run, preserving its validated source. An entirely new workflow run
cannot take another run's lock. Never delete the Durable Object or its owner row
as a recovery procedure. If the original source cannot be rerun, stop and prepare
a separately reviewed recovery procedure with the saved plans.

Completion requires the canonical runner's operation receipt: successful smoke
with synthetic cleanup, read-only migration verification, or a migration with
background restoration. Release follows completion and is idempotent. A schema
failure keeps the API paused and the owner held. This coordinator does not reopen
application traffic.

## Verification without production changes

```sh
node --test .github/scripts/cloudflare-maintenance.test.cjs .github/scripts/github-maintenance.test.cjs
npm ci --ignore-scripts --prefix .github/deploy-tools
npm run audit:signatures -- --prefix .github/deploy-tools
node .github/scripts/cloudflare-maintenance.native.mjs
```

Use the committed Node/npm versions. The native fixture runs the actual Worker,
SQLite Durable Object and signature verification inside workerd with synthetic
GitHub metadata; it proves persistence after eviction, exclusion, failed-attempt
recovery, immutable plans and idempotent release. It does not prove production
GitHub OIDC claims or production token permissions.

## Live identity and ownership inspection

Dispatch **Inspect Cloudflare Maintenance** on current main after successful push
CI. It runs in both protected purpose environments using only GitHub OIDC and a
read-only GitHub token. It installs no packages and receives no Cloudflare or
synthetic-identity credentials. Its signed workflow identity is accepted only by
`/v1/status/migration` and `/v1/status/smoke`, including while operation admission
is disabled. The same identity is rejected by the operation endpoints. A missing
or malformed owner response is an error, never evidence of idleness.

The report identifies any held owner by GitHub run, source and attempt. Inspection
does not alter a running or failed owner. A successful empty report is a snapshot;
recheck just before a controlled change and continue monitoring new operations.

## Controlled read-only recovery rehearsal

**Verify Production Migration Ledger** has no writer-stop input and never receives
background-control credentials. Its ordinary path verifies that the live D1
migration ledger exactly matches the reviewed source; pending migrations fail
closed without applying schema.

For the reviewed live recovery rehearsal, dispatch with `exercise_recovery=true`.
The first attempt deliberately omits runtime credentials: after genuine OIDC
admission it fails before any database request and retains the failed owner.
Inspect that owner, then use **Re-run failed jobs** on the same run. The later
attempt uses the migration environment's credential, verifies the ledger, records
its read-only receipt and releases ownership. Confirm the owner is empty again.
This tests actual GitHub attempt recovery without inducing a schema failure or
changing customer data. A new run is not a recovery mechanism.

## Disabled bootstrap verification

On 2026-11-24 JST, [deployment 45211143404](https://github.com/videoq-jp/videoq/actions/runs/45211143404)
completed from main `996c40b0a7e60ab1da1f9620c4725e311dcf21e9`, after successful
push CI. PR #1627 repaired artifact output paths; the deployed Worker and its
configuration remained identical to approved PR #1625.

Readback confirmed one Worker and one SQLite Durable Object namespace, only the
maintenance binding and disabled flag, `/health` returning
`{"status":"ok","enabled":false}`, and operation requests returning
`503 MAINTENANCE_DISABLED`. The five existing Lambda revisions/code hashes and
three maintenance CodeBuild configurations matched the predeployment snapshot.
The two temporarily paused CD workflows were restored to active. No runtime
credential transfer, maintenance activation or AWS retirement occurred in this
bootstrap. Status and recovery support below remains a separate deployment.

## Controlled deployment and cutover

1. Use the existing `production-infra` environment's `CLOUDFLARE_API_TOKEN`
   Worker deployment credential. The separate Hyperdrive/R2 infrastructure token
   is not a Worker deployment credential; do not broaden it implicitly.
   Merge reviewed source with successful push CI. Dispatch **Deploy Cloudflare
   Maintenance** on current main. It builds without production credentials,
   requires `production-infra` approval, revalidates current main, and uploads
   only this run's prebuilt artifact. With the repository switch absent/false,
   this creates a disabled coordinator; existing AWS execution continues.
2. Deploy the reviewed status/verification support with admission still disabled.
   Prove live GitHub OIDC in both purpose environments and verify empty ownership.
   Review the trust-boundary change before supplying credentials: approved main
   runners now receive maintenance credentials, replacing the previous AWS-only
   execution boundary. Keep `production-db-migration` and `production-db-smoke`
   main-only, with their existing protection rules. Provision environment-scoped
   `CLOUDFLARE_MAINTENANCE_TOKEN` from each purpose's existing credential. Only the
   migration environment also receives `CLOUDFLARE_BACKGROUND_TOKEN`; only smoke
   receives `SMOKE_IDENTITY_KEY`. Do not place credentials in repository variables,
   the Worker, command arguments, artifacts or logs.
3. During an idle, reviewed window, verify no running/queued CodeBuild project,
   Step Functions execution, active DynamoDB owner, application deployment or
   maintenance operation. Record and temporarily suspend the CD, Operations and DB Maintenance CD
   workflow admission states before changing the switch. Disable all three AWS starter Lambdas and verify the actual setting;
   ensure existing aliases/invocation paths cannot start work. Recheck idle state.
   Allow existing starter invocations to finish after throttling, then recheck
   CodeBuild, Step Functions and ownership. Do not rely only on GitHub concurrency:
   it cannot serialize two coordinators.
4. Activate the Worker and repository `CLOUDFLARE_MAINTENANCE_ENABLED=true` in a
   controlled sequence with admissions held. The switch selects the new migration
   and smoke paths and suppresses the obsolete AWS code-deployment job. Never
   enable it while old AWS admission is available.
5. With the old AWS path quiesced, prove live read-only migration and the
   controlled same-run failure/recovery rehearsal above. Restore only the app CD
   and Operations admission states needed for normal work and guarded production
   smoke. Keep obsolete AWS code deployment disabled. Prove smoke cleanup before
   retiring AWS.
   Native fixture success alone is insufficient. Rollback requires both owners
   idle and AWS resources still intact; changing the flag cannot clear a lock.
6. Prepare a fresh Terraform retirement plan only after these checks pass.
   Preserve historical recovery/audit records and inspect executable bundle
   versions separately. Apply through the existing infrastructure approval gate;
   verify absence with successful inventory reads, not authorization errors.

## AWS resources retained until replacement is proven

Retirement candidates are the three maintenance CodeBuild projects, three starter
Lambdas/aliases, maintenance Step Functions, DynamoDB ownership table and private
executable-bundle bucket, plus their exclusive roles/policies. The three separate GitHub invocation
roles each have one Lambda-invoke-only inline policy and no attached policies in
the observed inventory; verify those exact boundaries again before retiring them.
The current retained-only Terraform candidate has 31 deletions and no additions
or updates; it is not an apply authorization. Preserve DynamoDB recovery records before deleting the table. Inventory every
version of the executable-bundle bucket and refuse unknown keys; only reviewed
`operator.zip` and `broker.zip` code artifacts may be purged. Historical logs
may remain for audit retention. Resource counts must come from a fresh plan.

Keep the media Lambda, media SQS/DLQ, active ECR images, media SSM credentials,
Terraform state S3 and any attached media IAM boundary. The private database
archive bucket contains **13 versions** in the production inventory taken on
2026-11-23; preserve them. Its data is not disposable build output. A separate
search-evaluation Lambda is disabled but is not part of this retirement scope.
