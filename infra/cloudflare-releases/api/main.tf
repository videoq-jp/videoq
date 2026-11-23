terraform {
  required_version = ">= 1.15.1, < 2.0"
  backend "s3" {
    bucket                      = "videoq-terraform-state-prod"
    key                         = "videoq/prod/workers/api.tfstate"
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
  required_providers { cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.29.0" } }
}
provider "cloudflare" {}

variable "release" {
  type = any
}

module "release" {
  source      = "../../modules/cloudflare-release"
  account_id  = "12daec56fdba43f677f2766ee26a5a39"
  worker_id   = "3dcc0f4ac330413d970b5da7eadec8ea"
  script_name = "videoq-api"
  release     = var.release
}
