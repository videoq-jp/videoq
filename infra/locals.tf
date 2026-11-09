locals {
  # Keep in sync with worker_python.job_execution.JOB_LEASE_SECONDS. A lease
  # may be claimed late in an invocation; allow its full lifetime plus a margin
  # before a timed-out message becomes visible and consumes another attempt.
  worker_job_lease_seconds          = 900
  worker_lease_retry_margin_seconds = 60
  name_prefix                       = "videoq"
  names = {
    worker        = "${local.name_prefix}-worker-${var.env_name}"
    worker_dlq    = "${local.name_prefix}-worker-dlq-${var.env_name}"
    worker_policy = "${local.name_prefix}-worker-${var.env_name}-policy"
  }

  lambda_basic_execution_policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
  common_lambda_environment = {
    DB_PARAM_NAME                   = "/${local.name_prefix}/${var.env_name}/worker-db"
    APP_PARAM_NAME                  = aws_ssm_parameter.app.name
    PGSSLROOTCERT                   = "/etc/pki/tls/certs/ca-bundle.crt"
    USE_S3_STORAGE                  = "true"
    SQS_QUEUE_NAME                  = aws_sqs_queue.main.name
    SQS_QUEUE_URL                   = aws_sqs_queue.main.id
    SQS_MEDIA_QUEUE_URL             = aws_sqs_queue.main.url
    SQS_SEARCH_QUEUE_URL            = aws_sqs_queue.group["search"].url
    SQS_ACCOUNT_QUEUE_URL           = aws_sqs_queue.group["account"].url
    FRONTEND_URL                    = "https://videoq.jp"
    OPENAI_BASE_URL                 = "https://openrouter.ai/api/v1"
    EMBEDDING_MODEL                 = "openai/text-embedding-3-small"
    WHISPER_BACKEND                 = "openrouter"
    OPENROUTER_FEDERATION_POLICY_ID = var.openrouter_federation_policy_id
    OPENROUTER_FEDERATION_AUDIENCE  = var.openrouter_federation_audience
    ENABLE_HEAVY_PIPELINE           = "true"
  }

  ecr_lifecycle_policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 1 day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 2
        description  = "Keep only the last 2 tagged images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 2
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}
