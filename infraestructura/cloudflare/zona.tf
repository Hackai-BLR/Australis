resource "cloudflare_zone_setting" "ssl" {
  zone_id    = var.zona_id
  setting_id = "ssl"
  value      = "strict"
}

resource "cloudflare_zone_setting" "always_use_https" {
  zone_id    = var.zona_id
  setting_id = "always_use_https"
  value      = "on"
}

resource "cloudflare_zone_setting" "tls_minimo" {
  zone_id    = var.zona_id
  setting_id = "min_tls_version"
  value      = "1.2"
}
