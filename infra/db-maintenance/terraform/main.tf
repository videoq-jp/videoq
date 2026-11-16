variable "retire_neon_maintenance" {
  type        = bool
  default     = true
  description = "Remove retired production Neon jobs and invokers, preserving versioned archives and recovery evidence. False is for historical contract tests only."
  validation {
    condition = !var.retire_neon_maintenance || (
      var.provision_backup_archive && !var.retain_verified_backups &&
      !var.export_d1_from_verified_backup && !var.schedule_enabled &&
      !var.enable_cutover_hold && !var.enable_cutover_consumer_control &&
      !var.enable_cutover_postwrite_recovery && !var.enable_cutover_final_handoff &&
      var.enable_d1_migrations && var.enable_d1_production_smoke
    )
    error_message = "Neon retirement requires preserved archives, enabled D1 jobs and all legacy mutation/upload/schedule capabilities disabled."
  }
}

variable "enable_cutover_consumer_control" {
  type        = bool
  default     = false
  description = "Enable owned pre-DB-mutation SQS pause/resume and same-execution redrive."
  validation {
    condition     = !var.enable_cutover_consumer_control || var.enable_cutover_hold
    error_message = "Consumer mutation control requires the reviewed maintenance hold."
  }
}

variable "enable_d1_migrations" {
  type        = bool
  default     = false
  description = "Allow the fixed migration job to read its D1-only credential and verify existing lock ownership."
}

variable "enable_cutover_postwrite_recovery" {
  type        = bool
  default     = false
  description = "Enable only the fixed root-operated AWS inverse restore, keeping the post-write hold and all writer admission closed."
  validation {
    condition     = !var.enable_cutover_postwrite_recovery || (var.enable_cutover_consumer_control && var.provision_backup_archive)
    error_message = "Post-write recovery requires owned consumer control and preserved private archive infrastructure."
  }
}

variable "enable_d1_production_smoke" {
  type        = bool
  default     = false
  description = "Allow only the fixed smoke job to select the actual production backend and read its D1 credential and synthetic-identity signing key."
}

variable "enable_cutover_final_handoff" {
  type        = bool
  default     = false
  description = "Allow fixed AWS worker-auth preparation only after inverse recovery and D1 smoke capabilities are enabled."
  validation {
    condition     = !var.enable_cutover_final_handoff || (var.enable_cutover_postwrite_recovery && var.enable_d1_production_smoke)
    error_message = "Final handoff preparation requires both inverse recovery and backend-aware production verification."
  }
}

variable "operator_zip" {
  type = string
}
variable "broker_zip" {
  type = string
}
variable "source_commit" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{40}$", var.source_commit))
    error_message = "Use the reviewed operator bundle commit."
  }
}
variable "enable_cutover_hold" {
  type        = bool
  default     = false
  description = "Enable the reviewed pre-mutation maintenance hold only after all live broker aliases and the state machine have been verified. This does not enable a database write fence."
}
variable "schedule_enabled" {
  type    = bool
  default = false # Enable only after successful production verification/cutover.
}
variable "provision_backup_archive" {
  type        = bool
  default     = false
  description = "Keep the private archive infrastructure provisioned independently of new backup uploads. Keep enabled after creation to preserve retained backups."
}
variable "retain_verified_backups" {
  type        = bool
  default     = false
  description = "Retain restored backups in the dedicated private archive bucket; enable only with reviewed operator code."
  validation {
    condition     = !var.retain_verified_backups || var.provision_backup_archive
    error_message = "Backup retention requires explicitly provisioned archive infrastructure."
  }
}
variable "export_d1_from_verified_backup" {
  type        = bool
  default     = false
  description = "Export D1 input only from the isolated verified backup and retain it with the dump. Requires reviewed operator code and explicit legacy-table policy."
  validation {
    condition     = !var.export_d1_from_verified_backup || var.retain_verified_backups
    error_message = "D1 export requires verified backup retention; an archive must not be discarded after exporting protected data."
  }
}

variable "enable_d1_resource_hold" {
  type        = bool
  default     = false
  description = "Allow the existing migration starter to acquire a D1 resource-replacement hold. No database or consumer mutation capability is granted."
  validation {
    condition     = !var.enable_d1_resource_hold || var.retire_neon_maintenance
    error_message = "The D1 resource hold requires the retired-Neon D1-only maintenance graph."
  }
}

