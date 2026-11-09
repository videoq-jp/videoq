mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}
mock_provider "openai" {}

override_resource {
  target = aws_cloudwatch_log_group.worker
  values = {
    arn = "arn:aws:logs:ap-northeast-1:123456789012:log-group:/aws/lambda/test"
  }
}

override_resource {
  target          = aws_sqs_queue.dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:ap-northeast-1:123456789012:test-dlq"
  }
}

variables {
  manage_openai_project = false
}

run "default_retry_budget" {
  command = plan

  assert {
    condition     = aws_sqs_queue.main.visibility_timeout_seconds >= 6 * aws_lambda_function.worker.timeout
    error_message = "The queue must allow Lambda processing and throttling retries."
  }

  assert {
    condition     = jsondecode(aws_sqs_queue.main.redrive_policy).maxReceiveCount >= 5
    error_message = "Transient failures need at least five attempts before dead-lettering."
  }
}

run "reject_short_visibility" {
  command = plan
  variables {
    sqs_visibility_timeout_seconds = 960
  }
  expect_failures = [var.sqs_visibility_timeout_seconds]
}

run "reject_insufficient_retries" {
  command = plan
  variables {
    sqs_max_receive_count = 3
  }
  expect_failures = [var.sqs_max_receive_count]
}

run "partial_batch_retry_failures_are_monitored" {
  command = plan

  override_resource {
    target          = aws_lambda_event_source_mapping.worker
    override_during = plan
    values = {
      uuid = "00000000-0000-4000-8000-000000000001"
    }
  }

  override_resource {
    target          = aws_sns_topic.operations
    override_during = plan
    values = {
      arn = "arn:aws:sns:ap-northeast-1:123456789012:test-operations"
    }
  }

  assert {
    condition = (
      contains(aws_lambda_event_source_mapping.worker.function_response_types, "ReportBatchItemFailures") &&
      contains(aws_lambda_event_source_mapping.worker.metrics_config[0].metrics, "EventCount")
    )
    error_message = "Partial batch retries must emit EventCount metrics so failed jobs cannot silently wait for visibility timeout."
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.worker_job_failures.namespace == "AWS/Lambda" &&
      aws_cloudwatch_metric_alarm.worker_job_failures.metric_name == "FailedInvokeEventCount" &&
      aws_cloudwatch_metric_alarm.worker_job_failures.statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.worker_job_failures.dimensions == tomap({
        EventSourceMappingUUID = aws_lambda_event_source_mapping.worker.uuid
      })
    )
    error_message = "The failure alarm must query the worker mapping's partial-failure metric with exactly its published dimensions."
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.worker_job_failures.threshold == 1 &&
      aws_cloudwatch_metric_alarm.worker_job_failures.comparison_operator == "GreaterThanOrEqualToThreshold" &&
      aws_cloudwatch_metric_alarm.worker_job_failures.evaluation_periods == 1 &&
      aws_cloudwatch_metric_alarm.worker_job_failures.period < aws_sqs_queue.main.visibility_timeout_seconds
    )
    error_message = "A single reported failure must breach without waiting through multiple evaluation periods or the SQS retry delay."
  }

  assert {
    condition = (
      contains(aws_cloudwatch_metric_alarm.worker_job_failures.alarm_actions, aws_sns_topic.operations.arn) &&
      contains(aws_cloudwatch_metric_alarm.worker_job_failures.ok_actions, aws_sns_topic.operations.arn) &&
      aws_cloudwatch_metric_alarm.worker_job_failures.treat_missing_data == "notBreaching"
    )
    error_message = "Failures and recovery must reach the operations topic, while an idle mapping must not trigger a failure alarm."
  }
}

run "reject_visibility_that_exhausts_retries_before_lease_expiry" {
  command = plan
  variables {
    worker_lambda_timeout_seconds = 10
    sqs_visibility_timeout_seconds = 60
  }
  expect_failures = [var.sqs_visibility_timeout_seconds]
}

run "short_media_timeout_allows_retry_after_latest_lease_expiry" {
  command = plan
  variables {
    worker_lambda_timeout_seconds = 10
    sqs_visibility_timeout_seconds = 970
  }
  assert {
    condition = aws_sqs_queue.main.visibility_timeout_seconds >= aws_lambda_function.worker.timeout + 900 + 60
    error_message = "The media queue also needs time for a timed-out invocation's lease to expire."
  }
}
