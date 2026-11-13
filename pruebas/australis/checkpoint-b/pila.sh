#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if command -v pnpm >/dev/null 2>&1; then PNPM=(pnpm); else PNPM=(corepack pnpm); fi
ETIQUETA="australis.pruebas=checkpoint-b"
case "${1:-arriba}" in
  arriba)
    "${PNPM[@]}" install --frozen-lockfile
    AUSTRALIS_B_MANTENER=1 "${PNPM[@]}" exec playwright test --config checkpoint-b/playwright.arriba.config.ts
    ;;
  bajar)
    docker ps -aq --filter "label=${ETIQUETA}" | xargs -r docker rm -f -v
    docker ps -aq --filter "name=^ab[0-9a-f]{8}-curso-" | xargs -r docker rm -f -v
    docker images -q --filter "reference=ab*-curso-*" | xargs -r docker rmi -f
    docker network ls -q --filter "label=${ETIQUETA}" | xargs -r docker network rm
    docker volume ls -q --filter "label=${ETIQUETA}" | xargs -r docker volume rm -f
    ;;
  *)
    echo "Uso: pila.sh [arriba|bajar]" >&2
    exit 2
    ;;
esac
