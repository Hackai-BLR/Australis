import {
  for_each = { for clave, id in var.ids_existentes : clave => (strcontains(id, "/") ? id : "${var.zona_id}/${id}") if contains(keys(local.registros), clave) && id != "" }
  to       = cloudflare_dns_record.registros[each.key]
  id       = each.value
}

import {
  for_each = { for clave, id in var.ids_existentes : clave => var.zona_id if clave == "reenvio" && id != "" }
  to       = cloudflare_email_routing_dns.reenvio
  id       = each.value
}

import {
  for_each = { for clave, id in var.ids_existentes : clave => (strcontains(id, "/") ? id : "${var.cuenta_id}/${id}") if clave == "destino" && id != "" }
  to       = cloudflare_email_routing_address.destino
  id       = each.value
}

import {
  for_each = { for clave, id in var.ids_existentes : clave => (strcontains(id, "/") ? id : "${var.zona_id}/${id}") if clave == "hola" && id != "" }
  to       = cloudflare_email_routing_rule.hola
  id       = each.value
}

import {
  for_each = { for clave, id in var.ids_existentes : clave => "${var.zona_id}/ssl" if clave == "ssl" && id != "" }
  to       = cloudflare_zone_setting.ssl
  id       = each.value
}

import {
  for_each = { for clave, id in var.ids_existentes : clave => "${var.zona_id}/always_use_https" if clave == "always_use_https" && id != "" }
  to       = cloudflare_zone_setting.always_use_https
  id       = each.value
}

import {
  for_each = { for clave, id in var.ids_existentes : clave => "${var.zona_id}/min_tls_version" if clave == "tls_minimo" && id != "" }
  to       = cloudflare_zone_setting.tls_minimo
  id       = each.value
}

import {
  for_each = { for clave, id in var.ids_existentes : clave => (strcontains(id, "/") ? id : "${var.cuenta_id}/${id}") if clave == "login" && id != "" }
  to       = cloudflare_turnstile_widget.login
  id       = each.value
}

import {
  for_each = { for clave, id in var.ids_existentes : clave => id if clave == "origen" && id != "" }
  to       = cloudflare_origin_ca_certificate.origen
  id       = each.value
}
