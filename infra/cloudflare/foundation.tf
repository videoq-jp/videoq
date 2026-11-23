# Existing production infrastructure, adopted without recreation.

resource "cloudflare_queue" "videoq_search_dlq_prod" {
  lifecycle { prevent_destroy = true }
  account_id   = "12daec56fdba43f677f2766ee26a5a39"
  jurisdiction = null
  queue_name   = "videoq-search-dlq-prod"
  settings = {
    delivery_delay           = 0
    message_retention_period = 1209600
  }
}

resource "cloudflare_queue" "videoq_account_dlq_prod" {
  lifecycle { prevent_destroy = true }
  account_id   = "12daec56fdba43f677f2766ee26a5a39"
  jurisdiction = null
  queue_name   = "videoq-account-dlq-prod"
  settings = {
    delivery_delay           = 0
    message_retention_period = 1209600
  }
}

resource "cloudflare_workers_route" "route_366e1720cdda4ad4b393f1d29560b8b3" {
  pattern = "videoq.jp/health"
  script  = "videoq-api"
  zone_id = "16f30b629ba107705212b367d51e66c1"
}

resource "cloudflare_workers_route" "route_1f3d1e90fa544cd0980d37d7e303259d" {
  pattern = "videoq.jp/.well-known/*"
  script  = "videoq-api"
  zone_id = "16f30b629ba107705212b367d51e66c1"
}

resource "cloudflare_worker" "videoq_web" {
  lifecycle { prevent_destroy = true }
  account_id = "12daec56fdba43f677f2766ee26a5a39"
  force      = null
  logpush    = false
  name       = "videoq-web"
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      head_sampling_rate = 1
      invocation_logs    = true
      persist            = true
    }
    traces = {
      enabled            = false
      head_sampling_rate = 1
      persist            = true
      propagation_policy = "authenticated"
    }
  }
  subdomain = {
    enabled          = false
    previews_enabled = false
  }
  tags = []
  tail_consumers = [
  ]
}

resource "cloudflare_workers_custom_domain" "domain_7b267c69033894b138ef7c30e232e69c91a99adb" {
  account_id       = "12daec56fdba43f677f2766ee26a5a39"
  enabled          = true
  hostname         = "www.videoq.jp"
  previews_enabled = false
  service          = "videoq-web"
  zone_id          = "16f30b629ba107705212b367d51e66c1"
  zone_name        = "videoq.jp"
}

resource "cloudflare_d1_database" "production" {
  lifecycle { prevent_destroy = true }
  account_id            = "12daec56fdba43f677f2766ee26a5a39"
  fields                = null
  jurisdiction          = null
  name                  = "videoq-prod-db"
  primary_location_hint = null
  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_queue" "videoq_search_prod" {
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [settings.delivery_paused]
  }
  account_id   = "12daec56fdba43f677f2766ee26a5a39"
  jurisdiction = null
  queue_name   = "videoq-search-prod"
  settings = {
    delivery_delay           = 0
    delivery_paused          = false
    message_retention_period = 345600
  }
}

resource "cloudflare_workers_route" "route_4100fd0216f14751898afa257ac0e51c" {
  pattern = "videoq.jp/internal/worker/*"
  script  = "videoq-api"
  zone_id = "16f30b629ba107705212b367d51e66c1"
}

resource "cloudflare_worker" "videoq_docs" {
  lifecycle { prevent_destroy = true }
  account_id = "12daec56fdba43f677f2766ee26a5a39"
  force      = null
  logpush    = false
  name       = "videoq-docs"
  observability = {
    enabled            = false
    head_sampling_rate = 1
    logs = {
      destinations       = []
      enabled            = false
      head_sampling_rate = 1
      invocation_logs    = true
      persist            = true
    }
    traces = {
      destinations       = []
      enabled            = false
      head_sampling_rate = 1
      persist            = true
      propagation_policy = "authenticated"
    }
  }
  subdomain = {
    enabled          = false
    previews_enabled = false
  }
  tags = []
  tail_consumers = [
  ]
}

