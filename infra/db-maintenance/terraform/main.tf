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
variable "schedule_enabled" {
  type    = bool
  default = false # Enable only after successful production verification/cutover.
}

locals {
  account  = "257240362763"
  region   = "ap-northeast-1"
  name     = "videoq-db-maintenance-prod"
  projects = { for purpose in ["rotation", "migration", "backup", "smoke", "audit"] : purpose => "videoq-db-${purpose}-prod" }
  brokers = {
    maintenance = "rotate,rollback,audit"
    migration   = "migration"
    backup      = "backup"
    smoke       = "smoke"
  }
  profiles  = jsondecode(file("${path.module}/../../../.github/scripts/neon-profiles.json"))
  parameter = { for name, profile in local.profiles : name => "arn:aws:ssm:${local.region}:${local.account}:parameter${profile.parameter}" }
  protected_parameters = [
    "arn:aws:ssm:${local.region}:${local.account}:parameter/videoq/security/prod/db-admin",
    "arn:aws:ssm:${local.region}:${local.account}:parameter/videoq/security/prod/db-rotation",
    "arn:aws:ssm:${local.region}:${local.account}:parameter/videoq/security/prod/hyperdrive-credentials",
  ]
  project_arns  = [for name in values(local.projects) : "arn:aws:codebuild:${local.region}:${local.account}:project/${name}"]
  execution_arn = "arn:aws:states:${local.region}:${local.account}:execution:${local.name}:*"
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
    { Effect = "Allow", Action = ["ssm:GetParameter", "ssm:GetParameters"], Resource = [
      local.parameter["worker"], "arn:aws:ssm:${local.region}:${local.account}:parameter/videoq/prod/app"
    ] },
    { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:SendMessage"],
    Resource = "arn:aws:sqs:${local.region}:${local.account}:videoq-worker-prod" },
    { Effect = "Allow", Action = ["kms:Decrypt"], Resource = "arn:aws:kms:${local.region}:${local.account}:key/*",
    Condition = { StringEquals = { "kms:ViaService" = "ssm.${local.region}.amazonaws.com" } } },
    { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
    Resource = "arn:aws:logs:${local.region}:${local.account}:log-group:/aws/lambda/videoq-worker-prod*" },
    { Effect = "Allow", Action = ["sts:GetWebIdentityToken"], Resource = "*", Condition = {
      "ForAllValues:StringEquals" = { "sts:IdentityTokenAudience" = ["https://openrouter.ai"] },
      StringEquals                = { "sts:SigningAlgorithm" = "RS256" }, NumericLessThanEquals = { "sts:DurationSeconds" = "900" }
    } }
  ] })
}
resource "aws_cloudwatch_log_group" "build" {
  for_each          = local.projects
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
    { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = each.key == "rotation" ? concat(values(local.parameter), local.protected_parameters) : [local.parameter[each.key]] }
    ], [for permission in [
      { Effect = "Allow", Action = ["ssm:PutParameter"], Resource = concat(values(local.parameter), [local.protected_parameters[1]]) },
      { Effect = "Allow", Action = ["ssm:DescribeParameters"], Resource = "*" },
      { Effect = "Allow", Action = ["lambda:GetFunctionConfiguration", "lambda:UpdateFunctionConfiguration"], Resource = "arn:aws:lambda:${local.region}:${local.account}:function:videoq-worker-prod" },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:UpdateItem"], Resource = aws_dynamodb_table.maintenance.arn,
      Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["run#*"] } } }
  ] : permission if each.key == "rotation"]) })
}
resource "aws_codebuild_project" "job" {
  for_each               = local.projects
  name                   = each.value
  service_role           = aws_iam_role.build[each.key].arn
  build_timeout          = each.key == "migration" ? 15 : 40
  queued_timeout         = 30
  concurrent_build_limit = 1
  artifacts { type = "NO_ARTIFACTS" }
  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:7.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
    privileged_mode             = each.key == "backup"
    environment_variable {
      name  = "MAINTENANCE_TABLE"
      value = aws_dynamodb_table.maintenance.name
    }
  }
  source {
    type     = "S3"
    location = "${aws_s3_bucket.bundle.bucket}/${aws_s3_object.operator.key}"
    buildspec = jsonencode({ version = "0.2", phases = {
      install = { "runtime-versions" = { nodejs = 26, python = "3.12" }, commands = concat(
        each.key == "migration" ? [] : ["npm ci --ignore-scripts --prefix .github/operations-tools", "npm audit signatures --prefix .github/operations-tools"],
        each.key == "smoke" ? [".github/operations-tools/node_modules/.bin/playwright install --with-deps chromium"] : []
      ) },
      build = { commands = ["node infra/db-maintenance/runtime/job.cjs"] }
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
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["codebuild:StartBuild"], Resource = local.project_arns },
    { Effect = "Allow", Action = ["codebuild:BatchGetBuilds", "codebuild:StopBuild"], Resource = local.project_arns },
    { Effect = "Allow", Action = ["events:PutTargets", "events:PutRule", "events:DescribeRule"], Resource = "arn:aws:events:${local.region}:${local.account}:rule/StepFunctionsGetEventForCodeBuildStartBuildRule" },
    { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:DeleteItem"], Resource = aws_dynamodb_table.maintenance.arn }
  ] })
}
resource "aws_sfn_state_machine" "maintenance" {
  name     = local.name
  type     = "STANDARD"
  role_arn = aws_iam_role.state_machine.arn
  definition = templatefile("${path.module}/../state-machine.asl.json.tftpl", merge(
    { table = aws_dynamodb_table.maintenance.name },
    { for purpose, project in aws_codebuild_project.job : "project_${purpose}" => project.name }
  ))
  depends_on = [aws_iam_role_policy.state_machine]
}

