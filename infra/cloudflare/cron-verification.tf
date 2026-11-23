# Provider 5.29 marks schedules as no_refresh. Independently observe every
# schedule so out-of-band additions/removals cannot silently pass a clean plan.
data "external" "schedules" {
  program = ["node", "${path.module}/../bin/read-worker-schedules.cjs"]
  query   = {}
  depends_on = [
    cloudflare_workers_cron_trigger.videoq_api,
    cloudflare_workers_cron_trigger.videoq_web,
    cloudflare_workers_cron_trigger.videoq_docs,
    cloudflare_workers_cron_trigger.videoq_maintenance_prod,
  ]
}
resource "terraform_data" "cron_verification" {
  input = data.external.schedules.result.schedules
  lifecycle {
    precondition {
      condition = jsonencode(jsondecode(data.external.schedules.result.schedules)) == jsonencode({
        videoq-api              = ["17 3 * * *"]
        videoq-web              = []
        videoq-docs             = []
        videoq-maintenance-prod = []
      })
      error_message = "Live Worker cron schedules differ from the Terraform definition; reconcile before applying."
    }
  }
}
