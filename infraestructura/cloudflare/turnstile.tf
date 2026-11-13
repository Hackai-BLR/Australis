resource "cloudflare_turnstile_widget" "login" {
  account_id = var.cuenta_id
  name       = "campusia-login"
  mode       = "managed"
  domains    = [var.dominio]
}
