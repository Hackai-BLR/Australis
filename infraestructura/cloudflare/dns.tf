locals {
  registros = {
    apex = {
      type    = "A"
      name    = var.dominio
      content = var.ip_servidor
      proxied = true
    }
    comodin = {
      type    = "A"
      name    = "*.${var.dominio}"
      content = var.ip_servidor
      proxied = true
    }
    brevo1_dkim = {
      type    = "CNAME"
      name    = "brevo1._domainkey.${var.dominio}"
      content = "b1.campusia-tech.dkim.brevo.com"
      proxied = false
    }
    brevo2_dkim = {
      type    = "CNAME"
      name    = "brevo2._domainkey.${var.dominio}"
      content = "b2.campusia-tech.dkim.brevo.com"
      proxied = false
    }
    brevo_codigo = {
      type    = "TXT"
      name    = var.dominio
      content = "\"brevo-code:04c2a6176a3004dcafba5dfca20c83a8\""
      proxied = false
    }
    dmarc = {
      type    = "TXT"
      name    = "_dmarc.${var.dominio}"
      content = "\"v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com\""
      proxied = false
    }
    spf = {
      type    = "TXT"
      name    = var.dominio
      content = "\"v=spf1 include:_spf.mx.cloudflare.net include:spf.brevo.com ~all\""
      proxied = false
    }
  }
}

resource "cloudflare_dns_record" "registros" {
  for_each = local.registros

  zone_id = var.zona_id
  type    = each.value.type
  name    = each.value.name
  content = each.value.content
  proxied = each.value.proxied
  ttl     = 1
}