locals {
  account             = "257240362763"
  region              = "ap-northeast-1"
  name                = "videoq-db-maintenance-prod"
  historical_projects = { for purpose in ["rotation", "migration", "backup", "smoke", "audit"] : purpose => "videoq-db-${purpose}-prod" }
  projects            = { for purpose, name in local.historical_projects : purpose => name if !var.retire_neon_maintenance || contains(["migration", "smoke"], purpose) }
  historical_brokers = {
    maintenance = var.enable_cutover_hold ? "rotate,rollback,audit,cutover-hold" : "rotate,rollback,audit"
    migration   = var.enable_d1_resource_hold ? "migration,d1-resource-hold" : "migration"
    backup      = "backup"
    smoke       = "smoke"
    deploy      = "deploy"
  }
  brokers   = { for purpose, kinds in local.historical_brokers : purpose => kinds if !var.retire_neon_maintenance || contains(["migration", "smoke", "deploy"], purpose) }
  profiles  = jsondecode(file("${path.module}/../../../.github/scripts/neon-profiles.json"))
  parameter = { for name, profile in local.profiles : name => "arn:aws:ssm:${local.region}:${local.account}:parameter${profile.parameter}" }
  protected_parameters = [
    "arn:aws:ssm:${local.region}:${local.account}:parameter/videoq/security/prod/db-admin",
    "arn:aws:ssm:${local.region}:${local.account}:parameter/videoq/security/prod/db-rotation",
    "arn:aws:ssm:${local.region}:${local.account}:parameter/videoq/security/prod/hyperdrive-credentials",
  ]
  all_projects  = merge(local.projects, { deploy = "videoq-db-deploy-prod" })
  project_arns  = [for name in values(local.all_projects) : "arn:aws:codebuild:${local.region}:${local.account}:project/${name}"]
  execution_arn = "arn:aws:states:${local.region}:${local.account}:execution:${local.name}:*"
  # The managed image already contains Node 26 and npm in n's cache. Selecting
  # nodejs:26 runs `n`, copying the entire tree (~50s per build). Use the cached
  # binaries directly, and fail closed if AWS changes the image layout/version.
  runtime_setup_commands = [
    "test -n \"$NODE_26_VERSION\" && test -x \"/usr/local/n/versions/node/$NODE_26_VERSION/bin/node\"",
    "export PATH=\"/usr/local/n/versions/node/$NODE_26_VERSION/bin:$PATH\"",
    "node -e 'if (process.versions.node.split(\".\")[0] !== \"26\") throw new Error(\"EXPECTED_NODE_26\")'"
  ]
}

resource "aws_s3_bucket" "bundle" {
  bucket        = "${local.name}-${local.account}"
  force_destroy = false
}
resource "aws_s3_bucket_public_access_block" "bundle" {
  bucket                  = aws_s3_bucket.bundle.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "bundle" {
  bucket = aws_s3_bucket.bundle.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "bundle" {
  bucket = aws_s3_bucket.bundle.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
resource "aws_s3_bucket_policy" "bundle" {
  bucket = aws_s3_bucket.bundle.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Deny", Principal = "*", Action = "s3:*",
    Resource  = [aws_s3_bucket.bundle.arn, "${aws_s3_bucket.bundle.arn}/*"],
    Condition = { Bool = { "aws:SecureTransport" = "false" } }
  }] })
}
resource "aws_s3_object" "operator" {
  # Bootstrap only: subsequent reviewed operator versions are uploaded by CD.
  lifecycle {
    ignore_changes = [source, source_hash]
  }
  bucket      = aws_s3_bucket.bundle.id
  key         = "operator.zip"
  source      = var.operator_zip
  source_hash = filesha256(var.operator_zip)
  depends_on  = [aws_s3_bucket_versioning.bundle]
}
resource "aws_dynamodb_table" "maintenance" {
  name         = local.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  attribute {
    name = "pk"
    type = "S"
  }
  ttl {
    attribute_name = "expires_at"
    enabled        = true # Run metadata only. The global lock NEVER expires by time.
  }
}

