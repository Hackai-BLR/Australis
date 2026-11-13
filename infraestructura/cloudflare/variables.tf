variable "cloudflare_api_token" {
  type      = string
  sensitive = true
}

variable "cuenta_id" {
  type    = string
  default = "00000000000000000000000000000000"
}

variable "zona_id" {
  type    = string
  default = "11111111111111111111111111111111"
}

variable "dominio" {
  type    = string
  default = "campusia.tech"
}

variable "ip_servidor" {
  type = string

  validation {
    condition     = can(regex("^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$", var.ip_servidor))
    error_message = "ip_servidor tiene que ser una dirección IPv4."
  }
}

variable "correo_destino_reenvio" {
  type = string
}

variable "csr_origen" {
  type = string
}

variable "ids_existentes" {
  type    = map(string)
  default = {}
}
