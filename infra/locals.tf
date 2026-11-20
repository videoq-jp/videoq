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
  common_lambda_environment = merge({
    APP_PARAM_NAME                 = aws_ssm_parameter.app.name
    USE_S3_STORAGE                 = "true"
    SQS_QUEUE_NAME                 = aws_sqs_queue.main.name
    SQS_QUEUE_URL                  = aws_sqs_queue.main.id
    SQS_MEDIA_QUEUE_URL            = aws_sqs_queue.main.url
    SQS_SEARCH_QUEUE_URL           = aws_sqs_queue.group["search"].url
    SQS_ACCOUNT_QUEUE_URL          = aws_sqs_queue.group["account"].url
    FRONTEND_URL                   = "https://videoq.jp"
    AI_PROVIDER                    = "workers-ai"
    OPENAI_BASE_URL                = "https://videoq.jp/api/internal/workers-ai"
    EMBEDDING_BASE_URL             = "https://videoq.jp/api/internal/workers-ai"
    EMBEDDING_PROFILE              = "embeddinggemma2"
    EMBEDDING_MODEL                = "@cf/google/embeddinggemma-2"
    WHISPER_BACKEND                = var.worker_whisper_backend
    WORKERS_AI_BASE_URL            = var.workers_ai_federation_endpoint
    WORKERS_AI_FEDERATION_AUDIENCE = "https://videoq.jp/api/internal/workers-ai"
    ENABLE_HEAVY_PIPELINE          = "true"
    }, var.env_name == "prod" ? {
    # Production persists through the signed API and must not retain a Neon
    # credential reference after the D1 handoff.
    DEPLOYMENT_EDITION         = "cloud"
    PERSISTENCE_BACKEND        = "d1"
    WORKER_INTERNAL_API_ORIGIN = "https://videoq.jp"
    } : {
    DB_PARAM_NAME = "/${local.name_prefix}/${var.env_name}/worker-db"
    PGSSLROOTCERT = "/etc/pki/tls/certs/ca-bundle.crt"
  })

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