# Install this ceiling on the existing worker role using the operator session.
# GitHub may edit its normal policy but cannot remove or bypass this boundary.
resource "aws_iam_policy" "worker_boundary" {
  name = "videoq-worker-runtime-boundary"
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ssm:GetParameter", "ssm:GetParameters"], Resource = var.retire_neon_maintenance ? [
      "arn:aws:ssm:${local.region}:${local.account}:parameter/videoq/prod/app"
      ] : [
      local.parameter["worker"], "arn:aws:ssm:${local.region}:${local.account}:parameter/videoq/prod/app"
    ] },
    { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:SendMessage"],
    Resource = [for name in ["videoq-worker-prod", "videoq-worker-search-prod", "videoq-worker-account-prod"] : "arn:aws:sqs:${local.region}:${local.account}:${name}"] },
    { Effect = "Allow", Action = ["kms:Decrypt"], Resource = "arn:aws:kms:${local.region}:${local.account}:key/*",
    Condition = { StringEquals = { "kms:ViaService" = "ssm.${local.region}.amazonaws.com" } } },
    { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
    Resource = [for name in ["videoq-worker-prod", "videoq-worker-search-prod", "videoq-worker-account-prod"] : "arn:aws:logs:${local.region}:${local.account}:log-group:/aws/lambda/${name}:*"] },
    { Effect = "Allow", Action = ["sts:GetWebIdentityToken"], Resource = "*", Condition = {
      "ForAllValues:StringEquals" = { "sts:IdentityTokenAudience" = ["https://openrouter.ai"] },
      StringEquals                = { "sts:SigningAlgorithm" = "RS256" }, NumericLessThanEquals = { "sts:DurationSeconds" = "900" }
    } }
  ] })
}
resource "aws_cloudwatch_log_group" "build" {
  for_each          = local.historical_projects
  name              = "/aws/codebuild/${each.value}"
  retention_in_days = 14
}
resource "aws_iam_role" "build" {
  for_each = local.projects
  name     = each.value
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "codebuild.amazonaws.com" }, Action = "sts:AssumeRole",
    Condition = { StringEquals = { "aws:SourceAccount" = local.account }, ArnEquals = {
      "aws:SourceArn" = "arn:aws:codebuild:${local.region}:${local.account}:project/${each.value}"
    } }
  }] })
}
resource "aws_iam_role_policy" "build" {
  for_each = local.projects
  name     = "fixed-database-job"
  role     = aws_iam_role.build[each.key].id
  policy = jsonencode({ Version = "2012-10-17", Statement = concat([
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.build[each.key].arn}:*" },
    { Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion"], Resource = aws_s3_object.operator.arn },
    { Effect = "Allow", Action = ["s3:GetBucketLocation", "s3:GetBucketVersioning"], Resource = aws_s3_bucket.bundle.arn },
    ], var.retire_neon_maintenance ? [] : [
    { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = each.key == "rotation" ? concat(values(local.parameter), local.protected_parameters) : [local.parameter[each.key]] }
    ], [for permission in [
      { Effect = "Allow", Action = ["ssm:PutParameter"], Resource = concat(values(local.parameter), [local.protected_parameters[1]]) },
      { Effect = "Allow", Action = ["ssm:DescribeParameters"], Resource = "*" },
      { Effect = "Allow", Action = ["lambda:GetFunctionConfiguration", "lambda:UpdateFunctionConfiguration"], Resource = [for name in ["videoq-worker-prod", "videoq-worker-search-prod", "videoq-worker-account-prod"] : "arn:aws:lambda:${local.region}:${local.account}:function:${name}"] },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:UpdateItem"], Resource = aws_dynamodb_table.maintenance.arn,
      Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["run#*"] } } }
      ] : permission if each.key == "rotation"], [for permission in [
      { Effect = "Allow", Action = ["lambda:ListEventSourceMappings"], Resource = "*" },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:ConditionCheckItem"], Resource = aws_dynamodb_table.maintenance.arn,
      Condition = { "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["maintenance"] } } }
      ] : permission if each.key == "rotation" && var.enable_cutover_hold], [for permission in [
      { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = "arn:aws:ssm:${local.region}:${local.account}:parameter/videoq/security/prod/cutover-control" },
      { Effect = "Allow", Action = ["states:GetExecutionHistory"], Resource = "${trimsuffix(local.execution_arn, "*")}db-*" },
      { Effect = "Allow", Action = ["lambda:UpdateEventSourceMapping"], Resource = "arn:aws:lambda:${local.region}:${local.account}:event-source-mapping:*",
      Condition = { ArnEquals = { "lambda:FunctionArn" = [for name in ["videoq-worker-prod", "videoq-worker-search-prod", "videoq-worker-account-prod"] : "arn:aws:lambda:${local.region}:${local.account}:function:${name}"] } } }
      ] : permission if each.key == "rotation" && var.enable_cutover_consumer_control], [for permission in [
      { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = "arn:aws:ssm:${local.region}:${local.account}:parameter/videoq/security/prod/d1-migration" },
      { Effect = "Allow", Action = ["dynamodb:GetItem"], Resource = aws_dynamodb_table.maintenance.arn,
      Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["maintenance", "run#*"] } } }
      ] : permission if each.key == "migration" && var.enable_d1_migrations], [for permission in [
      { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = [
        "arn:aws:ssm:${local.region}:${local.account}:parameter/videoq/security/prod/d1-migration",
        "arn:aws:ssm:${local.region}:${local.account}:parameter/videoq/security/prod/smoke-identity"
      ] }
    ] : permission if each.key == "smoke" && var.enable_d1_production_smoke], each.key == "rotation" && var.enable_cutover_postwrite_recovery ? [
    { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = [
      "arn:aws:ssm:${local.region}:${local.account}:parameter/videoq/security/prod/d1-migration",
      "arn:aws:ssm:${local.region}:${local.account}:parameter/videoq/prod/app"
    ] },
    { Effect = "Allow", Action = ["s3:GetObjectVersion"], Resource = ["${aws_s3_bucket.archive[0].arn}/cutover-recovery/*"] }
    ] : [], [for permission in [
      { Effect = "Allow", Action = ["ssm:GetParameter", "ssm:PutParameter"], Resource = [
        "arn:aws:ssm:${local.region}:${local.account}:parameter/videoq/prod/app",
        "arn:aws:ssm:${local.region}:${local.account}:parameter/videoq/security/prod/worker-internal-api"
      ] }
    ] : permission if each.key == "rotation" && var.enable_cutover_final_handoff], each.key == "backup" && var.retain_verified_backups ? [
    { Effect = "Allow", Action = ["s3:PutObject", "s3:GetObjectVersion"], Resource = "${aws_s3_bucket.archive[0].arn}/verified/*" }
  ] : []) })
}
resource "aws_codebuild_project" "job" {
  lifecycle {
    ignore_changes = [source_version, tags["ReviewedSource"]]
  }
  for_each               = local.projects
  name                   = each.value
  service_role           = aws_iam_role.build[each.key].arn
  build_timeout          = each.key == "migration" ? 15 : 40
  queued_timeout         = 30
  concurrent_build_limit = 1
  artifacts { type = "NO_ARTIFACTS" }
  environment {
    compute_type                = each.key == "rotation" && var.enable_cutover_postwrite_recovery ? "BUILD_GENERAL1_MEDIUM" : "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:7.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
    privileged_mode             = each.key == "backup"
    environment_variable {
      name  = "VIDEOQ_CUTOVER_CONSUMER_CONTROL"
      value = each.key == "rotation" && var.enable_cutover_consumer_control ? "true" : "false"
    }
    environment_variable {
      name  = "MAINTENANCE_TABLE"
      value = aws_dynamodb_table.maintenance.name
    }
    environment_variable {
      name  = "VIDEOQ_CUTOVER_FINAL_HANDOFF"
      value = each.key == "rotation" && var.enable_cutover_final_handoff ? "true" : "false"
    }
    environment_variable {
      name  = "VIDEOQ_CUTOVER_POSTWRITE_RECOVERY"
      value = each.key == "rotation" && var.enable_cutover_postwrite_recovery ? "true" : "false"
    }
    environment_variable {
      name  = "VIDEOQ_D1_PRODUCTION_SMOKE"
      value = each.key == "smoke" && var.enable_d1_production_smoke ? "true" : "false"
    }
    environment_variable {
      name  = "VIDEOQ_RETAIN_BACKUP"
      value = each.key == "backup" && var.retain_verified_backups ? "true" : "false"
    }
    environment_variable {
      name  = "VIDEOQ_EXPORT_D1_FROM_BACKUP"
      value = each.key == "backup" && var.export_d1_from_verified_backup ? "true" : "false"
    }
  }
  source {
    type     = "S3"
    location = "${aws_s3_bucket.bundle.bucket}/${aws_s3_object.operator.key}"
    buildspec = jsonencode({ version = "0.2", phases = {
      install = { "runtime-versions" = { python = "3.12" }, commands = concat(local.runtime_setup_commands, ["node infra/db-maintenance/runtime/setup-job.cjs"]) },
      build   = { commands = ["node infra/db-maintenance/runtime/job.cjs"] }
    } })
  }
  source_version = aws_s3_object.operator.version_id
  logs_config {
    cloudwatch_logs {
      group_name = aws_cloudwatch_log_group.build[each.key].name
    }
  }
  tags       = { ReviewedSource = var.source_commit }
  depends_on = [aws_iam_role_policy.build]
}

