terraform {
  backend "s3" {
    bucket                      = "videoq-terraform-state-prod"
    key                         = "videoq/prod/search-evaluation.tfstate"
    region                      = "auto"
    profile                     = "videoq-r2-state"
    endpoints                   = { s3 = "https://12daec56fdba43f677f2766ee26a5a39.r2.cloudflarestorage.com" }
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true
    use_lockfile                = true
  }
  required_version = ">= 1.15.1, < 2.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
  }
}

# Deliberately separate from infra/: no production state, schedules, or IAM edits.
# Its independent R2 key is shared; see README.md before planning.
provider "aws" {
  region              = "ap-northeast-1"
  allowed_account_ids = ["257240362763"]
}

# Retired: the provider-specific embedding evaluation Lambda is no longer used.
# Keep this backend so Terraform can remove its Lambda and dedicated log group
# and retain the state history. Production inference runs in Workers AI.
