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

run "d1_export_requires_private_retention" {
  command = plan
  variables {
    retain_verified_backups        = false
    export_d1_from_verified_backup = true
  }
  expect_failures = [var.export_d1_from_verified_backup]
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
    condition = alltrue([for project in aws_codebuild_project.job :
      one([for variable in project.environment[0].environment_variable : variable.value if variable.name == "VIDEOQ_EXPORT_D1_FROM_BACKUP"]) == "false"
    ])
    error_message = "D1 backup export must stay disabled by default."
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

run "preserve_cd_owned_operator_artifact" {
  command = plan
  variables {
    operator_zip = "tests/boundaries.tftest.hcl"
  }
  assert {
    condition = (aws_s3_object.operator.source == "versions.tf" &&
    aws_s3_object.operator.source_hash == filesha256("versions.tf"))
    error_message = "Infrastructure changes must not replace the CD-owned operator artifact after bootstrap."
  }
}

run "private_backup_archive_boundaries" {
  command = apply
  variables {
    provision_backup_archive       = true
    retain_verified_backups        = true
    export_d1_from_verified_backup = true
  }
  assert {
    condition = alltrue([for purpose, project in aws_codebuild_project.job :
      one([for variable in project.environment[0].environment_variable : variable.value if variable.name == "VIDEOQ_EXPORT_D1_FROM_BACKUP"]) == (purpose == "backup" ? "true" : "false")
    ])
    error_message = "Only the backup project may export from its isolated restored DB."
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

run "cutover_hold_disabled_by_default" {
  command = plan
  variables {
    provision_backup_archive = true
    retain_verified_backups  = false
  }
  assert {
    condition     = !contains(split(",", aws_lambda_function.broker["maintenance"].environment[0].variables.ALLOWED_KINDS), "cutover-hold")
    error_message = "Cutover control must remain disabled until the deployed aliases and definition are verified."
  }
  assert {
    condition     = alltrue([for statement in jsondecode(aws_iam_role_policy.state_machine.policy).Statement : !contains(statement.Action, "dynamodb:ConditionCheckItem")])
    error_message = "The extra transactional predicate must remain disabled by default."
  }
}

run "cutover_hold_opt_in_is_narrow" {
  command = plan
  variables {
    enable_cutover_hold      = true
    provision_backup_archive = true
    retain_verified_backups  = false
  }
  assert {
    condition     = contains(split(",", aws_lambda_function.broker["maintenance"].environment[0].variables.ALLOWED_KINDS), "cutover-hold")
    error_message = "Explicit opt-in must enable only the maintenance invoker."
  }
  assert {
    condition     = alltrue([for key, function in aws_lambda_function.broker : key == "maintenance" || !contains(split(",", function.environment[0].variables.ALLOWED_KINDS), "cutover-hold")])
    error_message = "Migration, backup, smoke and deploy invokers cannot release a cutover hold."
  }
  assert {
    condition = length([for statement in jsondecode(aws_iam_role_policy.state_machine.policy).Statement : statement
      if statement.Action == ["dynamodb:ConditionCheckItem"] && statement.Resource == aws_dynamodb_table.maintenance.arn &&
      statement.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"] == ["run#*"]
    ]) == 1
    error_message = "Opt-in adds only the run-record transaction predicate; no DB or credential grants."
  }
}

run "d1_migration_permissions_disabled_by_default" {
  command = plan
  variables {
    provision_backup_archive = true
    retain_verified_backups  = false
  }
  assert {
    condition     = alltrue([for policy in aws_iam_role_policy.build : !strcontains(policy.policy, "/videoq/security/prod/d1-migration")])
    error_message = "The D1-only migration credential must remain unavailable by default."
  }
}

run "d1_migration_permissions_are_narrow" {
  command = plan
  variables {
    provision_backup_archive = true
    retain_verified_backups  = false
    enable_d1_migrations     = true
  }
  assert {
    condition     = alltrue([for purpose, policy in aws_iam_role_policy.build : (purpose == "migration") == strcontains(policy.policy, "/videoq/security/prod/d1-migration")])
    error_message = "Only the fixed migration project may read its D1 credential."
  }
  assert {
    condition = length([for statement in jsondecode(aws_iam_role_policy.build["migration"].policy).Statement : statement
      if statement.Action == ["dynamodb:GetItem"] && statement.Resource == aws_dynamodb_table.maintenance.arn && statement.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"] == ["maintenance", "run#*"]
    ]) == 1
    error_message = "D1 migration can only read the existing lock/run records, never release or replace them."
  }
}

run "consumer_preparation_disabled_by_default" {
  command = plan
  variables {
    provision_backup_archive = true
    retain_verified_backups  = false
  }
  assert {
    condition     = alltrue([for policy in aws_iam_role_policy.build : !strcontains(policy.policy, "lambda:ListEventSourceMappings")])
    error_message = "The readonly preparation permission must require explicit hold opt-in."
  }
}

run "consumer_preparation_opt_in_is_readonly" {
  command = plan
  variables {
    provision_backup_archive = true
    retain_verified_backups  = false
    enable_cutover_hold      = true
  }
  assert {
    condition     = alltrue([for purpose, policy in aws_iam_role_policy.build : (purpose == "rotation") == strcontains(policy.policy, "lambda:ListEventSourceMappings")])
    error_message = "Only the fixed rotation project may inspect consumer metadata."
  }
  assert {
    condition     = alltrue([for policy in aws_iam_role_policy.build : !strcontains(policy.policy, "lambda:UpdateEventSourceMapping") && !strcontains(policy.policy, "lambda:PutFunctionConcurrency")])
    error_message = "Preparing a plan must not grant consumer or concurrency mutation authority."
  }
  assert {
    condition = length([for statement in jsondecode(aws_iam_role_policy.build["rotation"].policy).Statement : statement
      if statement.Action == ["dynamodb:GetItem", "dynamodb:ConditionCheckItem"] && statement.Resource == aws_dynamodb_table.maintenance.arn && statement.Condition["ForAllValues:StringEquals"]["dynamodb:LeadingKeys"] == ["maintenance"]
    ]) == 1
    error_message = "The added global-lock permission must be a readonly ownership predicate."
  }
}

run "consumer_control_requires_hold" {
  command = plan
  variables {
    provision_backup_archive        = true
    retain_verified_backups         = false
    enable_cutover_hold             = false
    enable_cutover_consumer_control = true
  }
  expect_failures = [var.enable_cutover_consumer_control]
}

run "consumer_control_disabled_by_default" {
  command = plan
  variables {
    provision_backup_archive = true
    retain_verified_backups  = false
    enable_cutover_hold      = true
  }
  assert {
    condition     = alltrue([for policy in aws_iam_role_policy.build : !strcontains(policy.policy, "lambda:UpdateEventSourceMapping")]) && alltrue([for policy in aws_iam_role_policy.broker : !strcontains(policy.policy, "states:RedriveExecution")])
    error_message = "Hold opt-in alone must not enable consumer mutations or retry authority."
  }
}

run "consumer_control_permissions_are_narrow" {
  command = plan
  variables {
    provision_backup_archive        = true
    retain_verified_backups         = false
    enable_cutover_hold             = true
    enable_cutover_consumer_control = true
  }
  assert {
    condition     = alltrue([for key, policy in aws_iam_role_policy.broker : (key == "maintenance") == strcontains(policy.policy, "states:RedriveExecution")]) && alltrue([for key, policy in aws_iam_role_policy.build : (key == "rotation") == strcontains(policy.policy, "/videoq/security/prod/cutover-control")])
    error_message = "Only the maintenance invoker may redrive and only the fixed rotation job may read the API settings credential."
  }
  assert {
    condition = length([for statement in jsondecode(aws_iam_role_policy.build["rotation"].policy).Statement : statement
      if statement.Action == ["lambda:UpdateEventSourceMapping"] && statement.Resource == "arn:aws:lambda:ap-northeast-1:257240362763:event-source-mapping:*" &&
      statement.Condition.ArnEquals["lambda:FunctionArn"] == ["arn:aws:lambda:ap-northeast-1:257240362763:function:videoq-worker-prod", "arn:aws:lambda:ap-northeast-1:257240362763:function:videoq-worker-search-prod", "arn:aws:lambda:ap-northeast-1:257240362763:function:videoq-worker-account-prod"]
    ]) == 1
    error_message = "Mapping changes must be limited to the three existing worker functions."
  }
  assert {
    condition     = alltrue([for key, function in aws_lambda_function.broker : (function.environment[0].variables.CUTOVER_CONSUMER_CONTROL_ENABLED == "true") == (key == "maintenance")])
    error_message = "The consumer capability must be exposed only on the maintenance invoker."
  }
}

run "stage_history_disabled_by_default" {
  command = plan
  variables {
    provision_backup_archive = true
    retain_verified_backups  = false
  }
  assert {
    condition     = alltrue([for policy in aws_iam_role_policy.broker : !strcontains(policy.policy, "states:GetExecutionHistory")]) && alltrue([for policy in aws_iam_role_policy.build : !strcontains(policy.policy, "states:GetExecutionHistory")])
    error_message = "Native stage history must not be granted before explicit cutover opt-in."
  }
}

run "stage_history_is_execution_scoped_metadata" {
  command = plan
  variables {
    provision_backup_archive        = true
    retain_verified_backups         = false
    enable_cutover_hold             = true
    enable_cutover_consumer_control = true
  }
  assert {
    condition     = alltrue([for key, policy in aws_iam_role_policy.broker : (key == "maintenance") == strcontains(policy.policy, "states:GetExecutionHistory")]) && alltrue([for key, policy in aws_iam_role_policy.build : (key == "rotation") == strcontains(policy.policy, "states:GetExecutionHistory")])
    error_message = "Only the maintenance broker and fixed rotation stage may read native stage history."
  }
  assert {
    condition = length([for statement in jsondecode(aws_iam_role_policy.broker["maintenance"].policy).Statement : statement
      if statement.Action == ["states:GetExecutionHistory"] && statement.Resource == "arn:aws:states:ap-northeast-1:257240362763:execution:videoq-db-maintenance-prod:db-*"
    ]) == 1
    error_message = "History access must stay on the fixed production maintenance execution prefix."
  }
}

run "postwrite_recovery_disabled_by_default" {
  command = plan
  variables {
    provision_backup_archive = true
    retain_verified_backups  = false
  }
  assert {
    condition = alltrue([for project in aws_codebuild_project.job :
      one([for variable in project.environment[0].environment_variable : variable.value if variable.name == "VIDEOQ_CUTOVER_POSTWRITE_RECOVERY"]) == "false"
    ])
    error_message = "Post-write recovery must not activate merely by deploying code."
  }
  assert {
    condition     = alltrue([for policy in aws_iam_role_policy.build : !strcontains(policy.policy, "cutover-recovery/")])
    error_message = "The disabled recovery stage must not receive private snapshot reads."
  }
}

run "postwrite_recovery_requires_owned_admission_control" {
  command = plan
  variables {
    provision_backup_archive          = true
    enable_cutover_postwrite_recovery = true
  }
  expect_failures = [var.enable_cutover_postwrite_recovery]
}

run "postwrite_recovery_reads_are_narrow" {
  command = plan
  variables {
    provision_backup_archive          = true
    retain_verified_backups           = false
    enable_cutover_hold               = true
    enable_cutover_consumer_control   = true
    enable_cutover_postwrite_recovery = true
  }
  assert {
    condition = alltrue([for purpose, project in aws_codebuild_project.job :
      project.environment[0].compute_type == (purpose == "rotation" ? "BUILD_GENERAL1_MEDIUM" : "BUILD_GENERAL1_SMALL")
    ])
    error_message = "Only enabled recovery rotation receives additional bounded snapshot memory."
  }
  assert {
    condition = alltrue([for purpose, project in aws_codebuild_project.job :
      one([for variable in project.environment[0].environment_variable : variable.value if variable.name == "VIDEOQ_CUTOVER_POSTWRITE_RECOVERY"]) == (purpose == "rotation" ? "true" : "false")
    ])
    error_message = "Only the fixed rotation project may run held inverse recovery."
  }
  assert {
    condition = alltrue([for purpose, policy in aws_iam_role_policy.build :
      (purpose == "rotation") == strcontains(policy.policy, "cutover-recovery/*")
    ])
    error_message = "Recovery snapshot access must remain confined to the root-operated AWS stage."
  }
  assert {
    condition = length([for statement in jsondecode(aws_iam_role_policy.build["rotation"].policy).Statement : statement
      if statement.Action == ["s3:GetObjectVersion"] && statement.Resource == ["${aws_s3_bucket.archive[0].arn}/cutover-recovery/*"]
    ]) == 1
    error_message = "Only explicitly versioned recovery objects may be retrieved; no latest lookup or upload grant."
  }
  assert {
    condition     = strcontains(aws_iam_role_policy.build["rotation"].policy, "/videoq/prod/app") && strcontains(aws_iam_role_policy.build["rotation"].policy, "/videoq/security/prod/d1-migration")
    error_message = "Only the gated AWS parent may load the R2 and fixed D1 inspection credentials."
  }
}

run "d1_smoke_disabled_by_default" {
  command = plan
  variables {
    provision_backup_archive = true
    retain_verified_backups  = false
  }
  assert {
    condition = alltrue([for project in aws_codebuild_project.job :
      one([for variable in project.environment[0].environment_variable : variable.value if variable.name == "VIDEOQ_D1_PRODUCTION_SMOKE"]) == "false"
    ])
    error_message = "D1 backend detection must stay disabled until its fixed credentials and reviewed code exist."
  }
  assert {
    condition     = !strcontains(aws_iam_role_policy.build["smoke"].policy, "smoke-identity")
    error_message = "The disabled smoke job must not read its future identity key."
  }
}

run "d1_smoke_permissions_are_narrow" {
  command = plan
  variables {
    provision_backup_archive   = true
    retain_verified_backups    = false
    enable_d1_production_smoke = true
  }
  assert {
    condition = one([for variable in aws_codebuild_project.job["smoke"].environment[0].environment_variable : variable.value if variable.name == "VIDEOQ_D1_PRODUCTION_SMOKE"]) == "true" && alltrue([for purpose, project in aws_codebuild_project.job :
      one([for variable in project.environment[0].environment_variable : variable.value if variable.name == "VIDEOQ_D1_PRODUCTION_SMOKE"]) == "false" if purpose != "smoke"
    ])
    error_message = "Only the smoke project may select D1 smoke mode."
  }
  assert {
    condition = alltrue([for statement in jsondecode(aws_iam_role_policy.build["smoke"].policy).Statement :
      !contains(statement.Action, "ssm:GetParameter") || alltrue([for resource in statement.Resource : contains([
        "arn:aws:ssm:ap-northeast-1:257240362763:parameter/videoq/security/prod/db-smoke",
        "arn:aws:ssm:ap-northeast-1:257240362763:parameter/videoq/security/prod/d1-migration",
        "arn:aws:ssm:ap-northeast-1:257240362763:parameter/videoq/security/prod/smoke-identity"
      ], resource)])
    ])
    error_message = "Smoke may read only its existing profile, D1 credential and identity key."
  }
  assert {
    condition = alltrue([for purpose, policy in aws_iam_role_policy.build :
      !strcontains(policy.policy, "smoke-identity") if purpose != "smoke"
    ])
    error_message = "No other job receives the synthetic-identity signing key."
  }
}

run "final_handoff_disabled_by_default" {
  command = plan
  variables {
    provision_backup_archive = true
    retain_verified_backups  = false
  }
  assert {
    condition = alltrue([for project in aws_codebuild_project.job :
      one([for variable in project.environment[0].environment_variable : variable.value if variable.name == "VIDEOQ_CUTOVER_FINAL_HANDOFF"]) == "false"
    ])
    error_message = "Internal authentication provisioning must stay disabled until explicitly prepared."
  }
  assert {
    condition     = alltrue([for policy in aws_iam_role_policy.build : !strcontains(policy.policy, "/worker-internal-api")])
    error_message = "No default job may allocate or read the internal producer key."
  }
}

run "final_handoff_requires_inverse_and_smoke" {
  command = plan
  variables {
    provision_backup_archive     = true
    enable_cutover_final_handoff = true
  }
  expect_failures = [var.enable_cutover_final_handoff]
}

run "final_auth_preparation_has_fixed_parameter_writes" {
  command = plan
  variables {
    provision_backup_archive          = true
    retain_verified_backups           = false
    enable_cutover_hold               = true
    enable_cutover_consumer_control   = true
    enable_cutover_postwrite_recovery = true
    enable_d1_production_smoke        = true
    enable_cutover_final_handoff      = true
  }
  assert {
    condition = alltrue([for purpose, project in aws_codebuild_project.job :
      one([for variable in project.environment[0].environment_variable : variable.value if variable.name == "VIDEOQ_CUTOVER_FINAL_HANDOFF"]) == (purpose == "rotation" ? "true" : "false")
    ])
    error_message = "Only the fixed rotation project may provision internal authentication."
  }
  assert {
    condition = length([for statement in jsondecode(aws_iam_role_policy.build["rotation"].policy).Statement : statement
      if statement.Action == ["ssm:GetParameter", "ssm:PutParameter"] && statement.Resource == [
        "arn:aws:ssm:ap-northeast-1:257240362763:parameter/videoq/prod/app",
        "arn:aws:ssm:ap-northeast-1:257240362763:parameter/videoq/security/prod/worker-internal-api"
      ]
    ]) == 1
    error_message = "The preparation stage may update only the existing app object and its independent producer-key escrow."
  }
  assert {
    condition = alltrue([for purpose, policy in aws_iam_role_policy.build :
      (purpose == "rotation") == strcontains(policy.policy, "/worker-internal-api")
    ])
    error_message = "No verification/migration/backup project receives the producer-key escrow."
  }
}