resource "cloudflare_workers_custom_domain" "domain_196cdaf76ea9af0b7589425d6fdfa1479f9d09c9" {
  account_id       = "12daec56fdba43f677f2766ee26a5a39"
  enabled          = true
  hostname         = "videoq.jp"
  previews_enabled = false
  service          = "videoq-web"
  zone_id          = "16f30b629ba107705212b367d51e66c1"
  zone_name        = "videoq.jp"
}

resource "cloudflare_workers_route" "route_360f855f58fd41e8bec825e32b16f458" {
  pattern = "videoq.jp/ready"
  script  = "videoq-api"
  zone_id = "16f30b629ba107705212b367d51e66c1"
}

resource "cloudflare_workers_route" "route_af8dd1bf3b71453a9b7866a31ca9d3a2" {
  pattern = "videoq.jp/api/*"
  script  = "videoq-api"
  zone_id = "16f30b629ba107705212b367d51e66c1"
}

resource "cloudflare_worker" "videoq_maintenance_prod" {
  lifecycle { prevent_destroy = true }
  account_id = "12daec56fdba43f677f2766ee26a5a39"
  force      = null
  logpush    = false
  name       = "videoq-maintenance-prod"
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      head_sampling_rate = 1
      invocation_logs    = true
      persist            = true
    }
    traces = {
      enabled            = false
      head_sampling_rate = 1
      persist            = true
      propagation_policy = "authenticated"
    }
  }
  subdomain = {
    enabled          = true
    previews_enabled = true
  }
  tags = []
  tail_consumers = [
  ]
}

resource "cloudflare_workers_custom_domain" "domain_5c0be2079ca3b0add7114ddd5914048324433175" {
  account_id       = "12daec56fdba43f677f2766ee26a5a39"
  enabled          = true
  hostname         = "docs.videoq.jp"
  previews_enabled = false
  service          = "videoq-docs"
  zone_id          = "16f30b629ba107705212b367d51e66c1"
  zone_name        = "videoq.jp"
}

resource "cloudflare_queue" "videoq_account_prod" {
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [settings.delivery_paused]
  }
  account_id   = "12daec56fdba43f677f2766ee26a5a39"
  jurisdiction = null
  queue_name   = "videoq-account-prod"
  settings = {
    delivery_delay           = 0
    delivery_paused          = false
    message_retention_period = 345600
  }
}

resource "cloudflare_worker" "videoq_api" {
  lifecycle { prevent_destroy = true }
  account_id = "12daec56fdba43f677f2766ee26a5a39"
  force      = null
  logpush    = false
  name       = "videoq-api"
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      head_sampling_rate = 1
      invocation_logs    = true
      persist            = true
    }
    traces = {
      enabled            = true
      head_sampling_rate = 0.05
      persist            = true
      propagation_policy = "authenticated"
    }
  }
  subdomain = {
    enabled          = false
    previews_enabled = false
  }
  tags = []
  tail_consumers = [
  ]
}

resource "cloudflare_workflow" "search_index" {
  account_id        = "12daec56fdba43f677f2766ee26a5a39"
  class_name        = "SearchIndexWorkflow"
  concurrency       = null
  default_retention = null
  jurisdiction      = null
  limits            = null
  schedules         = null
  script_name       = "videoq-api"
  workflow_name     = "videoq-search-index-prod"
}

resource "cloudflare_r2_bucket" "videoq_media_migration_staging_v3" {
  lifecycle { prevent_destroy = true }
  account_id    = "12daec56fdba43f677f2766ee26a5a39"
  jurisdiction  = "default"
  location      = "APAC"
  name          = "videoq-media-migration-staging-v3"
  storage_class = "Standard"
}

resource "cloudflare_r2_bucket" "videoq_media_prod" {
  lifecycle { prevent_destroy = true }
  account_id    = "12daec56fdba43f677f2766ee26a5a39"
  jurisdiction  = "default"
  location      = "APAC"
  name          = "videoq-media-prod"
  storage_class = "Standard"
}
