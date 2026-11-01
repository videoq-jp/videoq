mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}
mock_provider "openai" {}

override_resource {
  target          = aws_sqs_queue.main
  override_during = plan
  values = {
    arn = "arn:aws:sqs:ap-northeast-1:123456789012:test-main"
    url = "https://sqs.ap-northeast-1.amazonaws.com/123456789012/test-main"
  }
}

override_resource {
  target          = aws_sqs_queue.dlq
  override_during = plan
  values = {
    arn = "arn:aws:sqs:ap-northeast-1:123456789012:test-dlq"
    url = "https://sqs.ap-northeast-1.amazonaws.com/123456789012/test-dlq"
  }
}

override_resource {
  target          = aws_cloudwatch_log_group.worker
  override_during = plan
  values = {
    arn = "arn:aws:logs:ap-northeast-1:123456789012:log-group:/aws/lambda/test"
  }
}

variables {
  manage_openai_project = false
}

run "both_queues_require_encrypted_transport" {
  command = plan

  assert {
    condition = (
      length(aws_sqs_queue_policy.require_tls) == 2 &&
      aws_sqs_queue_policy.require_tls["main"].queue_url == aws_sqs_queue.main.url &&
      aws_sqs_queue_policy.require_tls["dlq"].queue_url == aws_sqs_queue.dlq.url
    )
    error_message = "The main and dead-letter queues must both enforce TLS."
  }

  assert {
    condition = alltrue([
      for name, policy in aws_sqs_queue_policy.require_tls : (
        jsondecode(policy.policy).Version == "2012-10-17" &&
        length(jsondecode(policy.policy).Statement) == 1 &&
        jsondecode(policy.policy).Statement[0].Effect == "Deny" &&
        jsondecode(policy.policy).Statement[0].Principal == "*" &&
        jsondecode(policy.policy).Statement[0].Action == "sqs:*" &&
        jsondecode(policy.policy).Statement[0].Resource == (name == "main" ? aws_sqs_queue.main.arn : aws_sqs_queue.dlq.arn) &&
        jsondecode(policy.policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false"
      )
    ])
    error_message = "Every queue must deny all insecure SQS actions for all principals, on its own ARN only."
  }
}
