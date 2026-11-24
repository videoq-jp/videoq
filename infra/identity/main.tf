# __generated__ by Terraform
# Please review these resources and move them into your main configuration files.

# __generated__ by Terraform from "videoq-github-actions-cd/arn:aws:iam::257240362763:policy/videoq-backend-cd"
resource "aws_iam_user_policy_attachment" "videoq_github_actions_cd_videoq_backend_cd" {
  policy_arn = "arn:aws:iam::257240362763:policy/videoq-backend-cd"
  user       = "videoq-github-actions-cd"
}

# __generated__ by Terraform from "videoq-github-actions-plan/arn:aws:iam::aws:policy/ReadOnlyAccess"
resource "aws_iam_role_policy_attachment" "videoq_github_actions_plan_ReadOnlyAccess" {
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
  role       = "videoq-github-actions-plan"
}

# __generated__ by Terraform from "videoq-github-actions-plan/arn:aws:iam::257240362763:policy/videoq-tfstate-plan"
resource "aws_iam_role_policy_attachment" "videoq_github_actions_plan_videoq_tfstate_plan" {
  policy_arn = "arn:aws:iam::257240362763:policy/videoq-tfstate-plan"
  role       = "videoq-github-actions-plan"
}

# __generated__ by Terraform from "videoq-github-actions-deploy/arn:aws:iam::257240362763:policy/videoq-backend-cd"
resource "aws_iam_role_policy_attachment" "videoq_github_actions_deploy_videoq_backend_cd" {
  policy_arn = "arn:aws:iam::257240362763:policy/videoq-backend-cd"
  role       = "videoq-github-actions-deploy"
}

# __generated__ by Terraform from "videoq-workers-api:videoq-sqs-send"
resource "aws_iam_user_policy" "videoq_workers_api_videoq_sqs_send" {
  name = "videoq-sqs-send"
  policy = jsonencode({
    Statement = [{
      Action   = "sqs:SendMessage"
      Effect   = "Allow"
      Resource = ["arn:aws:sqs:ap-northeast-1:257240362763:videoq-worker-prod"]
      Sid      = "SendVideoqJobs"
    }]
    Version = "2012-10-17"
  })
  user = "videoq-workers-api"
}

# __generated__ by Terraform from "videoq-workers-api"
resource "aws_iam_user" "videoq_workers_api" {
  lifecycle { prevent_destroy = true }
  force_destroy        = null
  name                 = "videoq-workers-api"
  path                 = "/"
  permissions_boundary = null
  tags = {
    project = "videoq"
    role    = "workers-sqs-producer"
  }
  tags_all = {
    project = "videoq"
    role    = "workers-sqs-producer"
  }
}

# __generated__ by Terraform from "videoq-github-actions-cd"
resource "aws_iam_user" "videoq_github_actions_cd" {
  lifecycle { prevent_destroy = true }
  force_destroy        = null
  name                 = "videoq-github-actions-cd"
  path                 = "/"
  permissions_boundary = null
  tags                 = {}
  tags_all             = {}
}

# __generated__ by Terraform from "arn:aws:iam::257240362763:policy/videoq-tfstate-access"

# __generated__ by Terraform from "arn:aws:iam::257240362763:policy/videoq-backend-cd"
resource "aws_iam_policy" "videoq_backend_cd" {
  lifecycle { prevent_destroy = true }
  delay_after_policy_creation_in_ms = null
  description                       = null
  name                              = "videoq-backend-cd"
  path                              = "/"
  policy = jsonencode({
    Statement = [{
      Action   = ["ecr:GetAuthorizationToken"]
      Effect   = "Allow"
      Resource = "*"
      Sid      = "EcrAuth"
      }, {
      Action   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage"]
      Effect   = "Allow"
      Resource = ["arn:aws:ecr:ap-northeast-1:257240362763:repository/videoq-api-prod", "arn:aws:ecr:ap-northeast-1:257240362763:repository/videoq-worker-prod"]
      Sid      = "EcrPush"
      }, {
      Action   = ["lambda:UpdateFunctionCode", "lambda:GetFunction", "lambda:GetFunctionConfiguration"]
      Effect   = "Allow"
      Resource = ["arn:aws:lambda:ap-northeast-1:257240362763:function:videoq-api-prod", "arn:aws:lambda:ap-northeast-1:257240362763:function:videoq-worker-prod", "arn:aws:lambda:ap-northeast-1:257240362763:function:videoq-worker-search-prod", "arn:aws:lambda:ap-northeast-1:257240362763:function:videoq-worker-account-prod"]
      Sid      = "LambdaCodeDeploy"
    }]
    Version = "2012-10-17"
  })
  tags     = {}
  tags_all = {}
}

