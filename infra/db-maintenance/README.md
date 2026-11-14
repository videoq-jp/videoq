# AWS database maintenance

Cloudflare Workers → Hyperdrive → Neon stays unchanged, including the Neon Free
plan. Database rotation, migration, backup/restore and production smoke run in AWS.
GitHub Actions invokes a fixed Lambda alias and observes execution status; its
routine request roles have no SSM, CodeBuild-start, code-upload or IAM permissions.
The restricted demo audit/preparation readers remain separate GitHub jobs.

EventBridge Scheduler starts daily age checks. Step Functions Standard orchestrates
purpose-specific CodeBuild jobs and waits without keeping a build running during
the 16-minute Lambda invocation grace period. Only the rotation project may read
the DB administrator and Hyperdrive update credentials. Migration, backup, smoke
and audit projects read only their exact purpose parameter. Step Functions input,
output and history contain operation metadata, never DB URLs or API tokens.

The public starters reject commands, environment/buildspec/role overrides, project
names and source URLs. Each starter alias permits only its configured operations.
They serialize operations with a DynamoDB record that never expires by time.
Failed rotations block migration until rotation recovery succeeds. Recovery checks
the real execution and build statuses; an observation timeout does not authorize
stealing a lock or restarting an active operation. Client tokens make retries of a
lost start response idempotent.

## Source and deployment authority

`DB Maintenance CD` runs after successful push CI for current canonical main.
It compares from the last successful CD, including changes missed by a failed or
superseded run. A dedicated main-only `production-db-deploy` OIDC role invokes
only `videoq-db-start-deploy-prod:live`; it has no code-upload, SSM or IAM grants.
The starter independently checks repository identity and current main, and uses
the same global lock as migrations and credential rotation.

Inside AWS, `videoq-db-deploy-prod` fetches that exact public commit, installs
locked runtime dependencies without install scripts, verifies registry signatures,
and builds the allowlisted bundles. It uploads versioned S3 artifacts, publishes
and tests five immutable Lambda candidates, then updates the five job source
versions, state-machine definition and live aliases. A promotion failure restores
previous references where possible. Deployment failure blocks DB jobs until a
successful deployment recovery; the subsequent production smoke must also pass.
Never remove that lock solely because time has passed.

The deployment builder cannot read SSM/Secrets Manager, decrypt KMS secrets or edit
IAM. It may update only these maintenance functions, five existing DB jobs and this
state machine; it cannot change its own CodeBuild project or role. **Approved code
still carries administrative authority:** modifying code later executed with DB
privileges can use those privileges. Main review and repository protection remain
part of the trust boundary. This is automated code deployment, not protection from
malicious approved code or compromised dependencies.

IAM, runtime configuration, new AWS resources, schedule settings and the independent
Terraform state remain operator-managed. Terraform ignores CD-owned Lambda code,
alias versions, job source versions/source tags and the state-machine definition
so a routine infrastructure apply cannot roll back a later code release. Existing
application GitHub roles still cannot write this independent state.

`build_bundle.py` packages an explicit public-code allowlist, the locked SDK
dependencies, and fixed operations fixtures. It refuses an uncommitted tree for
deployment. The `--allow-dirty` switch is for local packaging validation only.
Credential reads happen at runtime inside AWS. SQL/subprocess errors are captured
and only sanitized failure identifiers reach CloudWatch. GitHub masking commands
must never be emitted into CloudWatch, which does not interpret them as redaction.

## Verified backup preservation for D1 migration

By default the restore test deletes its temporary dump and does **not** preserve
a backup. The source includes an opt-in `retain_verified_backups` Terraform
setting (default `false`). This code has not by itself enabled production
retention. Enable it only after the reviewed canonical-main operator containing
`backup-archive.mjs` is deployed; the bucket, IAM and project environment are
operator-managed infrastructure changes, not part of maintenance CD.

When enabled, the backup job retains the exact dump only after isolated restore,
table-count and constraint verification. It covers `public`, `drizzle`,
`videoq_security` and `chat_memory`, including retired public tables that the
D1 importer currently refuses to ignore. A separate private, versioned SSE-S3
bucket (`videoq-db-archives-prod-257240362763`) receives
`verified/<maintenance-run-id>/database.dump` and then `verified-backup.json`.
The private manifest records the immutable operator source version, build ARN,
schemas, table counts, dump checksum/size/version and pinned restore image.
Only a manifest whose upload/readback succeeded is a completed retention result.
The credential wrapper continues to remove **all** AWS credentials and metadata
credential endpoints from the DB child. That child stages the verified dump and
a checksum/size/run-bound marker in a fresh 0700 directory owned by the parent.
It never calls S3. Only after the child exits successfully does the AWS parent
validate that handoff and perform the uploads. A child report marked `staged`
is not durable preservation; the parent must record `retained`. Upload failure
marks the operation `failed`, and the parent removes its private handoff files
on both success and failure. Synthetic CI tests exercise a real PostgreSQL
dump/restore and the complete handoff using a fake S3 protocol; they do not
establish production AWS storage or recovery success.
A failed manifest write may leave a private orphan dump; do not treat it as a
completed preservation copy or restart a live maintenance execution.

