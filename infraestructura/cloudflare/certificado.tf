resource "cloudflare_origin_ca_certificate" "origen" {
  csr                = var.csr_origen
  hostnames          = [var.dominio, "*.${var.dominio}"]
  request_type       = "origin-ecc"
  requested_validity = 5475

  lifecycle {
    prevent_destroy = true
    ignore_changes  = all
  }
}
