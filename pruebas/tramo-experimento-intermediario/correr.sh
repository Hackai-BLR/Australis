#!/usr/bin/env bash
set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
cd "$RAIZ"

if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi

for herramienta in cargo node docker git; do
  if ! command -v "$herramienta" >/dev/null 2>&1; then
    echo "Falta $herramienta" >&2
    exit 2
  fi
done

export EXPERIMENTO_ID="campusia-exp-$(date +%s)-$$"
EXPERIMENTO_SALIDA="$(mktemp -d)"
chmod 700 "$EXPERIMENTO_SALIDA"
export EXPERIMENTO_SALIDA

limpiar() {
  docker ps -aq --filter "label=campusia.experimento=$EXPERIMENTO_ID" | xargs -r docker rm -f >/dev/null 2>&1 || true
  rm -rf "$EXPERIMENTO_SALIDA"
}
trap limpiar EXIT

resultado=0

for anterior in pruebas/*/correr.sh; do
  [ "$anterior" = "pruebas/tramo-experimento-intermediario/correr.sh" ] && continue
  [ -f "$anterior" ] || continue
  echo "== Pruebas de $(dirname "$anterior")"
  bash "$anterior" || resultado=1
done

echo "== Pruebas del tramo experimento-intermediario"
node --test --test-concurrency=1 --test-reporter=spec \
  "$AQUI"/aceptacion/*.test.mjs \
  "$AQUI"/ataque/*.test.mjs || resultado=1

exit $resultado
