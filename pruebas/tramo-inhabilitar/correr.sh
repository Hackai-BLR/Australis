#!/usr/bin/env bash
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRUEBAS="$(cd "$AQUI/.." && pwd)"
fallidas=()
paso() { printf '\n######## %s\n' "$*"; }
paso "tramo inhabilitar"
(
  cd "$PRUEBAS" &&
  pnpm install --frozen-lockfile &&
  pnpm exec playwright install chromium &&
  pnpm exec playwright test -c tramo-inhabilitar/playwright.config.ts "$@"
) || fallidas+=("tramo-inhabilitar")
if [ "$#" -eq 0 ] && [ "${SOLO_TRAMO:-0}" != "1" ]; then
  paso "fases y tramos anteriores"
  bash "$PRUEBAS/fase-4/correr.sh" || fallidas+=("fases anteriores")
fi
printf '\n'
if [ "${#fallidas[@]}" -gt 0 ]; then
  printf 'Fallaron: %s\n' "${fallidas[*]}"
  exit 1
fi
printf 'Todas las pruebas pasaron\n'
