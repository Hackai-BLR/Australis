#!/usr/bin/env bash
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRUEBAS="$(cd "$AQUI/../.." && pwd)"
ARCHIVO="${CAMPUSIA_TOKEN_ARCHIVO:-$HOME/.config/campusia/claude-oauth-token}"
if [ ! -r "$ARCHIVO" ]; then
  echo "No se puede leer el token de desarrollo en $ARCHIVO" >&2
  exit 2
fi
export CAMPUSIA_MODELO_REAL=1
export CAMPUSIA_TOKEN_ARCHIVO="$ARCHIVO"
export PRUEBAS_WORKERS=1
bash "$PRUEBAS/correr.sh" fase-3/real "$@"
