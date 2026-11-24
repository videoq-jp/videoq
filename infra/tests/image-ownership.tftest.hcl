mock_provider "aws" {
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/test-worker"
    }
  }
  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:ap-northeast-1:123456789012:test-operations"
    }
  }
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

override_resource {
  target = aws_cloudwatch_log_group.worker
  values = {
    arn = "arn:aws:logs:ap-northeast-1:123456789012:log-group:/aws/lambda/test"
  }
}

override_resource {
  target = aws_sqs_queue.dlq
  values = {
    arn = "arn:aws:sqs:ap-northeast-1:123456789012:test-dlq"
  }
}

run "bootstrap_image" {
  command = apply
  variables {
    image_tag = "bootstrap"
  }
}

run "image_is_owned_by_cd_but_infrastructure_remains_managed" {
  command = plan
  variables {
    image_tag               = "terraform-must-not-redeploy"
    worker_lambda_memory_mb = 6144
  }
  assert {
    condition     = endswith(aws_lambda_function.worker.image_uri, ":bootstrap")
    error_message = "Terraform must preserve the deployed image after creation; CD owns image updates."
  }
  assert {
    condition     = aws_lambda_function.worker.memory_size == 6144
    error_message = "Ignoring the image must not hide real infrastructure configuration changes."
  }
}
