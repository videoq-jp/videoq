resource "aws_iam_role" "worker" {
  name               = local.names.worker
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  # The AWS operator owns this ceiling independently of routine GitHub applies.
  lifecycle {
    ignore_changes = [permissions_boundary]
  }
}

resource "aws_iam_role_policy_attachment" "worker_basic_execution" {
  role       = aws_iam_role.worker.name
  policy_arn = local.lambda_basic_execution_policy_arn
}

data "aws_iam_policy_document" "worker_permissions" {
  dynamic "statement" {
    for_each = var.openrouter_federation_policy_id != "" ? [1] : []
    content {
      effect    = "Allow"
      actions   = ["sts:GetWebIdentityToken"]
      resources = ["*"]
      condition {
        test     = "ForAllValues:StringEquals"
        variable = "sts:IdentityTokenAudience"
        values   = [var.openrouter_federation_audience]
      }
      condition {
        test     = "StringEquals"
        variable = "sts:SigningAlgorithm"
        values   = ["RS256"]
      }
      condition {
        test     = "NumericLessThanEquals"
        variable = "sts:DurationSeconds"
        values   = ["900"]
      }
    }
  }

  statement {
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
    ]
    resources = [
      "${trimsuffix(aws_ssm_parameter.db.arn, "/db")}/worker-db",
      aws_ssm_parameter.app.arn,
    ]
  }

  # Decrypt SecureString values encrypted with the default aws/ssm key.
  statement {
    effect = "Allow"
    actions = [
      "kms:Decrypt",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.aws_region}.amazonaws.com"]
    }
  }

  statement {
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:SendMessage",
    ]
    resources = [aws_sqs_queue.main.arn]
  }
}

resource "aws_iam_role_policy" "worker" {
  name   = local.names.worker_policy
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker_permissions.json
}

resource "aws_lambda_function" "worker" {
  function_name = local.names.worker
  role          = aws_iam_role.worker.arn
  package_type  = "Image"
  image_uri     = "${aws_ecr_repository.worker.repository_url}:${var.image_tag}"
  architectures = ["arm64"]
  memory_size   = var.worker_lambda_memory_mb
  timeout       = var.worker_lambda_timeout_seconds

  depends_on = [aws_cloudwatch_log_group.worker]

  # Terraform bootstraps the image; CD owns subsequent immutable image releases.
  # An infrastructure plan/apply must not revert the deployed SHA to :latest.
  lifecycle {
    ignore_changes = [image_uri, environment[0].variables["DB_CREDENTIAL_GENERATION"]]
  }

  ephemeral_storage {
    size = 5120
  }

  environment {
    variables = merge(local.common_lambda_environment, {
      MEDIA_PROCESS_MEMORY_LIMIT_MB           = "2048"
      MEDIA_PROCESS_CPU_TIME_LIMIT_SECONDS    = "300"
      FFMPEG_PROCESS_TIMEOUT_SECONDS          = "600"
      MEDIA_PROCESS_OUTPUT_FILE_SIZE_LIMIT_MB = "1024"
      VIDEO_VISUAL_ENABLED                    = tostring(var.worker_visual_enabled)
    })
  }
}

resource "aws_lambda_event_source_mapping" "worker" {
  event_source_arn        = aws_sqs_queue.main.arn
  function_name           = aws_lambda_function.worker.arn
  batch_size              = 1
  function_response_types = ["ReportBatchItemFailures"]

  # Partial batch failures return normally; opt in to per-event failure metrics.
  metrics_config {
    metrics = ["EventCount"]
  }

  scaling_config {
    maximum_concurrency = 10
  }
}