# __generated__ by Terraform from "videoq-github-actions-deploy/arn:aws:iam::257240362763:policy/videoq-tfstate-access"
resource "aws_iam_role_policy_attachment" "videoq_github_actions_deploy_videoq_tfstate_access" {
  policy_arn = "arn:aws:iam::257240362763:policy/videoq-tfstate-access"
  role       = "videoq-github-actions-deploy"
}

# __generated__ by Terraform from "videoq-github-actions-deploy/arn:aws:iam::257240362763:policy/videoq-terraform-deploy"
resource "aws_iam_role_policy_attachment" "videoq_github_actions_deploy_videoq_terraform_deploy" {
  policy_arn = "arn:aws:iam::257240362763:policy/videoq-terraform-deploy"
  role       = "videoq-github-actions-deploy"
}

# __generated__ by Terraform
resource "aws_iam_openid_connect_provider" "github" {
  lifecycle { prevent_destroy = true }
  client_id_list = ["sts.amazonaws.com"]
  tags = {
    Project = "videoq"
    Purpose = "github-actions-oidc"
  }
  tags_all = {
    Project = "videoq"
    Purpose = "github-actions-oidc"
  }
  thumbprint_list = ["ab9d0263244dd0326eb67015705a667e79cfe998"]
  url             = "https://token.actions.githubusercontent.com"
}

# __generated__ by Terraform from "videoq-github-actions-cd/arn:aws:iam::257240362763:policy/videoq-terraform-deploy"
resource "aws_iam_user_policy_attachment" "videoq_github_actions_cd_videoq_terraform_deploy" {
  policy_arn = "arn:aws:iam::257240362763:policy/videoq-terraform-deploy"
  user       = "videoq-github-actions-cd"
}

# __generated__ by Terraform from "videoq-github-actions-plan:deny-protected-neon-credentials"
resource "aws_iam_role_policy" "videoq_github_actions_plan_deny_protected_neon_credentials" {
  name = "deny-protected-neon-credentials"
  policy = jsonencode({
    Statement = [{
      Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParameterHistory"]
      Effect   = "Deny"
      Resource = ["arn:aws:ssm:ap-northeast-1:257240362763:parameter/videoq/security/prod/*"]
      Sid      = "DenyProtectedDatabaseCredentials"
      }, {
      Action   = "ssm:GetParametersByPath"
      Effect   = "Deny"
      Resource = "*"
      Sid      = "DenyRecursiveParameterReads"
    }]
    Version = "2012-10-17"
  })
  role = "videoq-github-actions-plan"
}

# __generated__ by Terraform from "arn:aws:iam::257240362763:policy/videoq-tfstate-plan"

# __generated__ by Terraform from "videoq-github-actions-cd/arn:aws:iam::257240362763:policy/videoq-tfstate-access"
resource "aws_iam_user_policy_attachment" "videoq_github_actions_cd_videoq_tfstate_access" {
  policy_arn = "arn:aws:iam::257240362763:policy/videoq-tfstate-access"
  user       = "videoq-github-actions-cd"
}

# __generated__ by Terraform from "videoq-github-actions-deploy:videoq-api-key-rotation-operator"
resource "aws_iam_role_policy" "videoq_github_actions_deploy_videoq_api_key_rotation_operator" {
  name = "videoq-api-key-rotation-operator"
  policy = jsonencode({
    Statement = [{
      Action   = ["iam:GetUser", "iam:ListGroupsForUser", "iam:ListAttachedUserPolicies", "iam:ListUserPolicies", "iam:GetUserPolicy", "iam:ListAccessKeys", "iam:CreateAccessKey", "iam:UpdateAccessKey", "iam:DeleteAccessKey"]
      Effect   = "Allow"
      Resource = "arn:aws:iam::257240362763:user/videoq-workers-api"
      Sid      = "ManageOnlyVideoqApiUserKeysAndInspectItsPolicies"
    }]
    Version = "2012-10-17"
  })
  role = "videoq-github-actions-deploy"
}

