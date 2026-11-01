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
  # Mock providers hash these local files but never upload or execute them.
  operator_zip  = "versions.tf"
  broker_zip    = "versions.tf"
  source_commit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}

run "credential_and_control_boundaries" {
  command = apply

  assert {
    condition = alltrue([for statement in jsondecode(aws_iam_role_policy.deploy.policy).Statement :
      statement.Effect != "Allow" || alltrue([for action in statement.Action :
        !startswith(action, "ssm:") && !startswith(action, "iam:") && action != "kms:Decrypt"
      ])
    ])
    error_message = "The deployment builder must not read credentials or change IAM."
  }
  assert {
    condition = alltrue([for statement in jsondecode(aws_iam_role_policy.deploy.policy).Statement :
      !contains(statement.Action, "codebuild:UpdateProject") ||
      !contains(statement.Resource, "arn:aws:codebuild:${local.region}:${local.account}:project/videoq-db-deploy-prod")
    ])
    error_message = "The deployment builder must not modify its own project."
  }
  assert {
    condition     = aws_codebuild_project.deploy.source[0].type == "NO_SOURCE" && !aws_codebuild_project.deploy.environment[0].privileged_mode
    error_message = "Deployment must fetch the verified canonical commit with a fixed buildspec, without Docker privilege."
  }

  assert {
    condition = alltrue([for purpose in ["maintenance", "migration", "backup", "smoke", "deploy"] : alltrue([
      for statement in jsondecode(aws_iam_role_policy.broker[purpose].policy).Statement :
      !contains(statement.Action, "ssm:GetParameter") && !contains(statement.Action, "codebuild:StartBuild")
    ])])
    error_message = "The public starters must neither read credentials nor grant caller-controlled build starts."
  }
  assert {
    condition = alltrue([for purpose in ["migration", "backup", "smoke", "audit"] : alltrue([
      for statement in jsondecode(aws_iam_role_policy.build[purpose].policy).Statement :
      !contains(statement.Action, "ssm:GetParameter") || statement.Resource == [local.parameter[purpose]]
    ])])
    error_message = "Each non-admin job may read only its own exact credential parameter."
  }
  assert {
    condition     = aws_codebuild_project.job["rotation"].source[0].type == "S3" && aws_codebuild_project.job["rotation"].source_version == aws_s3_object.operator.version_id
    error_message = "The admin job must use a versioned operator artifact rather than caller-supplied or mutable GitHub source."
  }
  assert {
    condition = alltrue([for purpose, project in aws_codebuild_project.job :
      project.environment[0].privileged_mode == (purpose == "backup") && project.concurrent_build_limit == 1
    ])
    error_message = "Only the isolated restore job needs Docker privilege, and each project must have bounded concurrency."
  }
  assert {
    condition     = aws_scheduler_schedule.maintenance.state == "DISABLED"
    error_message = "Do not enable the new scheduler before verified production cutover."
  }
  assert {
    condition = alltrue([for purpose, role in aws_iam_role.build :
      jsondecode(role.assume_role_policy).Statement[0].Principal.Service == "codebuild.amazonaws.com" &&
      jsondecode(role.assume_role_policy).Statement[0].Condition.StringEquals["aws:SourceAccount"] == local.account
    ])
    error_message = "Database-reading roles must trust the named AWS service/account, never GitHub OIDC."
  }
  assert {
    condition = alltrue([for statement in jsondecode(aws_iam_policy.worker_boundary.policy).Statement :
      !contains(statement.Action, "ssm:GetParameter") || statement.Resource == [
        local.parameter["worker"], "arn:aws:ssm:${local.region}:${local.account}:parameter/videoq/prod/app"
      ]
    ])
    error_message = "Even a broadened worker inline policy must not gain maintenance/admin credential access."
  }
}
