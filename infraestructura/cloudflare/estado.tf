terraform {
  backend "local" {
    path = "estado/terraform.tfstate"
  }

  encryption {
    key_provider "pbkdf2" "frase" {
      passphrase = var.frase_estado
    }

    method "aes_gcm" "cifrado" {
      keys = key_provider.pbkdf2.frase
    }

    state {
      method   = method.aes_gcm.cifrado
      enforced = true
    }

    plan {
      method   = method.aes_gcm.cifrado
      enforced = true
    }
  }
}

variable "frase_estado" {
  type      = string
  sensitive = true

  validation {
    condition     = length(var.frase_estado) >= 16
    error_message = "La frase del estado tiene que tener al menos 16 caracteres."
  }
}
