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

run "retention_requires_archive_infrastructure" {
  command = plan
  variables {
    retain_verified_backups = true
  }
  expect_failures = [var.retain_verified_backups]
}

run "credential_and_control_boundaries" {
  command = apply

  assert {
    condition     = length(aws_s3_bucket.archive) == 0
    error_message = "Backup retention must stay disabled until explicitly enabled by the infrastructure operator."
  }
  assert {
    condition = alltrue([for project in merge(aws_codebuild_project.job, { deploy = aws_codebuild_project.deploy }) :
      !contains(keys(jsondecode(project.source[0].buildspec).phases.install["runtime-versions"]), "nodejs") &&
      alltrue([for command in local.runtime_setup_commands : contains(jsondecode(project.source[0].buildspec).phases.install.commands, command)])
    ])
    error_message = "Every job must use the verified preinstalled Node 26 binaries without copying them on every run."
  }
  assert {
    condition = alltrue([for project in aws_codebuild_project.job :
      contains(jsondecode(project.source[0].buildspec).phases.install.commands, "node infra/db-maintenance/runtime/setup-job.cjs")
    ])
    error_message = "Every database job must run its stage-aware dependency preparation."
  }

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

run "private_backup_archive_boundaries" {
  command = apply
  variables {
    provision_backup_archive = true
    retain_verified_backups  = true
  }
  assert {
    condition = (aws_s3_bucket.archive[0].bucket == "videoq-db-archives-prod-257240362763" &&
      aws_s3_bucket.archive[0].bucket != aws_s3_bucket.bundle.bucket &&
      !aws_s3_bucket.archive[0].force_destroy &&
      aws_s3_bucket_versioning.archive[0].versioning_configuration[0].status == "Enabled" &&
      aws_s3_bucket_public_access_block.archive[0].block_public_acls &&
      aws_s3_bucket_public_access_block.archive[0].block_public_policy &&
      aws_s3_bucket_public_access_block.archive[0].ignore_public_acls &&
      aws_s3_bucket_public_access_block.archive[0].restrict_public_buckets &&
    aws_s3_bucket_ownership_controls.archive[0].rule[0].object_ownership == "BucketOwnerEnforced")
    error_message = "Database archives require a separate versioned private bucket without public access or ACLs."
  }
  assert {
    condition = alltrue(flatten([for purpose, policy in aws_iam_role_policy.build : [
      for statement in jsondecode(policy.policy).Statement :
      !strcontains(jsonencode(statement.Resource), aws_s3_bucket.archive[0].arn) || (purpose == "backup" &&
        statement.Resource == "${aws_s3_bucket.archive[0].arn}/verified/*" &&
      statement.Action == ["s3:PutObject", "s3:GetObjectVersion"])
    ]]))
    error_message = "Only backup jobs may write/read exact archive versions; no deletion, listing or other job access is allowed."
  }
  assert {
    condition = alltrue([for purpose, project in aws_codebuild_project.job :
      one([for variable in project.environment[0].environment_variable : variable.value if variable.name == "VIDEOQ_RETAIN_BACKUP"]) == (purpose == "backup" ? "true" : "false")
    ])
    error_message = "Only the backup project may enable retention."
  }
  assert {
    condition = (length(jsondecode(aws_s3_bucket_policy.archive[0].policy).Statement) == 3 &&
    alltrue([for statement in jsondecode(aws_s3_bucket_policy.archive[0].policy).Statement : statement.Effect == "Deny"]))
    error_message = "Archive bucket policy must deny insecure transport, missing encryption and unconditional writes."
  }
}

run "pause_uploads_without_destroying_archives" {
  command = plan
  variables {
    provision_backup_archive = true
    retain_verified_backups  = false
  }
  assert {
    condition = (length(aws_s3_bucket.archive) == 1 &&
      aws_s3_bucket_versioning.archive[0].versioning_configuration[0].status == "Enabled" &&
      aws_s3_bucket_public_access_block.archive[0].block_public_policy &&
    !aws_s3_bucket.archive[0].force_destroy)
    error_message = "Pausing uploads must preserve the private versioned archive infrastructure."
  }
  assert {
    condition = alltrue([for project in aws_codebuild_project.job :
      one([for variable in project.environment[0].environment_variable : variable.value if variable.name == "VIDEOQ_RETAIN_BACKUP"]) == "false"
    ])
    error_message = "Pausing retention must disable every job's archive uploads."
  }
  assert {
    condition = alltrue(flatten([for policy in aws_iam_role_policy.build : [
      for statement in jsondecode(policy.policy).Statement :
      !strcontains(jsonencode(statement.Resource), aws_s3_bucket.archive[0].arn)
    ]]))
    error_message = "Paused retention must remove archive permissions from DB jobs while preserving stored backups."
  }
}
