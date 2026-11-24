# This account issuer existed only for the retired inference provider. It was
# imported read-only into this R2 state before retirement. Keeping a removal
# declaration records the intent without declaring a resource that enables it.
removed {
  from = aws_iam_outbound_web_identity_federation.retired_openrouter

  lifecycle {
    destroy = true
  }
}
