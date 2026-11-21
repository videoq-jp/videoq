# SSM Parameter Store (SecureString)
#
# External service credentials (Neon / Cloudflare R2) are set manually via CLI
# after the initial apply. Terraform manages the parameter shells only;
# `value` is ignored after create so apply never overwrites live secrets.

# Neon PostgreSQL connection string.
# Format: {"DATABASE_URL": "postgresql://...?sslmode=require"}
resource "aws_ssm_parameter" "db" {
  name        = "/${local.name_prefix}/${var.env_name}/db"
  description = "Neon PostgreSQL DATABASE_URL (pooler endpoint)"
  type        = "SecureString"
  value       = jsonencode({ DATABASE_URL = "REPLACE_ME" })

  lifecycle {
    ignore_changes  = [value]
    prevent_destroy = true
  }
}

# App secrets + R2 credentials for the SQS Lambda worker.
#
# Expected JSON keys (set via CLI / Console — not Terraform-managed values):
#
#   OPENROUTER_API_KEY        # optional fixed-key development; WIF uses a non-secret policy ID
#   WHISPER_BACKEND           # "openrouter" for the cloud service
#   USER_SECRET_ENCRYPTION_KEY
#   R2_ACCESS_KEY_ID          # Cloudflare R2 S3 API token (NOT Lambda role keys)
#   R2_SECRET_ACCESS_KEY
#   R2_BUCKET_NAME            # e.g. videoq-media-prod
#   R2_S3_ENDPOINT            # https://<accountid>.r2.cloudflarestorage.com
#   R2_S3_REGION              # usually "auto"
#
# Do NOT store R2 credentials as AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
# Lambda injects those names for the execution role; colliding names are skipped
# or break AWS API calls (SQS / SSM).
resource "aws_ssm_parameter" "app" {
  name        = "/${local.name_prefix}/${var.env_name}/app"
  description = "App secrets + R2 credentials (use R2_* key names, never AWS_ACCESS_KEY_ID)"
  type        = "SecureString"
  value = jsonencode({
    USER_SECRET_ENCRYPTION_KEY = "REPLACE_ME"
    R2_ACCESS_KEY_ID           = "REPLACE_ME"
    R2_SECRET_ACCESS_KEY       = "REPLACE_ME"
    R2_BUCKET_NAME             = "REPLACE_ME"
    R2_S3_ENDPOINT             = "REPLACE_ME"
    R2_S3_REGION               = "auto"
  })

  lifecycle {
    ignore_changes  = [value]
    prevent_destroy = true
  }
}
