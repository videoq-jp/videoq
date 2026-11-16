mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::257240362763:role/mock-maintenance-role" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { version = "1" }
  }
}
variables {
  operator_zip               = "versions.tf"
  broker_zip                 = "versions.tf"
  source_commit              = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  provision_backup_archive   = true
  enable_d1_migrations       = true
  enable_d1_production_smoke = true
}
run "retirement_cannot_remove_archives" {
  command = plan
  variables { provision_backup_archive = false }
  expect_failures = [var.retire_neon_maintenance]
}
run "retirement_cannot_enable_legacy_control" {
  command = plan
  variables { enable_cutover_hold = true }
  expect_failures = [var.retire_neon_maintenance]
}
run "retire_neon_preserves_archive_and_d1" {
  command = apply
  assert {
    condition = (toset(keys(aws_codebuild_project.job)) == toset(["migration", "smoke"]) &&
      toset(keys(aws_lambda_function.broker)) == toset(["migration", "smoke", "deploy"]) &&
    length(aws_scheduler_schedule.maintenance) == 0 && length(aws_iam_role.scheduler) == 0)
    error_message = "Retirement must remove obsolete jobs, invokers and the scheduler without removing D1 maintenance."
  }
  assert {
    condition = (length(aws_s3_bucket.archive) == 1 && !aws_s3_bucket.archive[0].force_destroy &&
      aws_s3_bucket_versioning.archive[0].versioning_configuration[0].status == "Enabled" &&
    length(aws_cloudwatch_log_group.build) == 5 && length(aws_cloudwatch_log_group.broker) == 5)
    error_message = "Versioned archives and historical logs must remain provisioned."
  }
  assert {
    condition = alltrue([for policy in merge(aws_iam_role_policy.build, aws_iam_role_policy.broker, { deploy = aws_iam_role_policy.deploy, states = aws_iam_role_policy.state_machine }) :
      !strcontains(policy.policy, "videoq-db-rotation-prod") && !strcontains(policy.policy, "videoq-db-backup-prod") &&
      !strcontains(policy.policy, "videoq-db-audit-prod") && !strcontains(policy.policy, "parameter/videoq/prod/db-") &&
      !strcontains(policy.policy, "parameter/videoq/security/prod/db-admin") &&
      !strcontains(policy.policy, "videoq-db-start-maintenance-prod") && !strcontains(policy.policy, "videoq-db-start-backup-prod")
    ])
    error_message = "Remaining roles must not reference retired jobs, invokers or PostgreSQL credentials."
  }
  assert {
    condition = !strcontains(aws_iam_policy.worker_boundary.policy, "/worker-db") && alltrue([
      for name in ["rotation", "backup", "audit", "cutover-hold"] : !strcontains(aws_sfn_state_machine.maintenance.definition, "videoq-db-${name}-prod")
    ]) && jsondecode(aws_sfn_state_machine.maintenance.definition).States.Operation.Default == "RetiredOperation"
    error_message = "The D1 state machine must fail closed on retired operations and the worker ceiling must drop PostgreSQL."
  }
}
