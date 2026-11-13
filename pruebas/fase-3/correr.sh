#!/usr/bin/env bash
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRUEBAS="$(cd "$AQUI/.." && pwd)"
fallidas=()
paso() { printf '\n######## %s\n' "$*"; }

experimento() {
  local dir="$PRUEBAS/tramo-experimento-intermediario"
  EXPERIMENTO_ID="campusia-exp-$(date +%s)-$$"
  EXPERIMENTO_SALIDA="$(mktemp -d)"
  chmod 700 "$EXPERIMENTO_SALIDA"
  export EXPERIMENTO_ID EXPERIMENTO_SALIDA
  if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi
  local resultado=0
  (cd "$PRUEBAS/.." && node --test --test-concurrency=1 --test-reporter=spec "$dir"/aceptacion/*.test.mjs "$dir"/ataque/*.test.mjs) || resultado=1
  docker ps -aq --filter "label=campusia.experimento=$EXPERIMENTO_ID" | xargs -r docker rm -f >/dev/null 2>&1 || true
  rm -rf "$EXPERIMENTO_SALIDA"
  return $resultado
}

if [ "$#" -eq 0 ] && [ "${SOLO_PLAYWRIGHT:-0}" != "1" ]; then
  paso "tramo plantilla de curso y SDK"
  bash "$PRUEBAS/tramo-plantilla-sdk/correr.sh" || fallidas+=("tramo-plantilla-sdk")
  paso "tramo resguardo"
  bash "$PRUEBAS/tramo-resguardo/correr.sh" || fallidas+=("tramo-resguardo")
  if [ "${SIN_EXPERIMENTO:-0}" != "1" ]; then
    paso "tramo experimento del intermediario"
    experimento || fallidas+=("tramo-experimento-intermediario")
  fi
fi
paso "fases 1, 2 y 3 (Playwright)"
bash "$PRUEBAS/correr.sh" "$@" || fallidas+=("playwright")
printf '\n'
if [ "${#fallidas[@]}" -gt 0 ]; then
  printf 'Fallaron: %s\n' "${fallidas[*]}"
  exit 1
fi
printf 'Todas las pruebas pasaron\n'
