terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
  }
}

# Deliberately separate from infra/: no production state, schedules, or IAM edits.
# Use an operator-owned private state path; see README.md before planning.
provider "aws" {
  region              = "ap-northeast-1"
  allowed_account_ids = ["257240362763"]
}

variable "federation_policy_id" {
  type      = string
  sensitive = true
  validation {
    condition     = length(trimspace(var.federation_policy_id)) > 0
    error_message = "The existing worker federation policy ID is required."
  }
}

variable "execution_enabled" {
  type        = bool
  default     = false
  description = "Enable only after approval for a bounded model invocation."
}

locals {
  name      = "videoq-search-evaluation-prod"
  image_uri = "257240362763.dkr.ecr.ap-northeast-1.amazonaws.com/videoq-worker-prod@sha256:58b667279155594a091141c2e689e3670ffaefd5c641840c44288f1b3f7355f0"
}

resource "aws_cloudwatch_log_group" "evaluation" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = 7
}

resource "aws_lambda_function" "evaluation" {
  function_name                  = local.name
  role                           = "arn:aws:iam::257240362763:role/videoq-worker-prod"
  package_type                   = "Image"
  image_uri                      = local.image_uri
  architectures                  = ["arm64"]
  memory_size                    = 512
  timeout                        = 300
  reserved_concurrent_executions = var.execution_enabled ? 1 : 0
  publish                        = true

  image_config {
    command = ["worker_python.search_evaluation_lambda.handler"]
  }

  ephemeral_storage {
    size = 512
  }

  environment {
    variables = {
      VIDEOQ_SEARCH_EVALUATION_ENABLED = tostring(var.execution_enabled)
      EMBEDDING_MODEL                  = "openai/text-embedding-3-small"
      EMBEDDING_PROFILE                = "openai"
      OPENAI_BASE_URL                  = "https://openrouter.ai/api/v1"
      OPENROUTER_FEDERATION_POLICY_ID  = var.federation_policy_id
      OPENROUTER_FEDERATION_AUDIENCE   = "https://openrouter.ai"
    }
  }

  depends_on = [aws_cloudwatch_log_group.evaluation]
}

output "function_arn" {
  value = aws_lambda_function.evaluation.arn
}

output "function_version" {
  value = aws_lambda_function.evaluation.version
}

output "image_uri" {
  value = local.image_uri
}
