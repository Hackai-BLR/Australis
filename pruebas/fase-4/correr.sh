#!/usr/bin/env bash
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRUEBAS="$(cd "$AQUI/.." && pwd)"
CORRIDA="$(mktemp -d "${TMPDIR:-/tmp}/campusia-corrida-XXXXXX")"
export CAMPUSIA_CORRIDA="$CORRIDA"
export IMAGEN_CURSO="${IMAGEN_CURSO:-campusia-curso:fase4-$(basename "$CORRIDA" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9-')}"
IMAGEN_PROPIA=0
if ! docker image inspect "$IMAGEN_CURSO" >/dev/null 2>&1; then IMAGEN_PROPIA=1; fi
terminar() {
  if [ "$IMAGEN_PROPIA" = 1 ]; then docker rmi "$IMAGEN_CURSO" >/dev/null 2>&1 || true; fi
  rm -rf "$CORRIDA"
}
trap terminar EXIT
fallidas=()
paso() { printf '\n######## %s\n' "$*"; }
if [ "$#" -eq 0 ] && [ "${SOLO_PLAYWRIGHT:-0}" != "1" ]; then
  paso "tramo plantilla de curso y SDK"
  bash "$PRUEBAS/tramo-plantilla-sdk/correr.sh" || fallidas+=("tramo-plantilla-sdk")
  paso "tramo resguardo"
  bash "$PRUEBAS/tramo-resguardo/correr.sh" || fallidas+=("tramo-resguardo")
fi
paso "fases con Playwright: $(cd "$PRUEBAS" && ls -d fase-*/ | tr -d '/' | tr '\n' ' ')"
bash "$PRUEBAS/correr.sh" "$@" || fallidas+=("playwright")
printf '\n'
if [ "${#fallidas[@]}" -gt 0 ]; then
  printf 'Fallaron: %s\n' "${fallidas[*]}"
  exit 1
fi
printf 'Todas las pruebas pasaron\n'
