variable "aws_region" {
  description = "リソースをデプロイする AWS リージョン"
  type        = string
  default     = "ap-northeast-1"
}

variable "env_name" {
  description = "環境名 (リソース命名に使用)"
  type        = string
  default     = "prod"
}

variable "worker_lambda_memory_mb" {
  description = "Worker Lambda のメモリサイズ (MB) (ffmpeg + AI 推論でメモリを多く使う)"
  type        = number
  default     = 5120
}

variable "worker_lambda_timeout_seconds" {
  description = "Worker Lambda のタイムアウト (秒) (Lambda 最大 15 分)"
  type        = number
  default     = 900

  validation {
    condition     = var.worker_lambda_timeout_seconds >= 1 && var.worker_lambda_timeout_seconds <= 900 && floor(var.worker_lambda_timeout_seconds) == var.worker_lambda_timeout_seconds
    error_message = "Lambda timeout must be an integer between 1 and 900 seconds."
  }
}

variable "sqs_visibility_timeout_seconds" {
  description = "SQS の visibility timeout (秒)。Lambda の6倍以上、かつ実行リース失効後に再試行できる長さ。"
  type        = number
  default     = 5400

  validation {
    condition = (
      var.sqs_visibility_timeout_seconds >= max(
        6 * var.worker_lambda_timeout_seconds,
        local.worker_job_lease_seconds + var.worker_lambda_timeout_seconds + local.worker_lease_retry_margin_seconds,
      ) && var.sqs_visibility_timeout_seconds <= 43200 && floor(var.sqs_visibility_timeout_seconds) == var.sqs_visibility_timeout_seconds
    )
    error_message = "SQS visibility timeout must be an integer at least max(6 * Lambda timeout, 900 + Lambda timeout + 60) and at most 43200 seconds."
  }
}

variable "sqs_max_receive_count" {
  description = "SQS のメッセージ最大受信回数 (超過で DLQ へ送信)"
  type        = number
  default     = 5

  validation {
    condition     = var.sqs_max_receive_count >= 5 && var.sqs_max_receive_count <= 1000 && floor(var.sqs_max_receive_count) == var.sqs_max_receive_count
    error_message = "SQS max receive count must be an integer between 5 and 1000."
  }
}

variable "lambda_log_retention_days" {
  description = "Worker Lambda の CloudWatch Logs 保持日数"
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.lambda_log_retention_days)
    error_message = "lambda_log_retention_days must be a CloudWatch Logs supported retention value."
  }
}

variable "operations_alert_email" {
  description = "Lambda/SQS運用アラートの通知先（空文字ならSNS email subscriptionを作らない）"
  type        = string
  default     = ""
}

variable "image_tag" {
  description = "Lambda が参照する ECR コンテナイメージのタグ"
  type        = string
  default     = "latest"
}

variable "manage_openai_project" {
  description = "OpenAI プロジェクトのガバナンスを Terraform で管理するか (true で有効化。要 OPENAI_ADMIN_KEY)"
  type        = bool
  default     = true
}

variable "openai_allowed_models" {
  description = "OpenAI プロジェクトで許可するモデル ID の一覧 (videoq が実際に使うモデルのみ)"
  type        = list(string)
  default     = ["text-embedding-3-small", "gpt-4o-mini", "gpt-4.1-mini", "gpt-6-luna", "whisper-1"]
}

variable "openai_spend_alert_email" {
  description = "月次スペンドアラートの通知先メールアドレス (空文字でアラート無効)"
  type        = string
  default     = ""
}

variable "openai_spend_threshold_usd" {
  description = "月次スペンドアラートのしきい値 (USD)"
  type        = number
  default     = 50
}

variable "worker_visual_enabled" {
  description = "Prepare coarse and dense frame caches for uploaded-video visual Q&A; enabled by default."
  type        = bool
  default     = true
}

variable "openrouter_federation_policy_id" {
  description = "OpenRouter inference federation policy for the Lambda worker (non-secret); empty retains explicit key compatibility"
  type        = string
  default     = ""
}

variable "openrouter_federation_audience" {
  description = "Audience registered in the OpenRouter workload identity policy"
  type        = string
  default     = "https://openrouter.ai"
}

variable "worker_media_maximum_concurrency" {
  type    = number
  default = 10
  validation {
    condition     = var.worker_media_maximum_concurrency >= 2 && var.worker_media_maximum_concurrency <= 1000 && floor(var.worker_media_maximum_concurrency) == var.worker_media_maximum_concurrency
    error_message = "Media maximum concurrency must be an integer from 2 to 1000."
  }
}

variable "worker_groups" {
  description = "Independent search/account consumers; all three consumers share code and the existing workload identity."
  type = map(object({
    memory_mb           = number
    timeout_seconds     = number
    storage_mb          = number
    maximum_concurrency = number
  }))
  default = {
    search  = { memory_mb = 2048, timeout_seconds = 900, storage_mb = 512, maximum_concurrency = 4 }
    account = { memory_mb = 1024, timeout_seconds = 900, storage_mb = 512, maximum_concurrency = 2 }
  }
  validation {
    condition = toset(keys(var.worker_groups)) == toset(["search", "account"]) && alltrue([
      for config in values(var.worker_groups) : (
        config.memory_mb >= 128 && config.memory_mb <= 10240 && floor(config.memory_mb) == config.memory_mb &&
        config.timeout_seconds >= 1 && config.timeout_seconds <= 900 && floor(config.timeout_seconds) == config.timeout_seconds &&
        config.storage_mb >= 512 && config.storage_mb <= 10240 && floor(config.storage_mb) == config.storage_mb &&
        config.maximum_concurrency >= 2 && config.maximum_concurrency <= 1000 && floor(config.maximum_concurrency) == config.maximum_concurrency
      )
    ])
    error_message = "Exactly search/account must be configured with integer Lambda memory (128–10240), storage (512–10240), timeout (1–900), and concurrency (2–1000)."
  }
}
