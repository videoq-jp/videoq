resource "aws_sns_topic" "operations" {
  name = "${local.name_prefix}-operations-${var.env_name}"
}

resource "aws_sns_topic_subscription" "operations_email" {
  count = var.operations_alert_email == "" ? 0 : 1

  topic_arn = aws_sns_topic.operations.arn
  protocol  = "email"
  endpoint  = var.operations_alert_email

  # Confirm the new address before retiring the prior alert subscription.
  lifecycle {
    create_before_destroy = true
  }
}

# Lambda creates this group implicitly on first invocation. Declarative import
# adopts an existing group on the first apply and is a no-op once it is managed.
import {
  to = aws_cloudwatch_log_group.worker
  id = "/aws/lambda/${local.names.worker}"
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/lambda/${local.names.worker}"
  retention_in_days = var.lambda_log_retention_days

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_errors" {
  alarm_name          = "${local.names.worker}-errors"
  alarm_description   = "Worker Lambda returned one or more errors in five minutes."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]

  dimensions = {
    FunctionName = aws_lambda_function.worker.function_name
  }
}

# Unlike Lambda Errors, this includes failures returned in batchItemFailures.
# FailedInvokeEventCount is timestamped at completion, before the SQS retry wait.
resource "aws_cloudwatch_metric_alarm" "worker_job_failures" {
  alarm_name          = "${local.names.worker}-job-failures"
  alarm_description   = "One or more worker SQS events failed in five minutes, including partial batch failures. Messages may still be waiting for retry."
  namespace           = "AWS/Lambda"
  metric_name         = "FailedInvokeEventCount"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]

  # Event-source metrics use this dimension, not FunctionName.
  dimensions = {
    EventSourceMappingUUID = aws_lambda_event_source_mapping.worker.uuid
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_throttles" {
  alarm_name          = "${local.names.worker}-throttles"
  alarm_description   = "Worker Lambda was throttled."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]

  dimensions = {
    FunctionName = aws_lambda_function.worker.function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_duration" {
  alarm_name        = "${local.names.worker}-duration"
  alarm_description = "A completed Worker Lambda invocation reached at least 80% of its timeout. Duration is reported after execution."
  namespace         = "AWS/Lambda"
  metric_name       = "Duration"
  statistic         = "Maximum"
  # Lambda timestamps metrics at invocation start but emits them on completion.
  # Cover the full 15-minute timeout, including sparse, single-job workloads.
  period              = 900
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = var.worker_lambda_timeout_seconds * 1000 * 0.8
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]

  dimensions = {
    FunctionName = aws_lambda_function.worker.function_name
  }
}

moved {
  from = aws_cloudwatch_metric_alarm.worker_queue_age
  to   = aws_cloudwatch_metric_alarm.worker_queue_waiting
}

resource "aws_cloudwatch_metric_alarm" "worker_queue_waiting" {
  alarm_name        = "${local.names.worker}-queue-waiting"
  alarm_description = "Worker jobs remained available for processing across five consecutive one-minute samples. In-flight jobs are excluded."
  namespace         = "AWS/SQS"
  # Message age also includes in-flight work; use sustained visible backlog.
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]

  dimensions = {
    QueueName = aws_sqs_queue.main.name
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_queue_depth" {
  alarm_name          = "${local.names.worker}-queue-depth"
  alarm_description   = "At least ten media jobs are waiting to be processed."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 10
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]

  dimensions = {
    QueueName = aws_sqs_queue.main.name
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_dlq_depth" {
  alarm_name          = "${local.names.worker_dlq}-messages"
  alarm_description   = "A media job reached the dead-letter queue."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]

  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
  }
}