resource "aws_iam_role" "state_machine" {
  name = "${local.name}-states"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "states.amazonaws.com" }, Action = "sts:AssumeRole",
    Condition = { StringEquals = { "aws:SourceAccount" = local.account }, ArnLike = {
      "aws:SourceArn" = "arn:aws:states:${local.region}:${local.account}:stateMachine:${local.name}"
    } }
  }] })
}
resource "aws_iam_role_policy" "state_machine" {
  name = "fixed-project-orchestration"
  role = aws_iam_role.state_machine.id
  policy = jsonencode({ Version = "2012-10-17", Statement = concat([
    { Effect = "Allow", Action = ["codebuild:StartBuild"], Resource = local.project_arns },
    { Effect = "Allow", Action = ["codebuild:BatchGetBuilds", "codebuild:StopBuild"], Resource = local.project_arns },
    { Effect = "Allow", Action = ["events:PutTargets", "events:PutRule", "events:DescribeRule"], Resource = "arn:aws:events:${local.region}:${local.account}:rule/StepFunctionsGetEventForCodeBuildStartBuildRule" },
    { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:DeleteItem"], Resource = aws_dynamodb_table.maintenance.arn }
    ], var.enable_cutover_hold || var.enable_d1_resource_hold ? [{
      Effect    = "Allow", Action = ["dynamodb:ConditionCheckItem"], Resource = aws_dynamodb_table.maintenance.arn,
      Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["run#*"] } }
  }] : []) })
}
resource "aws_sfn_state_machine" "maintenance" {
  lifecycle {
    ignore_changes = [definition]
  }
  name     = local.name
  type     = "STANDARD"
  role_arn = aws_iam_role.state_machine.arn
  definition = templatefile(var.retire_neon_maintenance ? "${path.module}/../state-machine.d1.asl.json.tftpl" : "${path.module}/../state-machine.asl.json.tftpl", merge(
    { table = aws_dynamodb_table.maintenance.name },
    { for purpose, project in aws_codebuild_project.job : "project_${purpose}" => project.name },
    { project_deploy = aws_codebuild_project.deploy.name }
  ))
  depends_on = [aws_iam_role_policy.state_machine]
}

