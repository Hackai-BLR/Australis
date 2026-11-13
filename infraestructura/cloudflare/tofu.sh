#!/usr/bin/env bash
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${CAMPUSIA_CONFIG:-$HOME/.config/campusia}"
TOKEN="$CONFIG/cloudflare-token"
FRASE="$CONFIG/tofu-frase"

faltan=()
[ -r "$TOKEN" ] || faltan+=("$TOKEN")
[ -r "$FRASE" ] || faltan+=("$FRASE")
if [ "${#faltan[@]}" -gt 0 ]; then
  for f in "${faltan[@]}"; do
    echo "tofu.sh: falta el archivo $f" >&2
  done
  echo "tofu.sh: creá en $CONFIG el token de Cloudflare (cloudflare-token) y la frase del estado (tofu-frase), con permisos 600" >&2
  exit 1
fi

TF_VAR_cloudflare_api_token="$(tr -d '\r\n' < "$TOKEN")"
TF_VAR_frase_estado="$(tr -d '\r\n' < "$FRASE")"
if [ -z "$TF_VAR_cloudflare_api_token" ] || [ -z "$TF_VAR_frase_estado" ]; then
  echo "tofu.sh: el token o la frase en $CONFIG están vacíos" >&2
  exit 1
fi
export TF_VAR_cloudflare_api_token TF_VAR_frase_estado

TOFU="${TOFU:-tofu}"
if ! command -v "$TOFU" >/dev/null 2>&1; then
  echo "tofu.sh: no se encontró OpenTofu ($TOFU) en el PATH" >&2
  exit 1
fi

cd "$AQUI"
exec "$TOFU" "$@"
