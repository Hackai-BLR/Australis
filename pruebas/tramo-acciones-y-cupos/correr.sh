#!/usr/bin/env bash
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRUEBAS="$(cd "$AQUI/.." && pwd)"
RAIZ="$(cd "$PRUEBAS/.." && pwd)"
CORRIDA="$(mktemp -d "${TMPDIR:-/tmp}/campusia-corrida-XXXXXX")"
terminar() { rm -rf "$CORRIDA"; }
trap terminar EXIT
fallidas=()
paso() { printf '\n######## %s\n' "$*"; }

paso "tramo acciones y cupos: SDK"
(
  pnpm --dir "$RAIZ/sdk" install --no-frozen-lockfile &&
  pnpm --dir "$RAIZ/sdk" run build &&
  node --test --test-reporter=spec "$AQUI/sdk.test.mjs" "$AQUI/handoff.test.mjs"
) || fallidas+=("tramo-acciones-y-cupos (SDK)")

paso "tramo acciones y cupos: Playwright"
(
  export CAMPUSIA_CORRIDA="$CORRIDA"
  cd "$PRUEBAS" &&
  pnpm install --frozen-lockfile &&
  pnpm exec playwright install chromium &&
  pnpm exec playwright test -c tramo-acciones-y-cupos/playwright.config.ts "$@"
) || fallidas+=("tramo-acciones-y-cupos (Playwright)")

if [ "$#" -eq 0 ] && [ "${SOLO_TRAMO:-0}" != "1" ]; then
  paso "tramos y fases anteriores"
  bash "$PRUEBAS/tramo-inhabilitar/correr.sh" || fallidas+=("tramos y fases anteriores")
fi
printf '\n'
if [ "${#fallidas[@]}" -gt 0 ]; then
  printf 'Fallaron: %s\n' "${fallidas[*]}"
  exit 1
fi
printf 'Todas las pruebas pasaron\n'
