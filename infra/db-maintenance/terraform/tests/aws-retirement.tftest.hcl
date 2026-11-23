mock_provider "aws" {}
variables {
  provision_backup_archive = true
  retire_aws_maintenance   = true
}
run "acknowledgement_required" {
  command = plan
  variables { retire_aws_maintenance = false }
  expect_failures = [var.retire_aws_maintenance]
}
run "archives_cannot_be_disabled" {
  command = plan
  variables { provision_backup_archive = false }
  expect_failures = [var.provision_backup_archive]
}
run "retained_resources" {
  command = plan
  assert {
    condition     = length(aws_s3_bucket.archive) == 1 && !aws_s3_bucket.archive[0].force_destroy && length(aws_cloudwatch_log_group.build) == 5 && length(aws_cloudwatch_log_group.broker) == 5 && aws_cloudwatch_log_group.deploy.retention_in_days == 14
    error_message = "Retirement must preserve the private versioned archives and all historical logs."
  }
  assert {
    condition     = output.invocation_functions == {} && output.state_machine == null && !strcontains(aws_iam_policy.worker_boundary.policy, "/worker-db")
    error_message = "Retirement must expose no old invocation route and must preserve the media role ceiling."
  }
}
