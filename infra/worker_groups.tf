# The original worker/queue remains the media consumer and drains pre-split jobs.
# Keep its resource address, name and DLQ intact during migration.
locals {
  worker_groups = var.worker_groups
}

resource "aws_sqs_queue" "group_dlq" {
  for_each                  = local.worker_groups
  name                      = "${local.name_prefix}-worker-${each.key}-dlq-${var.env_name}"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_sqs_queue" "group" {
  for_each = local.worker_groups
  name     = "${local.name_prefix}-worker-${each.key}-${var.env_name}"
  visibility_timeout_seconds = max(
    each.value.timeout_seconds * 6,
    local.worker_job_lease_seconds + each.value.timeout_seconds + local.worker_lease_retry_margin_seconds,
  )
  message_retention_seconds = 345600
  sqs_managed_sse_enabled   = true
  receive_wait_time_seconds = 20
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.group_dlq[each.key].arn
    maxReceiveCount     = var.sqs_max_receive_count
  })
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_sqs_queue_policy" "group_require_tls" {
  for_each = merge(
    { for key, queue in aws_sqs_queue.group : key => queue },
    { for key, queue in aws_sqs_queue.group_dlq : "${key}_dlq" => queue },
  )
  queue_url = each.value.url
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "sqs:*"
      Resource  = each.value.arn
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

resource "aws_cloudwatch_log_group" "group" {
  for_each          = local.worker_groups
  name              = "/aws/lambda/${local.name_prefix}-worker-${each.key}-${var.env_name}"
  retention_in_days = var.lambda_log_retention_days
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_lambda_function" "group" {
  for_each      = local.worker_groups
  function_name = "${local.name_prefix}-worker-${each.key}-${var.env_name}"
  role          = aws_iam_role.worker.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.worker.repository_url}:${var.image_tag}"
  architectures = ["arm64"]
  memory_size   = each.value.memory_mb
  timeout       = each.value.timeout_seconds
  depends_on    = [aws_cloudwatch_log_group.group, aws_iam_role_policy.worker]
  lifecycle {
    ignore_changes = [image_uri, environment[0].variables["DB_CREDENTIAL_GENERATION"]]
  }
  ephemeral_storage {
    size = each.value.storage_mb
  }
  environment {
    variables = merge(local.common_lambda_environment, {
      WORKER_JOB_GROUP     = each.key
      VIDEO_VISUAL_ENABLED = tostring(var.worker_visual_enabled)
    })
  }
}

resource "aws_lambda_event_source_mapping" "group" {
  for_each                = local.worker_groups
  event_source_arn        = aws_sqs_queue.group[each.key].arn
  function_name           = aws_lambda_function.group[each.key].arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]
  metrics_config {
    metrics = ["EventCount"]
  }
  scaling_config {
    maximum_concurrency = each.value.maximum_concurrency
  }
}
