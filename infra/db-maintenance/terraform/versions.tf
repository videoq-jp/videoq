terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
  }
  backend "s3" {
    key          = "videoq/prod/db-maintenance.tfstate"
    region       = "ap-northeast-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region              = "ap-northeast-1"
  allowed_account_ids = ["257240362763"]
}
