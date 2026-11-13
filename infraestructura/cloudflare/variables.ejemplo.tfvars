cuenta_id              = "00000000000000000000000000000000"
zona_id                = "11111111111111111111111111111111"
dominio                = "ejemplo.com"
ip_servidor            = "203.0.113.10"
correo_destino_reenvio = "destino@ejemplo.com"
csr_origen             = <<-EOT
  -----BEGIN CERTIFICATE REQUEST-----
  CSR-FICTICIO
  -----END CERTIFICATE REQUEST-----
EOT

ids_existentes = {
  apex             = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  comodin          = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  brevo1_dkim      = "cccccccccccccccccccccccccccccccc"
  brevo2_dkim      = "dddddddddddddddddddddddddddddddd"
  brevo_codigo     = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  dmarc            = "ffffffffffffffffffffffffffffffff"
  spf              = "99999999999999999999999999999999"
  reenvio          = "11111111111111111111111111111111"
  destino          = "88888888888888888888888888888888"
  hola             = "77777777777777777777777777777777"
  ssl              = "ssl"
  always_use_https = "always_use_https"
  tls_minimo       = "min_tls_version"
  login            = "0x0000000000000000000000"
  origen           = "000000000000000000000000000000000000000000000000"
}
