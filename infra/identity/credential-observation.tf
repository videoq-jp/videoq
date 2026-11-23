# Credential rotation owns access-key generation/status/deletion. Observe keys
# without allowing Terraform to regenerate a key retired by that protocol.
data "aws_iam_access_keys" "worker_api" { user = aws_iam_user.videoq_workers_api.name }
data "aws_iam_access_keys" "legacy_cd" { user = aws_iam_user.videoq_github_actions_cd.name }
removed {
  from = aws_iam_access_key.videoq_github_actions_cd_6WGMT7
  lifecycle { destroy = false }
}
removed {
  from = aws_iam_access_key.videoq_workers_api_M7D4GX
  lifecycle { destroy = false }
}
