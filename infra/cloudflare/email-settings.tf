resource "cloudflare_email_routing_settings" "production" {
  zone_id            = "16f30b629ba107705212b367d51e66c1"
  support_subaddress = false

  lifecycle {
    prevent_destroy = true
    postcondition {
      condition     = self.enabled && self.status == "ready"
      error_message = "Production Email Routing must remain enabled and ready."
    }
  }
}

resource "cloudflare_email_routing_address" "destination" {
  account_id = "12daec56fdba43f677f2766ee26a5a39"
  email      = var.email_addresses[5]

  lifecycle {
    prevent_destroy = true
    postcondition {
      condition     = self.verified != null
      error_message = "The existing routing destination must remain verified."
    }
  }
}

import {
  to = cloudflare_email_routing_settings.production
  id = "16f30b629ba107705212b367d51e66c1"
}

import {
  to = cloudflare_email_routing_address.destination
  id = "12daec56fdba43f677f2766ee26a5a39/5ac92cc7067a4928ad24ea98260a1dc5"
}