Uploads require conditional creation, explicit encryption and SHA-256. Versioned
HEAD readback must match checksum, bytes and encryption before success. The
backup role receives only PutObject and GetObjectVersion on `verified/*`; other
jobs and routine GitHub roles receive no archive grants. The bucket has no
automatic expiration, and Terraform prevents its destruction. Retention therefore
incurs ongoing storage cost; an operator must set a preservation/deletion policy
before enabling recurring backup runs. This is versioned storage, not Object Lock.
The current single-PUT implementation rejects dumps larger than 5 GiB.

Recovery/download requires a separately reviewed operator session with narrowly
scoped version-read access. Never add DB credentials or source records to public
artifacts, logs or the executable-bundle bucket. Restore a selected manifest and
its exact dump version into an isolated database, verify its SHA-256 and inventory,
and repeat application/auth checks before considering recovery. The dump omits
roles, ownership and grants, and does not restore R2, Vectorize or Neon PITR.
It is not a D1 import archive and does not resolve which legacy records should
become active D1 data. Production retention and recovery remain unproven until
the protected AWS job and an archive retrieval/restore rehearsal succeed.

The protocol follows the AWS references for [conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html),
[PutObject checksums and encryption](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)
and [CodeBuild source versions](https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-env-vars.html).

## Version-pinned private backup download

`.github/scripts/backup-download.mjs` retrieves a selected completed backup into a
new private directory. Supply the exact maintenance run ID and the completion
manifest's S3 VersionId, obtained through a separately reviewed operator inventory
for that run. The tool does not discover/list versions, select latest, assume a
role, fetch SSM parameters or broaden IAM. Use an approved operator session with
`s3:GetObjectVersion` on the required `verified/<run-id>/*` objects; routine GitHub
invocation roles still have no archive read grants. No DB credential is needed.

```sh
node .github/scripts/backup-download.mjs \
  --run-id <exact-maintenance-run-id> \
  --manifest-version <exact-S3-VersionId> \
  --output-dir /private/rehearsal/new-download \
  --require-d1
```

The bucket, owner and region are fixed. Every HEAD and GET specifies a version and
requests its checksum; HEAD checks encryption, version, size and checksum before
any body download. Referenced object keys must belong to that same run and use the
fixed dump/archive names. Local descriptor-based SHA-256 and byte counts must then
match both the manifest and S3 response. Credentials for DBs, PG settings and OIDC
are not forwarded to the AWS CLI; configured endpoint overrides are ignored.

The output directory must not exist; exclusive creation preserves existing files.
It is 0700 and downloaded files are precreated as 0600. Success writes a private
`download-verified.json` receipt; failure removes only the directory created by
that attempt, including previously downloaded partial files. No receipt, object
version or record content is printed. Version-1 dump-only manifests are supported
without `--require-d1`; requesting D1 refuses them instead of falling back.

Download verification proves transport integrity, not the D1 format, source data
provenance outside the selected trusted manifest, or cutover readiness. The local
receipt leaves `d1_archive_format_verified=false` and `execution_complete=false`.
Run the existing migration archive verifier against the intended reviewed mapping
before import, and independently restore the exact downloaded dump and compare its
inventory. Do not execute unreviewed repository code/dependencies against private
archives. R2/Vectorize state, credentials/grants, production auth, search quality
and performance require their separate checks.

