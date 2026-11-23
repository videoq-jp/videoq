# __generated__ by Terraform
# Please review these resources and move them into your main configuration files.





# __generated__ by Terraform from "16f30b629ba107705212b367d51e66c1/69c7233e987abe072ba8b7911b998612"
resource "cloudflare_dns_record" "record_69c7233e987abe072ba8b7911b998612" {
  comment                 = null
  content                 = "mailgun.org"
  data                    = null
  include_shadow_metadata = false
  name                    = "email.mg.videoq.jp"
  priority                = null
  private_routing         = null
  proxied                 = false
  settings = {
    flatten_cname = false
    ipv4_only     = false
    ipv6_only     = false
  }
  tags    = []
  ttl     = 1
  type    = "CNAME"
  zone_id = "16f30b629ba107705212b367d51e66c1"
}



# __generated__ by Terraform from "16f30b629ba107705212b367d51e66c1/7c79a28c42e55246623b25d90a114510"
resource "cloudflare_dns_record" "record_7c79a28c42e55246623b25d90a114510" {
  comment                 = null
  content                 = "\"v=spf1 include:_spf.mx.cloudflare.net ~all\""
  data                    = null
  include_shadow_metadata = false
  name                    = "videoq.jp"
  priority                = null
  private_routing         = null
  proxied                 = false
  settings = {
  }
  tags    = []
  ttl     = 1
  type    = "TXT"
  zone_id = "16f30b629ba107705212b367d51e66c1"
}

# __generated__ by Terraform from "16f30b629ba107705212b367d51e66c1/c1963eb4631fd0f3b8afd0ed6a9e770e"
resource "cloudflare_dns_record" "record_c1963eb4631fd0f3b8afd0ed6a9e770e" {
  comment                 = null
  content                 = "\"v=spf1 include:mailgun.org ~all\""
  data                    = null
  include_shadow_metadata = false
  name                    = "mg.videoq.jp"
  priority                = null
  private_routing         = null
  proxied                 = false
  settings = {
  }
  tags    = []
  ttl     = 1
  type    = "TXT"
  zone_id = "16f30b629ba107705212b367d51e66c1"
}


# __generated__ by Terraform from "16f30b629ba107705212b367d51e66c1/aedf82b17222306b5095d8be00c9b5be"
resource "cloudflare_dns_record" "record_aedf82b17222306b5095d8be00c9b5be" {
  comment                 = null
  content                 = "\"k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDFAd23oC0mqlzLaK9Ibvz5o6Wv/TIcrnl5tEQaGGMJs3kWMJlsjKtogf0HTCtfHRVHlyWHXqnVC3OUVvOKZ/npw6r2b2isDA5yO7oQuUJXqbJdAKfKk+RqtPsqlktp++wNEtTux3wuFFG0NYMonc/MGU8ie3wsI3yHRnH+bqSDvQIDAQAB\""
  data                    = null
  include_shadow_metadata = false
  name                    = "mailo._domainkey.mg.videoq.jp"
  priority                = null
  private_routing         = null
  proxied                 = false
  settings = {
  }
  tags    = []
  ttl     = 1
  type    = "TXT"
  zone_id = "16f30b629ba107705212b367d51e66c1"
}

# __generated__ by Terraform from "16f30b629ba107705212b367d51e66c1/ce6943fb105387a2453e77112ffacf8b"
resource "cloudflare_dns_record" "record_ce6943fb105387a2453e77112ffacf8b" {
  comment                 = null
  content                 = "133.18.104.119"
  data                    = null
  include_shadow_metadata = false
  name                    = "moodle.videoq.jp"
  priority                = null
  private_routing         = null
  proxied                 = false
  settings = {
  }
  tags    = []
  ttl     = 1
  type    = "A"
  zone_id = "16f30b629ba107705212b367d51e66c1"
}

# __generated__ by Terraform from "16f30b629ba107705212b367d51e66c1/f740d6e31cf68d315fc39db09fc5facd"
resource "cloudflare_dns_record" "record_f740d6e31cf68d315fc39db09fc5facd" {
  comment                 = null
  content                 = "mxa.mailgun.org"
  data                    = null
  include_shadow_metadata = false
  name                    = "mg.videoq.jp"
  priority                = 10
  private_routing         = null
  proxied                 = false
  settings = {
  }
  tags    = []
  ttl     = 1
  type    = "MX"
  zone_id = "16f30b629ba107705212b367d51e66c1"
}


# __generated__ by Terraform from "16f30b629ba107705212b367d51e66c1/20272f25d96af506ba24c51d80bf6cb1"
resource "cloudflare_dns_record" "record_20272f25d96af506ba24c51d80bf6cb1" {
  comment                 = null
  content                 = "\"google-site-verification=_YnaVit0Fp6UxwbovfUWGZLJxWxDHQjV1Vs3ev0Cjck\""
  data                    = null
  include_shadow_metadata = false
  name                    = "videoq.jp"
  priority                = null
  private_routing         = null
  proxied                 = false
  settings = {
  }
  tags    = []
  ttl     = 3600
  type    = "TXT"
  zone_id = "16f30b629ba107705212b367d51e66c1"
}

# __generated__ by Terraform from "16f30b629ba107705212b367d51e66c1/325d37236fd202caf6b8c3b4fca54efa"
resource "cloudflare_dns_record" "record_325d37236fd202caf6b8c3b4fca54efa" {
  comment                 = null
  content                 = "mxb.mailgun.org"
  data                    = null
  include_shadow_metadata = false
  name                    = "mg.videoq.jp"
  priority                = 10
  private_routing         = null
  proxied                 = false
  settings = {
  }
  tags    = []
  ttl     = 1
  type    = "MX"
  zone_id = "16f30b629ba107705212b367d51e66c1"
}

resource "cloudflare_zone" "videoq" {
  account = { id = "12daec56fdba43f677f2766ee26a5a39" }
  name    = "videoq.jp"
  type    = "full"
  paused  = false
  lifecycle { prevent_destroy = true }
}