resource "aws_cloudwatch_log_group" "broker" {
  for_each          = local.historical_brokers
  name              = "/aws/lambda/videoq-db-start-${each.key}-prod"
  retention_in_days = 14
}
resource "aws_iam_role" "broker" {
  for_each = local.brokers
  name     = "videoq-db-start-${each.key}-prod"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole"
  }] })
}
resource "aws_iam_role_policy" "broker" {
  for_each = local.brokers
  name     = "start-and-observe-only"
  role     = aws_iam_role.broker[each.key].id
  policy = jsonencode({ Version = "2012-10-17", Statement = concat([
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.broker[each.key].arn}:*" },
    { Effect = "Allow", Action = ["states:StartExecution"], Resource = aws_sfn_state_machine.maintenance.arn },
    { Effect = "Allow", Action = ["states:DescribeExecution"], Resource = local.execution_arn },
    { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"], Resource = aws_dynamodb_table.maintenance.arn },
    { Effect = "Allow", Action = ["codebuild:ListBuildsForProject"], Resource = local.project_arns },
    { Effect = "Allow", Action = ["codebuild:BatchGetBuilds"], Resource = local.project_arns }
    ], each.key == "maintenance" && var.enable_cutover_hold ? [
    { Effect = "Allow", Action = ["states:GetExecutionHistory"], Resource = "${trimsuffix(local.execution_arn, "*")}db-*" }
    ] : [], each.key == "maintenance" && var.enable_cutover_consumer_control ? [
    { Effect = "Allow", Action = ["states:RedriveExecution", "states:DescribeStateMachineForExecution"], Resource = "${trimsuffix(local.execution_arn, "*")}db-*" }
  ] : []) })
}
resource "aws_lambda_function" "broker" {
  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
  for_each         = local.brokers
  function_name    = "videoq-db-start-${each.key}-prod"
  role             = aws_iam_role.broker[each.key].arn
  filename         = var.broker_zip
  source_code_hash = filebase64sha256(var.broker_zip)
  handler          = "broker.handler"
  runtime          = "nodejs22.x"
  timeout          = 60
  memory_size      = 256
  publish          = true
  environment {
    variables = {
      MAINTENANCE_TABLE                = aws_dynamodb_table.maintenance.name
      STATE_MACHINE_ARN                = aws_sfn_state_machine.maintenance.arn
      BUILD_PROJECTS                   = jsonencode(values(local.all_projects))
      ALLOWED_KINDS                    = each.value
      CUTOVER_CONSUMER_CONTROL_ENABLED = each.key == "maintenance" && var.enable_cutover_consumer_control ? "true" : "false"
    }
  }
  depends_on = [aws_iam_role_policy.broker]
}
resource "aws_lambda_alias" "broker" {
  lifecycle {
    ignore_changes = [function_version]
  }
  for_each         = local.brokers
  name             = "live"
  function_name    = aws_lambda_function.broker[each.key].function_name
  function_version = aws_lambda_function.broker[each.key].version
}
resource "aws_iam_role" "scheduler" {
  count = var.retire_neon_maintenance ? 0 : 1
  name  = "${local.name}-scheduler"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "scheduler.amazonaws.com" }, Action = "sts:AssumeRole",
    Condition = { StringEquals = { "aws:SourceAccount" = local.account }, ArnEquals = {
      "aws:SourceArn" = "arn:aws:scheduler:${local.region}:${local.account}:schedule-group/default"
    } }
  }] })
}
resource "aws_iam_role_policy" "scheduler" {
  count = var.retire_neon_maintenance ? 0 : 1
  name  = "scheduled-maintenance-only"
  role  = aws_iam_role.scheduler[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = aws_lambda_alias.broker["maintenance"].arn
  }] })
}
resource "aws_scheduler_schedule" "maintenance" {
  count                        = var.retire_neon_maintenance ? 0 : 1
  name                         = local.name
  state                        = var.schedule_enabled ? "ENABLED" : "DISABLED"
  schedule_expression          = "cron(31 3 * * ? *)"
  schedule_expression_timezone = "Asia/Tokyo"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_lambda_alias.broker["maintenance"].arn
    role_arn = aws_iam_role.scheduler[0].arn
    input    = jsonencode({ action = "start", kind = "rotate" })
    retry_policy {
      maximum_event_age_in_seconds = 3600
      maximum_retry_attempts       = 2
    }
  }
  depends_on = [aws_iam_role_policy.scheduler]
}

output "invocation_functions" {
  value = { for purpose, alias in aws_lambda_alias.broker : purpose => alias.arn }
}
output "state_machine" {
  value = aws_sfn_state_machine.maintenance.arn
}
output "worker_boundary" {
  value = aws_iam_policy.worker_boundary.arn
}

# Preserve state identity when the historical singleton is made optional.
moved {
  from = aws_iam_role.scheduler
  to   = aws_iam_role.scheduler[0]
}
moved {
  from = aws_iam_role_policy.scheduler
  to   = aws_iam_role_policy.scheduler[0]
}
moved {
  from = aws_scheduler_schedule.maintenance
  to   = aws_scheduler_schedule.maintenance[0]
}
