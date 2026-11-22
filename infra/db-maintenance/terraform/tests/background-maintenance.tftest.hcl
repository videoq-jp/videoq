mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::257240362763:role/mock-maintenance-role" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { version = "1" }
  }
  mock_resource "aws_lambda_alias" {
    defaults = { arn = "arn:aws:lambda:ap-northeast-1:257240362763:function:videoq-db-start-maintenance-prod:live" }
  }
}
variables {
  retire_neon_maintenance = false
  operator_zip            = "versions.tf"
  broker_zip              = "versions.tf"
  source_commit           = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
run "background_control_is_disabled_by_default" {
  command = apply
  assert {
    condition     = alltrue([for policy in aws_iam_role_policy.build : !strcontains(policy.policy, "parameter/videoq/security/prod/background-maintenance")])
    error_message = "Dedicated background control credentials must remain inaccessible by default."
  }
  assert {
    condition = alltrue([for project in aws_codebuild_project.job :
      one([for variable in project.environment[0].environment_variable : variable.value if variable.name == "VIDEOQ_BACKGROUND_MAINTENANCE"]) == "false"
    ])
    error_message = "Background control must not be enabled implicitly."
  }
}
run "background_control_requires_d1_migrations" {
  command = plan
  variables { enable_background_maintenance = true }
  expect_failures = [var.enable_background_maintenance]
}
run "only_migration_gets_background_control" {
  command = apply
  variables {
    enable_d1_migrations          = true
    enable_background_maintenance = true
    retire_neon_maintenance       = true
    provision_backup_archive      = true
    enable_d1_production_smoke    = true
  }
  assert {
    condition = alltrue([for name, policy in aws_iam_role_policy.build :
      strcontains(policy.policy, "parameter/videoq/security/prod/background-maintenance") == (name == "migration")
    ])
    error_message = "Only the fixed migration role may read the dedicated control credential."
  }
  assert {
    condition = alltrue([for name, project in aws_codebuild_project.job :
      one([for variable in project.environment[0].environment_variable : variable.value if variable.name == "VIDEOQ_BACKGROUND_MAINTENANCE"]) == (name == "migration" ? "true" : "false")
    ])
    error_message = "Only the fixed migration project may enable background control."
  }
  assert {
    condition     = strcontains(aws_iam_role_policy.build["migration"].policy, "dynamodb:UpdateItem") && strcontains(aws_iam_role_policy.build["migration"].policy, "dynamodb:ConditionCheckItem")
    error_message = "Migration plan writes must support an atomic global-lock condition check."
  }
}
