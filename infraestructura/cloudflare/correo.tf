resource "cloudflare_email_routing_dns" "reenvio" {
  zone_id = var.zona_id
}

resource "cloudflare_email_routing_address" "destino" {
  account_id = var.cuenta_id
  email      = var.correo_destino_reenvio
}

resource "cloudflare_email_routing_rule" "hola" {
  zone_id = var.zona_id
  name    = "hola@${var.dominio}"
  enabled = true

  matchers = [{
    type  = "literal"
    field = "to"
    value = "hola@${var.dominio}"
  }]

  actions = [{
    type  = "forward"
    value = [var.correo_destino_reenvio]
  }]

  depends_on = [cloudflare_email_routing_address.destino]
}
