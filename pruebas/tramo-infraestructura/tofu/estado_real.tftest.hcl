mock_provider "cloudflare" {}

variables {
  cloudflare_api_token   = "token-de-prueba-00000000000000000000000000"
  frase_estado           = "frase-de-prueba-para-el-estado-0001"
  correo_destino_reenvio = "destino@ejemplo.com"
  ip_servidor            = "203.0.113.10"
  csr_origen             = <<-EOT
    -----BEGIN CERTIFICATE REQUEST-----
    MIHSMHoCAQAwGDEWMBQGA1UEAwwNY2FtcHVzaWEudGVjaDBZMBMGByqGSM49AgEG
    CCqGSM49AwEHA0IABBJasgTNuk8fbxsarKy3t+nKb41Y3g22gR8MQt1I6KWY+uHY
    OlfeWogbZdaClwKrFyONam6SgfkAwqJ6zIH5yuGgADAKBggqhkjOPQQDAgNIADBF
    AiEA3lRWy/BW6xj3rCDja6XUnLdrxkh1A/7aC+9iiIeGJ80CIAKZ/bZCTnwGzETS
    Vb2LCOvuDcSCGH7owYDQurJ31kjE
    -----END CERTIFICATE REQUEST-----
  EOT
}

run "estado_real" {
  command = plan

  assert {
    condition     = length(cloudflare_dns_record.registros) == 7
    error_message = "tienen que ser exactamente 7 registros: apex, comodin, brevo1_dkim, brevo2_dkim, brevo_codigo, dmarc, spf"
  }

  assert {
    condition     = alltrue([for k, r in cloudflare_dns_record.registros : r.zone_id == "11111111111111111111111111111111" && r.ttl == 1])
    error_message = "todos los registros van en la zona campusia.tech con ttl automático"
  }

  assert {
    condition = (
      cloudflare_dns_record.registros["apex"].type == "A" &&
      cloudflare_dns_record.registros["apex"].name == "campusia.tech" &&
      cloudflare_dns_record.registros["apex"].content == "203.0.113.10" &&
      cloudflare_dns_record.registros["apex"].proxied == true
    )
    error_message = "registro A del apex"
  }

  assert {
    condition = (
      cloudflare_dns_record.registros["comodin"].type == "A" &&
      cloudflare_dns_record.registros["comodin"].name == "*.campusia.tech" &&
      cloudflare_dns_record.registros["comodin"].content == "203.0.113.10" &&
      cloudflare_dns_record.registros["comodin"].proxied == true
    )
    error_message = "registro A comodín"
  }

  assert {
    condition = (
      cloudflare_dns_record.registros["brevo1_dkim"].type == "CNAME" &&
      cloudflare_dns_record.registros["brevo1_dkim"].name == "brevo1._domainkey.campusia.tech" &&
      cloudflare_dns_record.registros["brevo1_dkim"].content == "b1.campusia-tech.dkim.brevo.com" &&
      cloudflare_dns_record.registros["brevo1_dkim"].proxied == false
    )
    error_message = "CNAME brevo1 sin proxy"
  }

  assert {
    condition = (
      cloudflare_dns_record.registros["brevo2_dkim"].type == "CNAME" &&
      cloudflare_dns_record.registros["brevo2_dkim"].name == "brevo2._domainkey.campusia.tech" &&
      cloudflare_dns_record.registros["brevo2_dkim"].content == "b2.campusia-tech.dkim.brevo.com" &&
      cloudflare_dns_record.registros["brevo2_dkim"].proxied == false
    )
    error_message = "CNAME brevo2 sin proxy"
  }

  assert {
    condition = (
      cloudflare_dns_record.registros["brevo_codigo"].type == "TXT" &&
      cloudflare_dns_record.registros["brevo_codigo"].name == "campusia.tech" &&
      replace(cloudflare_dns_record.registros["brevo_codigo"].content, "\"", "") == "brevo-code:04c2a6176a3004dcafba5dfca20c83a8"
    )
    error_message = "TXT de verificación de Brevo"
  }

  assert {
    condition = (
      cloudflare_dns_record.registros["dmarc"].type == "TXT" &&
      cloudflare_dns_record.registros["dmarc"].name == "_dmarc.campusia.tech" &&
      replace(cloudflare_dns_record.registros["dmarc"].content, "\"", "") == "v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com"
    )
    error_message = "TXT de DMARC"
  }

  assert {
    condition = (
      cloudflare_dns_record.registros["spf"].type == "TXT" &&
      cloudflare_dns_record.registros["spf"].name == "campusia.tech" &&
      replace(cloudflare_dns_record.registros["spf"].content, "\"", "") == "v=spf1 include:_spf.mx.cloudflare.net include:spf.brevo.com ~all"
    )
    error_message = "TXT de SPF"
  }

  assert {
    condition     = cloudflare_email_routing_dns.reenvio.zone_id == "11111111111111111111111111111111"
    error_message = "reenvío de correo activo en la zona"
  }

  assert {
    condition = (
      cloudflare_email_routing_address.destino.account_id == "00000000000000000000000000000000" &&
      cloudflare_email_routing_address.destino.email == "destino@ejemplo.com"
    )
    error_message = "dirección de destino del reenvío"
  }

  assert {
    condition = (
      cloudflare_email_routing_rule.hola.zone_id == "11111111111111111111111111111111" &&
      cloudflare_email_routing_rule.hola.enabled == true &&
      cloudflare_email_routing_rule.hola.matchers[0].type == "literal" &&
      cloudflare_email_routing_rule.hola.matchers[0].field == "to" &&
      cloudflare_email_routing_rule.hola.matchers[0].value == "hola@campusia.tech" &&
      cloudflare_email_routing_rule.hola.actions[0].type == "forward" &&
      contains(cloudflare_email_routing_rule.hola.actions[0].value, "destino@ejemplo.com")
    )
    error_message = "regla de reenvío de hola@campusia.tech"
  }

  assert {
    condition = (
      cloudflare_zone_setting.ssl.zone_id == "11111111111111111111111111111111" &&
      cloudflare_zone_setting.ssl.setting_id == "ssl" &&
      cloudflare_zone_setting.ssl.value == "strict"
    )
    error_message = "SSL Full (strict)"
  }

  assert {
    condition = (
      cloudflare_zone_setting.always_use_https.setting_id == "always_use_https" &&
      cloudflare_zone_setting.always_use_https.value == "on"
    )
    error_message = "siempre HTTPS"
  }

  assert {
    condition = (
      cloudflare_zone_setting.tls_minimo.setting_id == "min_tls_version" &&
      cloudflare_zone_setting.tls_minimo.value == "1.2"
    )
    error_message = "TLS mínimo 1.2"
  }

  assert {
    condition = (
      cloudflare_turnstile_widget.login.account_id == "00000000000000000000000000000000" &&
      cloudflare_turnstile_widget.login.name == "campusia-login" &&
      cloudflare_turnstile_widget.login.mode == "managed" &&
      length(cloudflare_turnstile_widget.login.domains) == 1 &&
      contains(cloudflare_turnstile_widget.login.domains, "campusia.tech")
    )
    error_message = "widget de Turnstile campusia-login"
  }

  assert {
    condition = (
      cloudflare_origin_ca_certificate.origen.request_type == "origin-ecc" &&
      cloudflare_origin_ca_certificate.origen.requested_validity == 5475 &&
      toset(cloudflare_origin_ca_certificate.origen.hostnames) == toset(["campusia.tech", "*.campusia.tech"])
    )
    error_message = "certificado de origen ECC de 15 años"
  }
}

run "ip_por_variable" {
  command = plan

  variables {
    ip_servidor = "198.51.100.20"
  }

  assert {
    condition = (
      cloudflare_dns_record.registros["apex"].content == "198.51.100.20" &&
      cloudflare_dns_record.registros["comodin"].content == "198.51.100.20"
    )
    error_message = "la IP del servidor sale de var.ip_servidor"
  }
}
