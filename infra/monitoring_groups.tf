# Search and account consumers receive the same operational coverage as media.
resource "aws_cloudwatch_metric_alarm" "group_errors" {
  for_each            = local.worker_groups
  alarm_name          = "${local.name_prefix}-worker-${each.key}-${var.env_name}-errors"
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
    FunctionName = aws_lambda_function.group[each.key].function_name
  }
}

# Unlike Lambda Errors, this includes failures returned in batchItemFailures.
# FailedInvokeEventCount is timestamped at completion, before the SQS retry wait.
resource "aws_cloudwatch_metric_alarm" "group_job_failures" {
  for_each            = local.worker_groups
  alarm_name          = "${local.name_prefix}-worker-${each.key}-${var.env_name}-job-failures"
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
    EventSourceMappingUUID = aws_lambda_event_source_mapping.group[each.key].uuid
  }
}

resource "aws_cloudwatch_metric_alarm" "group_throttles" {
  for_each            = local.worker_groups
  alarm_name          = "${local.name_prefix}-worker-${each.key}-${var.env_name}-throttles"
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
    FunctionName = aws_lambda_function.group[each.key].function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "group_duration" {
  for_each          = local.worker_groups
  alarm_name        = "${local.name_prefix}-worker-${each.key}-${var.env_name}-duration"
  alarm_description = "A completed Worker Lambda invocation reached at least 80% of its timeout. Duration is reported after execution."
  namespace         = "AWS/Lambda"
  metric_name       = "Duration"
  statistic         = "Maximum"
  # Lambda timestamps metrics at invocation start but emits them on completion.
  # Cover the full 15-minute timeout, including sparse, single-job workloads.
  period              = 900
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = each.value.timeout_seconds * 1000 * 0.8
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]

  dimensions = {
    FunctionName = aws_lambda_function.group[each.key].function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "group_queue_waiting" {
  for_each          = local.worker_groups
  alarm_name        = "${local.name_prefix}-worker-${each.key}-${var.env_name}-queue-waiting"
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
    QueueName = aws_sqs_queue.group[each.key].name
  }
}

resource "aws_cloudwatch_metric_alarm" "group_queue_depth" {
  for_each            = local.worker_groups
  alarm_name          = "${local.name_prefix}-worker-${each.key}-${var.env_name}-queue-depth"
  alarm_description   = "At least ten worker jobs are waiting to be processed."
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
    QueueName = aws_sqs_queue.group[each.key].name
  }
}

resource "aws_cloudwatch_metric_alarm" "group_dlq_depth" {
  for_each            = local.worker_groups
  alarm_name          = "${local.name_prefix}-worker-${each.key}-dlq-${var.env_name}-messages"
  alarm_description   = "A worker job reached the dead-letter queue."
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
    QueueName = aws_sqs_queue.group_dlq[each.key].name
  }
}