The synthetic operator-ZIP fixture now transfers the actual generated dump,
manifest and D1 archive through fake versioned S3, downloads them using this tool,
verifies the retrieved archive against the packaged mapping, and restores the
retrieved dump into another PostgreSQL database with 58 tables/four rows checked.
This closes the local preservation/retrieval/recovery loop; actual AWS read
permissions, real storage and production recovery remain unproven.
The version-read/checksum behavior follows the [AWS GetObject reference](https://docs.aws.amazon.com/cli/latest/reference/s3api/get-object.html).

## Provision and cut over

1. Review/commit the code and install the runtime lockfile:

   ```sh
   npm ci --ignore-scripts --prefix infra/db-maintenance/runtime
   npm audit signatures --prefix infra/db-maintenance/runtime
   python3 infra/db-maintenance/build_bundle.py
   ```

2. With an operator AWS session, apply the narrowed `videoq-tfstate-access`
   and `videoq-terraform-deploy` managed policies before creating the independent state. Confirm the GitHub
   deployment role cannot write `videoq/prod/db-maintenance.tfstate` or its lock.
   Initialize `infra/db-maintenance/terraform` with the existing state bucket.
   Plan using `../dist/terraform.tfvars.json`, review the saved plan, and apply it.
   The new AWS schedule is disabled initially. No NAT gateway, VPC endpoint or
   Neon plan upgrade is created. Install the emitted worker permissions boundary
   on `videoq-worker-prod` with the operator session. It caps SSM to worker/app,
   SQS to the media/search/account queues, logs to those three function groups,
   and the current constrained federation
   token operation. GitHub cannot remove that boundary, edit its policy, or
   delete/recreate the worker role to bypass it. The application Terraform root
   deliberately leaves this operator-owned boundary unchanged.

3. Verify actual AWS audit, canonical-main migration, smoke and backup executions.
   Run `python3 infra/scripts/setup_neon_access.py` to provision the **new** request
   roles and `AWS_GITHUB_ACTIONS_DB_REQUEST_ROLE_ARN` Environment secrets. The old
   readers remain available until the main workflow cutover; no permission union
   is added to the new roles.

4. Merge the workflow changes, verify successful main CD and operations runs, then
   remove the old migration/backup/smoke SSM reader roles and the old GitHub
   rotation role, including their previous Environment ARN secrets. Preserve the
   dedicated demo/audit readers and the reviewer-protected initial Cloudflare
   credential handoff.

5. Force one controlled AWS rotation, verify both production smoke runs,
   backup/restore, audit, old-login rejection, and the completed encrypted journal.
   Verify a second non-forced run skips fresh credentials. Enable the AWS schedule
   with `schedule_enabled=true` only after these checks. Confirm GitHub's previous
   daily rotation schedule is absent and all old credential-reading grants are
   denied. Save the reviewed bundle manifest and execution IDs with the rollout.

## CodeBuild preparation costs

`runtime/setup-job.cjs` installs locked dependencies and verifies registry
signatures for stages that use them. Rotation age checks and completion records
need only built-in modules and the AWS CLI; migrations install their own tools
from canonical main. Smoke jobs install only Chromium Headless Shell, matching
their channel-free `chromium.launch()` call. Rotation preparation installs tools
only when credentials are due, before writing recovery material; resumed
promotion and rollback also install and verify tools before DB mutations.
Production verification, rotation
grace periods and purpose-specific permissions remain intact.

The managed standard:7.0 image already includes Chromium's required shared
libraries. Smoke setup installs Japanese fonts only when no Japanese-capable
font is present, rather than running Playwright's general OS dependency install
and pulling unrelated language fonts on every run. An image change that removes
browser libraries will fail browser verification rather than skip it.

When adopting this setup on an existing installation, first deploy the reviewed
operator bundle through maintenance CD, which includes `setup-job.cjs`. Then
apply the reviewed maintenance Terraform plan to switch the install command.
Do not switch the command while projects still reference an older bundle without
the script. Subsequent script changes use the usual versioned maintenance CD.

CloudWatch's `DOWNLOAD_SOURCE` duration includes managed runtime activation.
The standard:7.0 image already stores Node 26 and npm in
`/usr/local/n/versions/node/$NODE_26_VERSION`. Buildspecs select Python only and
prepend that Node directory to PATH instead of running `n`, which copies the
entire runtime on every job. Missing binaries or a different Node major fail the
build before setup or DB access. Apply this buildspec change to the deployment
builder as well as the five database jobs. No custom image or writable cache is
needed. The AWS-managed image can change its bundled Node patch version, just as
with the previous `nodejs:26` selection.

Application CD triggers smoke only when an API, web, worker or migration job
actually ran; docs-only and no-op CDs do not repeat it. Unknown CD job layouts
retain the check. Daily, manual, maintenance deployment and rotation verification
remain enabled. The migration paths filter explicitly names its request scripts
and authentication action so unrelated operations scripts do not start it.
Maintenance CD similarly selects operator code and runtime assets, not Terraform
plans, infrastructure tests or documentation-only changes.
Application deployment filters name their actual deployment scripts/actions as
well; changing DB maintenance or its tests does not rebuild and redeploy an
unchanged application or video-processing Lambda image.

Compare complete build phases and billed minutes before and after rollout;
startup, dependency installation and the actual production checks still cost
time, and CodeBuild rounds each build separately.

## Recovery

Manual operations remain available through `Maintain Neon Credentials`. It sends
only `audit`, `rotate`, or `rollback` to the maintenance starter. Rotation resumes
the encrypted SSM journal; rollback restores consumers, verifies production,
waits out old invocations, retires abandoned candidates, and verifies again.
Recovery secrets leave the current journal only after the final smoke succeeds.

If a start fails between lock creation and StartExecution, the broker recovers
the stored execution name/input only after AWS confirms that execution is absent.
Never delete the lock just because time has passed. Aborted/failed executions must
have no active child build before recovery. An operator must investigate inconsistent
state; main migrations intentionally fail closed behind an unfinished rotation.

The break-glass administrator password remains manually managed in SSM. The
Cloudflare maintenance token must still be renewed through its reviewed handoff.
AWS service compromise, operator compromise and malicious approved code remain
risks; this design removes direct credential access from routine GitHub jobs.

## Enable maintenance CD on an existing installation

With an operator session, confirm there is no running maintenance execution/build,
apply the new deployment resources with `schedule_enabled` preserving its current
value, and build a clean committed bundle. For the one-time ownership handoff,
publish the reviewed broker ZIP, test its immutable candidates and promote all
five starter aliases, then install the validated extended state-machine definition.
Keep existing DB job source versions unchanged during this bootstrap. The first
automatic CD promotes those job artifacts under the shared lock. Existing
operations remain compatible with the extended starters and state machine.
Do not provision the GitHub deploy invoker before this handoff succeeds.

Provision `production-db-deploy` as main-only and install the invocation-only role
using `infra/scripts/setup_neon_access.py`. Merge the workflow and verify its first
successful automatic run, including the AWS smoke stage. Subsequent relevant main
merges deploy automatically; `workflow_dispatch` retries the current verified main.
Infrastructure/IAM changes still require the independent Terraform procedure.

## Isolated restored-backup D1 export tool

The operator allowlist now packages `.github/scripts/backup-d1-export.mts`, the
minimal read-only exporter/verifier graph and the latest reviewed PostgreSQL/D1
snapshots. `tsx` and `zod` are pinned in the isolated operations lockfile, installed
without scripts and signature-checked with the existing setup. A tiny operator
`package.json` selects ESM; application package metadata, application dependencies
and API/Worker entrypoints are not copied into this runtime.

The backup job now has an opt-in bridge, controlled by the operator-managed
`export_d1_from_verified_backup` Terraform setting (default `false`). It requires
`retain_verified_backups=true`; only the backup project receives
`VIDEOQ_EXPORT_D1_FROM_BACKUP=true`. This source change has not enabled it in
production, and no production D1 export has been performed. Deploy reviewed
canonical-main code, including the updated isolated lockfile and snapshot assets,
before enabling the infrastructure setting. Do not fetch a production DB parameter
locally to exercise this entrypoint.

After the exact dump passes isolated restore, row-count and constraint checks,
the DB child invokes the exporter while that restored instance is still alive.
Only a temporary loopback credential and a minimal environment are forwarded;
the original DB URL, PG settings, AWS credentials and OIDC values are not inherited.
The exporter verifies the complete format-v3 archive and records both its archive
content hash and its whole-file size/SHA-256. The child copies both dump and archive
through no-follow descriptors into the parent-owned handoff directory and verifies
the copied archive against that export proof before writing a version-2 marker.

The parent requires both artifacts when export was requested; a dump-only child
result cannot downgrade the operation. It checks the entire artifact set before
uploading and checks each upload's bytes again against the child record. It stores
the dump, `d1-source.videoq-export.ndjson`, and only then the version-2
`verified-backup.json` completion manifest. Each object gets conditional creation,
SSE-S3, checksum validation and versioned HEAD readback. The private manifest binds
the D1 archive's format/content hash and its S3 object version to the same dump and
operator run, with `execution_complete=false`. Export, copy or upload failure fails
the requested operation; partial uploads never receive a completion manifest, and
local handoff files are removed. Default dump-only retention keeps version 1.

First preserve and rehearse recovery of a PostgreSQL dump with D1 export disabled.
Resolve the live legacy-table policy before enabling export. An unmapped table
fails the combined operation; it does not trigger a partial D1 export or delete
earlier preserved backup versions. Source roles/grants, sequence restoration,
external objects, auth, search quality, performance and cutover still require
their separate migration checks.

Inside a clean operator bundle, with `DATABASE_URL` already supplied for the
private restored PostgreSQL instance only:

```sh
VIDEOQ_BACKUP_ISOLATED_EXPORT=true \
  .github/operations-tools/node_modules/.bin/tsx \
  .github/scripts/backup-d1-export.mts \
  --output /private/restore-run/d1-source.videoq-export.ndjson
```

The connection must explicitly select `127.0.0.1`, a port, database `postgres` and
its temporary `postgres` credential. Other hosts/users/databases, URL query
parameters and fragments are refused before importing DB/export dependencies.
The tool supplies its own read-only session option and a bounded query timeout.
Its output parent must be private and owned by the current user; output is 0600,
atomically published and never overwritten. The `node_modules` link may point
only at the independently installed operations dependencies. An existing
application dependency directory is refused before any application-installed
module can execute. Secrets and source records are never written to diagnostics.

The normal archive contracts remain unchanged: full mapped schema coverage,
normalized row conversion and complete archive verification are mandatory.
Unmapped legacy tables stop the export; the preserved PostgreSQL dump is not a
permission to silently omit them. The output still contains sensitive auth and
application data and must remain in the private backup lifecycle. It is a D1
import input, not a completed migration or a PostgreSQL recovery artifact.

`backup-d1-export-fixture.mjs` builds/extracts the actual allowlisted ZIP, uses the
signature-checked operations dependencies and performs real PostgreSQL
`pg_dump`/`pg_restore` before running the packaged tool. Its synthetic schema
contains current columns, primary/unique keys and foreign keys; it is not a full
application/default/check-constraint or authentication rehearsal. The fixture
checks export/verification of 58 tables and four synthetic rows, overwrite
refusal, rejection of foreign application dependencies before a canary module
executes, URL override refusal and refusal of an extra legacy table. It makes no
AWS call. The archive's source/module assets and schema snapshots are also
covered by maintenance-CD selection tests so future changes cannot silently
leave stale privileged operator code deployed. It also runs the packaged backup
child, exporter, handoff and parent retention together with simulated SSM retrieval
and fake S3. That complete path verifies three object uploads and the version-2
completion manifest. An extra source table is then introduced to confirm that the
combined operation fails without uploading or falling back to dump-only success.
These simulations do not prove production AWS credential retrieval, storage or
recovery; those remain required before any production cutover.

## Pause backup uploads while preserving archives

Archive infrastructure and new uploads have separate operator controls. Set
`provision_backup_archive=true` to provision and keep the private versioned bucket;
set `retain_verified_backups=true` only when approved backup code is deployed and
new uploads should run. Retention without provisioned infrastructure is rejected.
Both options default to false.

To stop future uploads after a run, keep `provision_backup_archive=true` and set
`retain_verified_backups=false`. This removes DB-job archive permissions and sets
the upload flag to false while preserving bucket versioning, private policies and
existing objects. Keep the existing schedule setting explicit. Wait for active DB
maintenance executions to finish before changing job configuration or permissions.
Never disable archive provisioning as a way to pause uploads: it would attempt
resource deletion and the bucket's `prevent_destroy` guard will reject the plan.
No automatic expiry or deletion policy is introduced. Infrastructure changes still
require a separately reviewed plan and operator apply; code deployment does not
enable either option.

The operator ZIP object is bootstrapped by Terraform, then managed by maintenance
CD. Terraform ignores later source/path-hash changes for that object, as it does
for pinned job sources and live Lambda code. Provisioning or pausing archive
storage must not upload a different operator ZIP as an infrastructure side effect.


## PostgreSQL minor-version compatibility

The immutable backup/restore image must contain PostgreSQL clients at least as new
as the source server's PostgreSQL 17 minor version. The backup fails before taking
its snapshot when this condition is not met. Refresh the reviewed digest through
normal CI and maintenance CD rather than rewriting a dump or ignoring restore
errors. PostgreSQL 17.12 introduced internal composite-attribute versioning; the
17.11 dump client exports `pg_attver` as a column option that its restore server
rejects. See the [PostgreSQL 17.12 release notes](https://www.postgresql.org/docs/release/17.12/)
and [upstream pg_dump handling](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/bin/pg_dump/pg_dump.c).
The synthetic restore fixture includes this attribute and verifies the complete
four-schema restore. Readiness probes use TCP so they cannot accidentally accept
the temporary Unix-socket-only initialization server. Inventory equality compares
qualified table names and row counts independently of database collation order.
