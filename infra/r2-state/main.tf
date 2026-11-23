terraform {
  required_version = ">= 1.15.1, < 2.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.29.0"
    }
  }
  # Bootstrap with a private local backend, then migrate this root to its own R2 bucket.
  backend "s3" {
    bucket                      = "videoq-terraform-state-prod"
    key                         = "videoq/bootstrap/r2.tfstate"
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
}
provider "cloudflare" {}
resource "cloudflare_r2_bucket" "state" {
  account_id    = "12daec56fdba43f677f2766ee26a5a39"
  name          = "videoq-terraform-state-prod"
  location      = "APAC"
  storage_class = "Standard"
  lifecycle { prevent_destroy = true }
}

# R2 does not provide S3 bucket versioning. Keep immutable pre-apply snapshots
# outside the live state/lock paths so recovery copies cannot be overwritten.
resource "cloudflare_r2_bucket_lock" "history" {
  account_id  = cloudflare_r2_bucket.state.account_id
  bucket_name = cloudflare_r2_bucket.state.name
  rules = [{
    id        = "terraform-state-history-90-days"
    enabled   = true
    prefix    = "history/"
    condition = { type = "Age", max_age_seconds = 7776000 }
  }]
  lifecycle { prevent_destroy = true }
}
resource "cloudflare_r2_managed_domain" "private" {
  account_id  = cloudflare_r2_bucket.state.account_id
  bucket_name = cloudflare_r2_bucket.state.name
  enabled     = false
  lifecycle { prevent_destroy = true }
}