# __generated__ by Terraform from "arn:aws:iam::257240362763:policy/videoq-terraform-deploy"
resource "aws_iam_policy" "videoq_terraform_deploy" {
  lifecycle { prevent_destroy = true }
  delay_after_policy_creation_in_ms = null
  description                       = null
  name                              = "videoq-terraform-deploy"
  path                              = "/"
  policy = jsonencode({
    Statement = [{
      Action   = ["ecr:CreateRepository", "ecr:DeleteRepository", "ecr:DescribeRepositories", "ecr:ListTagsForResource", "ecr:TagResource", "ecr:UntagResource", "ecr:PutLifecyclePolicy", "ecr:GetLifecyclePolicy", "ecr:DeleteLifecyclePolicy", "ecr:GetRepositoryPolicy", "ecr:ListImages", "ecr:BatchDeleteImage"]
      Effect   = "Allow"
      Resource = "arn:aws:ecr:ap-northeast-1:257240362763:repository/videoq-worker-prod"
      Sid      = "EcrRepoManage"
      }, {
      Action   = ["ssm:AddTagsToResource", "ssm:RemoveTagsFromResource", "ssm:ListTagsForResource", "ssm:PutParameter", "ssm:GetParameter", "ssm:GetParameters", "ssm:DescribeParameters", "ssm:DeleteParameter", "ssm:GetParameterHistory"]
      Effect   = "Allow"
      Resource = "arn:aws:ssm:ap-northeast-1:257240362763:parameter/videoq/prod/*"
      Sid      = "SsmParameterManage"
      }, {
      Action   = ["ssm:DescribeParameters"]
      Effect   = "Allow"
      Resource = "*"
      Sid      = "SsmDescribeParameters"
      }, {
      Action   = ["secretsmanager:DescribeSecret", "secretsmanager:DeleteSecret", "secretsmanager:GetResourcePolicy"]
      Effect   = "Allow"
      Resource = "arn:aws:secretsmanager:ap-northeast-1:257240362763:secret:videoq/prod/*"
      Sid      = "SecretsManagerCleanup"
      }, {
      Action   = ["sqs:CreateQueue", "sqs:DeleteQueue", "sqs:GetQueueAttributes", "sqs:SetQueueAttributes", "sqs:GetQueueUrl", "sqs:ListQueueTags", "sqs:TagQueue", "sqs:UntagQueue"]
      Effect   = "Allow"
      Resource = ["arn:aws:sqs:ap-northeast-1:257240362763:videoq-worker-prod", "arn:aws:sqs:ap-northeast-1:257240362763:videoq-worker-search-prod", "arn:aws:sqs:ap-northeast-1:257240362763:videoq-worker-account-prod", "arn:aws:sqs:ap-northeast-1:257240362763:videoq-worker-dlq-prod", "arn:aws:sqs:ap-northeast-1:257240362763:videoq-worker-search-dlq-prod", "arn:aws:sqs:ap-northeast-1:257240362763:videoq-worker-account-dlq-prod"]
      Sid      = "SqsManage"
      }, {
      Action   = ["iam:GetRole", "iam:TagRole", "iam:UntagRole", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PassRole"]
      Effect   = "Allow"
      Resource = "arn:aws:iam::257240362763:role/videoq-worker-prod"
      Sid      = "IamManageVideoqRoles"
      }, {
      Action   = ["iam:CreateRole", "iam:DeleteRole", "iam:PutRolePermissionsBoundary", "iam:DeleteRolePermissionsBoundary"]
      Effect   = "Deny"
      Resource = "arn:aws:iam::257240362763:role/videoq-worker-prod"
      Sid      = "PreserveOperatorManagedWorkerBoundary"
      }, {
      Action   = ["lambda:CreateFunction", "lambda:DeleteFunction", "lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:GetFunctionCodeSigningConfig", "lambda:GetRuntimeManagementConfig", "lambda:GetFunctionConcurrency", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration", "lambda:ListVersionsByFunction", "lambda:TagResource", "lambda:UntagResource", "lambda:ListTags", "lambda:AddPermission", "lambda:RemovePermission", "lambda:GetPolicy"]
      Effect   = "Allow"
      Resource = ["arn:aws:lambda:ap-northeast-1:257240362763:function:videoq-worker-prod", "arn:aws:lambda:ap-northeast-1:257240362763:function:videoq-worker-search-prod", "arn:aws:lambda:ap-northeast-1:257240362763:function:videoq-worker-account-prod"]
      Sid      = "LambdaManage"
      }, {
      Action   = ["lambda:CreateEventSourceMapping", "lambda:GetEventSourceMapping", "lambda:UpdateEventSourceMapping", "lambda:DeleteEventSourceMapping", "lambda:ListEventSourceMappings", "lambda:ListTags", "lambda:TagResource", "lambda:UntagResource"]
      Effect   = "Allow"
      Resource = "*"
      Sid      = "LambdaEventSourceMappings"
      }, {
      Action   = ["cloudwatch:DeleteAlarms", "cloudwatch:ListTagsForResource", "cloudwatch:PutMetricAlarm", "cloudwatch:TagResource", "cloudwatch:UntagResource"]
      Effect   = "Allow"
      Resource = "arn:aws:cloudwatch:ap-northeast-1:257240362763:alarm:videoq-*"
      Sid      = "CloudWatchAlarmManage"
      }, {
      Action   = ["cloudwatch:DescribeAlarms", "logs:DescribeLogGroups", "sns:ListTopics"]
      Effect   = "Allow"
      Resource = "*"
      Sid      = "MonitoringDiscovery"
      }, {
      Action   = ["logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:ListTagsForResource", "logs:PutRetentionPolicy", "logs:TagResource", "logs:UntagResource"]
      Effect   = "Allow"
      Resource = ["arn:aws:logs:ap-northeast-1:257240362763:log-group:/aws/lambda/videoq-worker-prod", "arn:aws:logs:ap-northeast-1:257240362763:log-group:/aws/lambda/videoq-worker-search-prod", "arn:aws:logs:ap-northeast-1:257240362763:log-group:/aws/lambda/videoq-worker-account-prod", "arn:aws:logs:ap-northeast-1:257240362763:log-group:/aws/lambda/videoq-worker-prod:*", "arn:aws:logs:ap-northeast-1:257240362763:log-group:/aws/lambda/videoq-worker-search-prod:*", "arn:aws:logs:ap-northeast-1:257240362763:log-group:/aws/lambda/videoq-worker-account-prod:*"]
      Sid      = "LambdaLogGroupManage"
      }, {
      Action   = ["sns:CreateTopic", "sns:DeleteTopic", "sns:GetSubscriptionAttributes", "sns:GetTopicAttributes", "sns:ListSubscriptionsByTopic", "sns:ListTagsForResource", "sns:SetSubscriptionAttributes", "sns:SetTopicAttributes", "sns:Subscribe", "sns:TagResource", "sns:Unsubscribe", "sns:UntagResource"]
      Effect   = "Allow"
      Resource = "arn:aws:sns:ap-northeast-1:257240362763:videoq-operations-prod"
      Sid      = "OperationsTopicManage"
    }]
    Version = "2012-10-17"
  })
  tags     = {}
  tags_all = {}
}

# __generated__ by Terraform from "arn:aws:iam::257240362763:policy/videoq-backup"
resource "aws_iam_policy" "videoq_backup" {
  lifecycle { prevent_destroy = true }
  delay_after_policy_creation_in_ms = null
  description                       = null
  name                              = "videoq-backup"
  path                              = "/"
  policy = jsonencode({
    Statement = [{
      Action   = ["s3:CreateBucket", "s3:PutObject", "s3:GetObject", "s3:ListBucket", "s3:DeleteObject"]
      Effect   = "Allow"
      Resource = ["arn:aws:s3:::videoq-backup", "arn:aws:s3:::videoq-backup/*"]
    }]
    Version = "2012-10-17"
  })
  tags     = {}
  tags_all = {}
}

# __generated__ by Terraform from "videoq-github-actions-deploy"
resource "aws_iam_role" "videoq_github_actions_deploy" {
  lifecycle { prevent_destroy = true }
  assume_role_policy = jsonencode({
    Statement = [{
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = ["repo:videoq-jp@349188820/videoq@1083911938:ref:refs/heads/main", "repo:videoq-jp@349188820/videoq@1083911938:environment:production-infra"]
        }
      }
      Effect = "Allow"
      Principal = {
        Federated = "arn:aws:iam::257240362763:oidc-provider/token.actions.githubusercontent.com"
      }
    }]
    Version = "2012-10-17"
  })
  description           = "Production deploys from VideoQ main and production environment"
  force_detach_policies = false
  max_session_duration  = 3600
  name                  = "videoq-github-actions-deploy"
  path                  = "/"
  permissions_boundary  = null
  tags = {
    Project = "videoq"
    Purpose = "github-actions-deploy"
  }
  tags_all = {
    Project = "videoq"
    Purpose = "github-actions-deploy"
  }
}

# __generated__ by Terraform from "videoq-github-actions-plan"
resource "aws_iam_role" "videoq_github_actions_plan" {
  lifecycle { prevent_destroy = true }
  assume_role_policy = jsonencode({
    Statement = [{
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:videoq-jp@349188820/videoq@1083911938:ref:refs/heads/main"
        }
      }
      Effect = "Allow"
      Principal = {
        Federated = "arn:aws:iam::257240362763:oidc-provider/token.actions.githubusercontent.com"
      }
    }]
    Version = "2012-10-17"
  })
  description           = "Read-only Terraform plan from VideoQ pull requests"
  force_detach_policies = false
  max_session_duration  = 3600
  name                  = "videoq-github-actions-plan"
  path                  = "/"
  permissions_boundary  = null
  tags = {
    Project = "videoq"
    Purpose = "github-actions-plan"
  }
  tags_all = {
    Project = "videoq"
    Purpose = "github-actions-plan"
  }
}
