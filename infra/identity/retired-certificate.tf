# Expired, unbound legacy certificate and its matching DNS validation record
# were retired after an inventory across all 17 enabled AWS regions.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

removed {
  from = aws_acm_certificate.legacy_videoq_certificate
  lifecycle { destroy = true }
}
