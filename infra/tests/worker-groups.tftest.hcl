mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/test-worker" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:ap-northeast-1:123456789012:test-operations" }
  }
  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:ap-northeast-1:123456789012:test-queue"
      url = "https://sqs.ap-northeast-1.amazonaws.com/123456789012/test-queue"
    }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:ap-northeast-1:123456789012:log-group:/aws/lambda/test" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}
mock_provider "openai" {}
override_resource {
  target = aws_cloudwatch_log_group.worker
  values = { arn = "arn:aws:logs:ap-northeast-1:123456789012:log-group:/aws/lambda/test-media" }
}
variables {
  manage_openai_project = false
}
run "isolated_search_and_account_consumers" {
  command = apply
  assert {
    condition = (
      aws_lambda_function.worker.function_name == "videoq-worker-prod" &&
      aws_sqs_queue.main.name == "videoq-worker-prod" &&
      length(aws_lambda_function.group) == 2 &&
      length(aws_sqs_queue.group) == 2 && length(aws_sqs_queue.group_dlq) == 2
    )
    error_message = "Preserve the media resources and add exactly search/account consumers and DLQs."
  }
  assert {
    condition = alltrue([for key, fn in aws_lambda_function.group : (
      fn.environment[0].variables["WORKER_JOB_GROUP"] == key &&
      fn.environment[0].variables["SQS_SEARCH_QUEUE_URL"] == aws_sqs_queue.group["search"].url &&
      fn.environment[0].variables["SQS_ACCOUNT_QUEUE_URL"] == aws_sqs_queue.group["account"].url &&
      fn.image_uri == aws_lambda_function.worker.image_uri &&
      fn.role == aws_iam_role.worker.arn &&
      aws_sqs_queue.group[key].visibility_timeout_seconds >= 6 * fn.timeout &&
      jsondecode(aws_sqs_queue.group[key].redrive_policy).deadLetterTargetArn == aws_sqs_queue.group_dlq[key].arn &&
      aws_lambda_event_source_mapping.group[key].event_source_arn == aws_sqs_queue.group[key].arn &&
      aws_lambda_event_source_mapping.group[key].function_name == fn.arn &&
      aws_lambda_event_source_mapping.group[key].batch_size == 1 &&
      contains(aws_lambda_event_source_mapping.group[key].function_response_types, "ReportBatchItemFailures") &&
      aws_lambda_event_source_mapping.group[key].scaling_config[0].maximum_concurrency == var.worker_groups[key].maximum_concurrency
    )])
    error_message = "Every consumer must have independent queue/configuration, routing, and retry semantics."
  }
  assert {
    condition = (
      aws_lambda_function.group["search"].memory_size == 2048 &&
      aws_lambda_function.group["account"].memory_size == 1024 &&
      aws_lambda_function.group["account"].timeout == 900 &&
      length(aws_sqs_queue_policy.group_require_tls) == 4 &&
      alltrue([for policy in aws_sqs_queue_policy.group_require_tls :
        jsondecode(policy.policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false"
      ])
    )
    error_message = "New groups must use appropriate resources and enforce TLS on all four queues."
  }
  assert {
    condition = alltrue([for key, fn in aws_lambda_function.group : (
      aws_cloudwatch_metric_alarm.group_errors[key].dimensions.FunctionName == fn.function_name &&
      aws_cloudwatch_metric_alarm.group_job_failures[key].dimensions.EventSourceMappingUUID == aws_lambda_event_source_mapping.group[key].uuid &&
      aws_cloudwatch_metric_alarm.group_queue_waiting[key].dimensions.QueueName == aws_sqs_queue.group[key].name &&
      aws_cloudwatch_metric_alarm.group_dlq_depth[key].dimensions.QueueName == aws_sqs_queue.group_dlq[key].name &&
      aws_cloudwatch_metric_alarm.group_duration[key].threshold == fn.timeout * 800
    )])
    error_message = "Each group needs independent failure, duration, backlog and DLQ alarms."
  }
}

run "short_function_timeouts_preserve_lease_recovery" {
  command = plan
  variables {
    worker_groups = {
      search  = { memory_mb = 2048, timeout_seconds = 10, storage_mb = 512, maximum_concurrency = 4 }
      account = { memory_mb = 1024, timeout_seconds = 1, storage_mb = 512, maximum_concurrency = 2 }
    }
  }
  assert {
    condition = alltrue([for key, fn in aws_lambda_function.group : (
      aws_sqs_queue.group[key].visibility_timeout_seconds >= fn.timeout + 900 + 60 &&
      aws_sqs_queue.group[key].visibility_timeout_seconds >= 6 * fn.timeout
    )])
    error_message = "Even a lease claimed just before Lambda timeout must expire before the next SQS attempt."
  }
}
