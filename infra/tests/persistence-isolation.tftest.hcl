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
  mock_resource "aws_ssm_parameter" {
    defaults = { arn = "arn:aws:ssm:ap-northeast-1:123456789012:parameter/test/db" }
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
override_resource {
  target = aws_ssm_parameter.app
  values = { arn = "arn:aws:ssm:ap-northeast-1:123456789012:parameter/test/app" }
}
variables {
  manage_openai_project = false
}

run "production_workers_cannot_read_the_retired_database" {
  command = apply
  assert {
    condition = alltrue([for fn in concat([aws_lambda_function.worker], values(aws_lambda_function.group)) : (
      fn.environment[0].variables["PERSISTENCE_BACKEND"] == "d1" &&
      fn.environment[0].variables["WORKER_INTERNAL_API_ORIGIN"] == "https://videoq.jp" &&
      !contains(keys(fn.environment[0].variables), "DB_PARAM_NAME") &&
      !contains(keys(fn.environment[0].variables), "PGSSLROOTCERT") &&
      fn.environment[0].variables["APP_PARAM_NAME"] == aws_ssm_parameter.app.name
    )])
    error_message = "All production consumers must use the signed persistence API without a PostgreSQL credential reference."
  }
  assert {
    condition = alltrue([for statement in data.aws_iam_policy_document.worker_permissions.statement : (
      !contains(statement.actions, "ssm:GetParameter") ||
      statement.resources == toset([aws_ssm_parameter.app.arn])
    )])
    error_message = "Production SSM reads must be limited to app secrets; the old worker database must not be readable."
  }
}

run "nonproduction_postgres_workers_keep_their_explicit_database_reference" {
  command = apply
  variables {
    env_name = "test"
  }
  assert {
    condition = alltrue([for fn in concat([aws_lambda_function.worker], values(aws_lambda_function.group)) : (
      fn.environment[0].variables["DB_PARAM_NAME"] == "/videoq/test/worker-db" &&
      fn.environment[0].variables["PGSSLROOTCERT"] == "/etc/pki/tls/certs/ca-bundle.crt" &&
      !contains(keys(fn.environment[0].variables), "PERSISTENCE_BACKEND")
    )])
    error_message = "The production retirement must preserve explicit PostgreSQL bootstrapping outside production."
  }
  assert {
    condition = anytrue([for statement in data.aws_iam_policy_document.worker_permissions.statement : (
      contains(statement.actions, "ssm:GetParameter") &&
      contains(statement.resources, "${trimsuffix(aws_ssm_parameter.db.arn, "/db")}/worker-db")
    )])
    error_message = "Nonproduction PostgreSQL workers still need their scoped database parameter permission."
  }
}
