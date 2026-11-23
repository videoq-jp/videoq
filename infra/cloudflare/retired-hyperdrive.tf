# No Worker in the account references the retired Neon connection.
removed {
  from = cloudflare_hyperdrive_config.retired_neon
  lifecycle { destroy = true }
}
