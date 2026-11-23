variable "email_addresses" {
  type      = list(string)
  sensitive = true
}
resource "cloudflare_workers_cron_trigger" "videoq_api" {
  account_id  = "12daec56fdba43f677f2766ee26a5a39"
  schedules   = [{ cron = "17 3 * * *" }]
  script_name = "videoq-api"
}

# __generated__ by Terraform from "16f30b629ba107705212b367d51e66c1/208360ba97fc422a9cc7b766b2ee6b53"
resource "cloudflare_email_routing_rule" "rule_4" {
  actions = [
    {
      type  = "forward"
      value = [var.email_addresses[5]]
    },
  ]
  enabled = true
  matchers = [
    {
      field = "to"
      type  = "literal"
      value = var.email_addresses[4]
    },
  ]
  name             = ""
  owner_worker_tag = null
  priority         = 0
  source           = "api"
  zone_id          = "16f30b629ba107705212b367d51e66c1"
}

# __generated__ by Terraform from "16f30b629ba107705212b367d51e66c1/4a4d3e93bcd34b5fb2362015911bf73f"
resource "cloudflare_email_routing_rule" "rule_0" {
  actions = [
    {
      type  = "forward"
      value = [var.email_addresses[5]]
    },
  ]
  enabled = true
  matchers = [
    {
      field = "to"
      type  = "literal"
      value = var.email_addresses[3]
    },
  ]
  name             = ""
  owner_worker_tag = null
  priority         = 0
  source           = "api"
  zone_id          = "16f30b629ba107705212b367d51e66c1"
}

# __generated__ by Terraform from "12daec56fdba43f677f2766ee26a5a39/videoq-web/336fbac9-e988-4fe6-a922-afb7aef8ad42"
resource "cloudflare_workers_cron_trigger" "videoq_maintenance_prod" {
  account_id  = "12daec56fdba43f677f2766ee26a5a39"
  schedules   = []
  script_name = "videoq-maintenance-prod"
}

# __generated__ by Terraform
resource "cloudflare_workers_cron_trigger" "videoq_docs" {
  account_id  = "12daec56fdba43f677f2766ee26a5a39"
  schedules   = []
  script_name = "videoq-docs"
}

# __generated__ by Terraform from "16f30b629ba107705212b367d51e66c1"
resource "cloudflare_email_routing_catch_all" "default" {
  actions = [
    {
      type  = "drop"
      value = null
    },
  ]
  enabled = false
  matchers = [
    {
      type = "all"
    },
  ]
  name             = ""
  owner_worker_tag = null
  source           = "api"
  zone_id          = "16f30b629ba107705212b367d51e66c1"
}

# __generated__ by Terraform
resource "cloudflare_workers_cron_trigger" "videoq_web" {
  account_id  = "12daec56fdba43f677f2766ee26a5a39"
  schedules   = []
  script_name = "videoq-web"
}

# __generated__ by Terraform from "12daec56fdba43f677f2766ee26a5a39/videoq-api/29befe24-5fcd-4d0a-90ca-d57025ec6c2c"
resource "cloudflare_email_routing_rule" "rule_2" {
  actions = [
    {
      type  = "forward"
      value = [var.email_addresses[5]]
    },
  ]
  enabled = true
  matchers = [
    {
      field = "to"
      type  = "literal"
      value = var.email_addresses[2]
    },
  ]
  name             = ""
  owner_worker_tag = null
  priority         = 0
  source           = "api"
  zone_id          = "16f30b629ba107705212b367d51e66c1"
}

# __generated__ by Terraform from "12daec56fdba43f677f2766ee26a5a39/c88c9689dc314e06813e3fee6ceb7287/eec88b89-6be8-4ad2-bec4-def62b8c7560"
resource "cloudflare_email_routing_rule" "rule_3" {
  actions = [
    {
      type  = "forward"
      value = [var.email_addresses[5]]
    },
  ]
  enabled = true
  matchers = [
    {
      field = "to"
      type  = "literal"
      value = var.email_addresses[1]
    },
  ]
  name             = "GitHub notifications"
  owner_worker_tag = null
  priority         = 0
  source           = "api"
  zone_id          = "16f30b629ba107705212b367d51e66c1"
}

# __generated__ by Terraform from "16f30b629ba107705212b367d51e66c1/2b9ad579304049d3932befa2b6f6dde7"
resource "cloudflare_email_routing_rule" "rule_1" {
  actions = [
    {
      type  = "forward"
      value = [var.email_addresses[5]]
    },
  ]
  enabled = true
  matchers = [
    {
      field = "to"
      type  = "literal"
      value = var.email_addresses[0]
    },
  ]
  name             = ""
  owner_worker_tag = null
  priority         = 0
  source           = "api"
  zone_id          = "16f30b629ba107705212b367d51e66c1"
}

# __generated__ by Terraform from "12daec56fdba43f677f2766ee26a5a39/3dcc0f4ac330413d970b5da7eadec8ea/7d155c9f-adb1-48c4-8b77-dd48c52745a3"
