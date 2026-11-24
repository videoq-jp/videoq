# Retained recovery data and media permissions after verified Cloudflare cutover.
# No legacy execution resource is declared here, so flags cannot recreate it.
variable "retire_aws_maintenance" {
  type        = bool
  default     = false
  description = "Explicit reviewed acknowledgement of verified Cloudflare cutover, idle AWS ownership and preserved recovery records."
  validation {
    condition     = var.retire_aws_maintenance
    error_message = "Apply this retained-only graph only after verified Cloudflare cutover and evidence preservation."
  }
}
variable "provision_backup_archive" {
  type    = bool
  default = true
  validation {
    condition     = var.provision_backup_archive
    error_message = "Existing private database archive versions must remain provisioned."
  }
}
locals {
  account             = "257240362763"
  region              = "ap-northeast-1"
  historical_projects = { for purpose in ["rotation", "migration", "backup", "smoke", "audit"] : purpose => "videoq-db-${purpose}-prod" }
  historical_brokers  = toset(["maintenance", "migration", "backup", "smoke", "deploy"])
}
resource "aws_iam_policy" "worker_boundary" {
  name = "videoq-worker-runtime-boundary"
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ssm:GetParameter", "ssm:GetParameters"], Resource = [
      "arn:aws:ssm:${local.region}:${local.account}:parameter/videoq/prod/app"
    ] },
    { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:SendMessage"],
    Resource = [for name in ["videoq-worker-prod", "videoq-worker-search-prod", "videoq-worker-account-prod"] : "arn:aws:sqs:${local.region}:${local.account}:${name}"] },
    { Effect = "Allow", Action = ["kms:Decrypt"], Resource = "arn:aws:kms:${local.region}:${local.account}:key/*",
    Condition = { StringEquals = { "kms:ViaService" = "ssm.${local.region}.amazonaws.com" } } },
    { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
    Resource = [for name in ["videoq-worker-prod", "videoq-worker-search-prod", "videoq-worker-account-prod"] : "arn:aws:logs:${local.region}:${local.account}:log-group:/aws/lambda/${name}:*"] }
  ] })
}

resource "aws_cloudwatch_log_group" "build" {
  for_each          = local.historical_projects
  name              = "/aws/codebuild/${each.value}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "broker" {
  for_each          = local.historical_brokers
  name              = "/aws/lambda/videoq-db-start-${each.key}-prod"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "deploy" {
  name              = "/aws/codebuild/videoq-db-deploy-prod"
  retention_in_days = 14
}
output "invocation_functions" { value = {} }
output "state_machine" { value = null }
output "worker_boundary" { value = aws_iam_policy.worker_boundary.arn }
