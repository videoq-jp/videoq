# The provider has no importer for this setting. PUT is idempotent and the
# initial apply preserves the existing production rule byte for byte.
resource "cloudflare_r2_bucket_cors" "media" {
  account_id  = cloudflare_r2_bucket.videoq_media_prod.account_id
  bucket_name = cloudflare_r2_bucket.videoq_media_prod.name
  rules = [{
    id = "videoq-browser-media"
    allowed = {
      origins = ["https://videoq.jp"]
      methods = ["GET", "HEAD", "PUT"]
      headers = ["Content-Type", "Range"]
    }
    expose_headers  = ["Accept-Ranges", "Content-Length", "Content-Range", "ETag"]
    max_age_seconds = 3600
  }]
  lifecycle { prevent_destroy = true }
}

resource "cloudflare_r2_managed_domain" "private" {
  for_each    = toset(["videoq-media-prod", "videoq-media-migration-staging-v3"])
  account_id  = "12daec56fdba43f677f2766ee26a5a39"
  bucket_name = each.value
  enabled     = false
  lifecycle { prevent_destroy = true }
}
resource "cloudflare_r2_bucket_lifecycle" "multipart" {
  for_each    = toset(["videoq-media-prod", "videoq-media-migration-staging-v3"])
  account_id  = "12daec56fdba43f677f2766ee26a5a39"
  bucket_name = each.value
  rules = [{
    id                                 = "Default Multipart Abort Rule"
    enabled                            = true
    conditions                         = { prefix = "" }
    abort_multipart_uploads_transition = { condition = { type = "Age", max_age = 604800 } }
  }]
  lifecycle { prevent_destroy = true }
}