resource "aws_cloudwatch_log_group" "broker" {
  for_each          = local.brokers
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
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.broker[each.key].arn}:*" },
    { Effect = "Allow", Action = ["states:StartExecution"], Resource = aws_sfn_state_machine.maintenance.arn },
    { Effect = "Allow", Action = ["states:DescribeExecution"], Resource = local.execution_arn },
    { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"], Resource = aws_dynamodb_table.maintenance.arn },
    { Effect = "Allow", Action = ["codebuild:ListBuildsForProject"], Resource = local.project_arns },
    { Effect = "Allow", Action = ["codebuild:BatchGetBuilds"], Resource = local.project_arns }
  ] })
}
resource "aws_lambda_function" "broker" {
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
      MAINTENANCE_TABLE = aws_dynamodb_table.maintenance.name
      STATE_MACHINE_ARN = aws_sfn_state_machine.maintenance.arn
      BUILD_PROJECTS    = jsonencode(values(local.projects))
      ALLOWED_KINDS     = each.value
    }
  }
  depends_on = [aws_iam_role_policy.broker]
}
resource "aws_lambda_alias" "broker" {
  for_each         = local.brokers
  name             = "live"
  function_name    = aws_lambda_function.broker[each.key].function_name
  function_version = aws_lambda_function.broker[each.key].version
}
resource "aws_iam_role" "scheduler" {
  name = "${local.name}-scheduler"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "scheduler.amazonaws.com" }, Action = "sts:AssumeRole",
    Condition = { StringEquals = { "aws:SourceAccount" = local.account }, ArnEquals = {
      "aws:SourceArn" = "arn:aws:scheduler:${local.region}:${local.account}:schedule-group/default"
    } }
  }] })
}
resource "aws_iam_role_policy" "scheduler" {
  name = "scheduled-maintenance-only"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Action = ["lambda:InvokeFunction"], Resource = aws_lambda_alias.broker["maintenance"].arn
  }] })
}
resource "aws_scheduler_schedule" "maintenance" {
  name                         = local.name
  state                        = var.schedule_enabled ? "ENABLED" : "DISABLED"
  schedule_expression          = "cron(31 3 * * ? *)"
  schedule_expression_timezone = "Asia/Tokyo"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_lambda_alias.broker["maintenance"].arn
    role_arn = aws_iam_role.scheduler.arn
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
