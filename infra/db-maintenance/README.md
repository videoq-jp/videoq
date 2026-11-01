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

Privileged operator code comes from a versioned S3 ZIP deployed with an operator
AWS session. Routine GitHub roles cannot upload that ZIP, update its projects,
change the starters/state machine, or write the independent Terraform state.
Migrations fetch the requested commit from the public canonical repository; the
starter independently verifies that it is current main. Changes to reviewed main
migration code therefore remain trusted database changes. Moving execution to AWS
does not make malicious SQL or compromised runtime dependencies harmless.

`build_bundle.py` packages an explicit public-code allowlist, the locked SDK
dependencies, and fixed operations fixtures. It refuses an uncommitted tree for
deployment. The `--allow-dirty` switch is for local packaging validation only.
Credential reads happen at runtime inside AWS. SQL/subprocess errors are captured
and only sanitized failure identifiers reach CloudWatch. GitHub masking commands
must never be emitted into CloudWatch, which does not interpret them as redaction.

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
   SQS to its queue, logs to its group, and the current constrained federation
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
