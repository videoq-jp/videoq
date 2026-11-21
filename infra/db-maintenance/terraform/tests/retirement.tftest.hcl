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
run "d1_resource_hold_uses_existing_starter_and_no_new_builds" {
  command = plan
  variables { enable_d1_resource_hold = true }
  assert {
    condition = (toset(keys(aws_codebuild_project.job)) == toset(["migration", "smoke"]) &&
      toset(keys(aws_lambda_function.broker)) == toset(["migration", "smoke", "deploy"]) &&
      aws_lambda_function.broker["migration"].environment[0].variables.ALLOWED_KINDS == "migration,d1-resource-hold" &&
      aws_lambda_function.broker["smoke"].environment[0].variables.ALLOWED_KINDS == "smoke" &&
    aws_lambda_function.broker["deploy"].environment[0].variables.ALLOWED_KINDS == "deploy")
    error_message = "The opt-in D1 hold must use only the existing migration starter and preserve the three maintenance jobs."
  }
  assert {
    condition = (!strcontains(aws_iam_role_policy.broker["migration"].policy, "ssm:") &&
      !strcontains(aws_iam_role_policy.broker["migration"].policy, "lambda:UpdateFunction") &&
    !strcontains(aws_iam_role_policy.broker["migration"].policy, "iam:"))
    error_message = "The ownership-only starter must gain no credential, function-update or IAM capability."
  }
}
run "d1_resource_hold_cannot_enable_legacy_graph" {
  command = plan
  variables {
    enable_d1_resource_hold = true
    retire_neon_maintenance = false
  }
  expect_failures = [var.enable_d1_resource_hold]
}
run "resource_smoke_guard_reads_only_its_fixed_hold_metadata" {
  command = plan
  variables { enable_d1_resource_hold = true }
  assert {
    condition = (length([for statement in jsondecode(aws_iam_role_policy.build["smoke"].policy).Statement : statement
      if statement.Action == ["dynamodb:GetItem"] && statement.Resource == aws_dynamodb_table.maintenance.arn &&
      statement.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"] == ["maintenance", "run#*"]
    ]) == 1)
    error_message = "Owned native smoke must read only the maintenance owner and run records."
  }
  assert {
    condition = (length([for statement in jsondecode(aws_iam_role_policy.build["smoke"].policy).Statement : statement
      if statement.Action == ["states:DescribeExecution", "states:DescribeStateMachineForExecution"] &&
      statement.Resource == "arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-*"
      ]) == 1 && !strcontains(aws_iam_role_policy.build["smoke"].policy, "dynamodb:UpdateItem") &&
      !strcontains(aws_iam_role_policy.build["smoke"].policy, "states:StartExecution") &&
    !strcontains(aws_iam_role_policy.build["smoke"].policy, "states:StopExecution"))
    error_message = "Smoke must gain only fixed execution reads, never control or journal mutation."
  }
}
