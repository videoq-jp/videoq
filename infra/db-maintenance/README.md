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

Unit tests simulate versioned S3 responses, corrupt payloads, mismatched object
references, permission/transport failures and cleanup. Actual AWS read permissions,
real storage and production recovery remain unproven. This PR does not add the D1
export producer or migration archive verifier; version-2 manifests are supported
as an explicit forward-compatible transport contract only.
The version-read/checksum behavior follows the [AWS GetObject reference](https://docs.aws.amazon.com/cli/latest/reference/s3api/get-object.html).
