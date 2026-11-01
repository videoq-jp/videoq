# ── Dead Letter Queue ─────────────────────────────────────────────────
# Messages that exceed the maximum receive count (failed tasks) are forwarded here.
resource "aws_sqs_queue" "dlq" {
  name                      = local.names.worker_dlq
  message_retention_seconds = 1209600 # 14 days
  sqs_managed_sse_enabled   = true

  lifecycle {
    prevent_destroy = true
  }
}

# ── Main worker queue ───────────────────────────────────────────────────
# Allow processing and throttling retries per the Lambda/SQS recommendation:
# https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html
# visibility_timeout >= 6 * Lambda timeout (batching window is zero).
# receive_wait_time=20s enables long polling to reduce empty polls.
resource "aws_sqs_queue" "main" {
  name                       = local.names.worker
  visibility_timeout_seconds = var.sqs_visibility_timeout_seconds
  message_retention_seconds  = 345600 # 4 days
  sqs_managed_sse_enabled    = true
  receive_wait_time_seconds  = 20

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.sqs_max_receive_count
  })

  lifecycle {
    prevent_destroy = true
  }
}

# Signatures authenticate requests; this separate deny also requires encryption
# in transit for every principal, including identities in this AWS account.
resource "aws_sqs_queue_policy" "require_tls" {
  for_each = {
    main = aws_sqs_queue.main
    dlq  = aws_sqs_queue.dlq
  }

  queue_url = each.value.url
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "sqs:*"
      Resource  = each.value.arn
      Condition = {
        Bool = { "aws:SecureTransport" = "false" }
      }
    }]
  })
}
