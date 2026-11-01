# GitHub can invoke the deploy starter, but cannot upload code or edit AWS resources.
# This AWS-only builder promotes reviewed main code. Code deployment is a trusted
# capability: approved code can exercise the maintenance jobs' existing DB grants.
resource "aws_cloudwatch_log_group" "deploy" {
  name              = "/aws/codebuild/videoq-db-deploy-prod"
  retention_in_days = 14
}
resource "aws_iam_role" "deploy" {
  name = "videoq-db-deploy-prod"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "codebuild.amazonaws.com" }, Action = "sts:AssumeRole",
    Condition = { StringEquals = { "aws:SourceAccount" = local.account }, ArnEquals = {
      "aws:SourceArn" = "arn:aws:codebuild:${local.region}:${local.account}:project/videoq-db-deploy-prod"
    } }
  }] })
}
resource "aws_iam_role_policy" "deploy" {
  name = "promote-maintenance-code-only"
  role = aws_iam_role.deploy.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.deploy.arn}:*" },
    { Effect = "Allow", Action = ["s3:PutObject"], Resource = ["${aws_s3_bucket.bundle.arn}/operator.zip", "${aws_s3_bucket.bundle.arn}/broker.zip"] },
    { Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion"], Resource = "${aws_s3_bucket.bundle.arn}/broker.zip" },
    { Effect = "Allow", Action = ["lambda:UpdateFunctionCode", "lambda:PublishVersion", "lambda:GetFunctionConfiguration", "lambda:GetAlias", "lambda:UpdateAlias", "lambda:InvokeFunction"],
      Resource = flatten([for purpose in keys(local.brokers) : [
        "arn:aws:lambda:${local.region}:${local.account}:function:videoq-db-start-${purpose}-prod",
        "arn:aws:lambda:${local.region}:${local.account}:function:videoq-db-start-${purpose}-prod:*"
    ]]) },
    { Effect = "Allow", Action = ["codebuild:BatchGetProjects", "codebuild:UpdateProject"],
    Resource = [for name in values(local.projects) : "arn:aws:codebuild:${local.region}:${local.account}:project/${name}"] },
    { Effect = "Allow", Action = ["states:DescribeStateMachine", "states:UpdateStateMachine"],
    Resource = "arn:aws:states:${local.region}:${local.account}:stateMachine:${local.name}" },
    { Effect = "Allow", Action = ["states:ValidateStateMachineDefinition"], Resource = "*" },
    { Effect = "Deny", Action = ["ssm:*", "secretsmanager:*", "kms:Decrypt", "iam:*"], Resource = "*" }
  ] })
}
resource "aws_codebuild_project" "deploy" {
  name                   = "videoq-db-deploy-prod"
  service_role           = aws_iam_role.deploy.arn
  build_timeout          = 20
  queued_timeout         = 30
  concurrent_build_limit = 1
  artifacts { type = "NO_ARTIFACTS" }
  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:7.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
    privileged_mode             = false
  }
  source {
    type = "NO_SOURCE"
    buildspec = jsonencode({ version = "0.2", phases = {
      install = { "runtime-versions" = { nodejs = 26, python = "3.12" } },
      build = { commands = [
        "python3 -c 'import os,re; assert re.fullmatch(\"[a-f0-9]{40}\", os.environ.get(\"MAINTENANCE_SOURCE_SHA\",\"\"))'",
        "mkdir -p /tmp/videoq-db-source && cd /tmp/videoq-db-source",
        "git init --quiet && git remote add origin https://github.com/videoq-jp/videoq.git",
        "git fetch --quiet --depth=1 origin \"$MAINTENANCE_SOURCE_SHA\" && git checkout --quiet --detach FETCH_HEAD",
        "test \"$(git rev-parse HEAD)\" = \"$MAINTENANCE_SOURCE_SHA\"",
        "npm ci --ignore-scripts --prefix infra/db-maintenance/runtime",
        "npm audit signatures --prefix infra/db-maintenance/runtime",
        "python3 infra/db-maintenance/build_bundle.py --output /tmp/videoq-db-bundles",
        "python3 infra/db-maintenance/deploy.py"
      ] }
    } })
  }
  logs_config {
    cloudwatch_logs { group_name = aws_cloudwatch_log_group.deploy.name }
  }
  depends_on = [aws_iam_role_policy.deploy]
}
