terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.29.0" }
  }
}
variable "account_id" { type = string }
variable "worker_id" { type = string }
variable "script_name" { type = string }
variable "release" {
  type = any
}
resource "cloudflare_worker_version" "release" {
  account_id           = var.account_id
  worker_id            = var.worker_id
  annotations          = try(var.release.version.annotations, null)
  assets               = try(var.release.version.assets, null)
  bindings             = try(var.release.version.bindings, null)
  cache_options        = try(var.release.version.cache_options, null)
  compatibility_date   = try(var.release.version.compatibility_date, null)
  compatibility_flags  = try(var.release.version.compatibility_flags, null)
  containers           = try(var.release.version.containers, null)
  exports              = try(var.release.version.exports, null)
  limits               = try(var.release.version.limits, null)
  main_module          = try(var.release.version.main_module, null)
  migrations           = try(var.release.version.migrations, null)
  modules              = try(var.release.version.modules, null)
  package_dependencies = try(var.release.version.package_dependencies, null)
  placement            = try(var.release.version.placement, null)
  usage_model          = try(var.release.version.usage_model, null)
  # Immutable versions remain available for rollback; provider Delete is a no-op.
  lifecycle { create_before_destroy = true }
}
resource "cloudflare_workers_deployment" "active" {
  account_id  = var.account_id
  script_name = var.script_name
  strategy    = "percentage"
  annotations = try(var.release.deployment_annotations, null)
  versions    = [{ percentage = 100, version_id = cloudflare_worker_version.release.id }]
  lifecycle { create_before_destroy = true }
}
output "version_id" { value = cloudflare_worker_version.release.id }
