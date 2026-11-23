import {
  to = aws_iam_role.videoq_github_actions_deploy
  id = "videoq-github-actions-deploy"
}
import {
  to = aws_iam_role_policy_attachment.videoq_github_actions_deploy_videoq_terraform_deploy
  id = "videoq-github-actions-deploy/arn:aws:iam::257240362763:policy/videoq-terraform-deploy"
}
import {
  to = aws_iam_role_policy_attachment.videoq_github_actions_deploy_videoq_backend_cd
  id = "videoq-github-actions-deploy/arn:aws:iam::257240362763:policy/videoq-backend-cd"
}
import {
  to = aws_iam_role_policy_attachment.videoq_github_actions_deploy_videoq_tfstate_access
  id = "videoq-github-actions-deploy/arn:aws:iam::257240362763:policy/videoq-tfstate-access"
}
import {
  to = aws_iam_role_policy.videoq_github_actions_deploy_videoq_api_key_rotation_operator
  id = "videoq-github-actions-deploy:videoq-api-key-rotation-operator"
}
import {
  to = aws_iam_role.videoq_github_actions_plan
  id = "videoq-github-actions-plan"
}
import {
  to = aws_iam_role_policy_attachment.videoq_github_actions_plan_ReadOnlyAccess
  id = "videoq-github-actions-plan/arn:aws:iam::aws:policy/ReadOnlyAccess"
}
import {
  to = aws_iam_role_policy_attachment.videoq_github_actions_plan_videoq_tfstate_plan
  id = "videoq-github-actions-plan/arn:aws:iam::257240362763:policy/videoq-tfstate-plan"
}
import {
  to = aws_iam_role_policy.videoq_github_actions_plan_deny_protected_neon_credentials
  id = "videoq-github-actions-plan:deny-protected-neon-credentials"
}
import {
  to = aws_iam_policy.videoq_tfstate_access
  id = "arn:aws:iam::257240362763:policy/videoq-tfstate-access"
}
import {
  to = aws_iam_policy.videoq_backend_cd
  id = "arn:aws:iam::257240362763:policy/videoq-backend-cd"
}
import {
  to = aws_iam_policy.videoq_backup
  id = "arn:aws:iam::257240362763:policy/videoq-backup"
}
import {
  to = aws_iam_policy.videoq_terraform_deploy
  id = "arn:aws:iam::257240362763:policy/videoq-terraform-deploy"
}
import {
  to = aws_iam_policy.videoq_tfstate_plan
  id = "arn:aws:iam::257240362763:policy/videoq-tfstate-plan"
}
import {
  to = aws_iam_user.videoq_github_actions_cd
  id = "videoq-github-actions-cd"
}
import {
  to = aws_iam_user_policy_attachment.videoq_github_actions_cd_videoq_terraform_deploy
  id = "videoq-github-actions-cd/arn:aws:iam::257240362763:policy/videoq-terraform-deploy"
}
import {
  to = aws_iam_user_policy_attachment.videoq_github_actions_cd_videoq_backend_cd
  id = "videoq-github-actions-cd/arn:aws:iam::257240362763:policy/videoq-backend-cd"
}
import {
  to = aws_iam_user_policy_attachment.videoq_github_actions_cd_videoq_tfstate_access
  id = "videoq-github-actions-cd/arn:aws:iam::257240362763:policy/videoq-tfstate-access"
}
import {
  to = aws_iam_user.videoq_workers_api
  id = "videoq-workers-api"
}
import {
  to = aws_iam_user_policy.videoq_workers_api_videoq_openrouter_federation
  id = "videoq-workers-api:videoq-openrouter-federation"
}
import {
  to = aws_iam_user_policy.videoq_workers_api_videoq_sqs_send
  id = "videoq-workers-api:videoq-sqs-send"
}
import {
  to = aws_iam_openid_connect_provider.github
  id = "arn:aws:iam::257240362763:oidc-provider/token.actions.githubusercontent.com"
}
