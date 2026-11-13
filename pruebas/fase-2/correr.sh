#!/usr/bin/env bash
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRUEBAS="$(cd "$AQUI/.." && pwd)"
fallidas=()
paso() { printf '\n######## %s\n' "$*"; }
if [ "$#" -eq 0 ] && [ "${SOLO_PLAYWRIGHT:-0}" != "1" ]; then
  paso "tramo plantilla de curso y SDK"
  bash "$PRUEBAS/tramo-plantilla-sdk/correr.sh" || fallidas+=("tramo-plantilla-sdk")
  paso "tramo resguardo"
  bash "$PRUEBAS/tramo-resguardo/correr.sh" || fallidas+=("tramo-resguardo")
fi
paso "fases 1 y 2 (Playwright)"
bash "$PRUEBAS/correr.sh" "$@" || fallidas+=("playwright")
printf '\n'
if [ "${#fallidas[@]}" -gt 0 ]; then
  printf 'Fallaron: %s\n' "${fallidas[*]}"
  exit 1
fi
printf 'Todas las pruebas pasaron\n'
