#!/usr/bin/env bash
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
export IMAGEN_CURSO="${IMAGEN_CURSO:-campusia-curso:tramo-prueba}"
export CI=1

paso() { printf '\n== %s\n' "$*"; }

paso "SDK: instalar, compilar y pruebas propias"
test -f "$RAIZ/sdk/package.json" || { echo "falta sdk/package.json"; exit 1; }
pnpm --dir "$RAIZ/sdk" install --no-frozen-lockfile
pnpm --dir "$RAIZ/sdk" run build
pnpm --dir "$RAIZ/sdk" test

paso "SDK: empaquetar dentro de la plantilla"
test -f "$RAIZ/plantilla-curso/package.json" || { echo "falta plantilla-curso/package.json"; exit 1; }
mkdir -p "$RAIZ/plantilla-curso/vendor"
rm -f "$RAIZ"/plantilla-curso/vendor/campusia-sdk-*.tgz
pnpm --dir "$RAIZ/sdk" pack --pack-destination "$RAIZ/plantilla-curso/vendor"

paso "Plantilla: instalar, compilar y pruebas propias"
pnpm --dir "$RAIZ/plantilla-curso" install --no-frozen-lockfile
pnpm --dir "$RAIZ/plantilla-curso" run build
pnpm --dir "$RAIZ/plantilla-curso" test

paso "Imagen del curso: construir solo con plantilla-curso/ como contexto"
docker build -t "$IMAGEN_CURSO" -f "$RAIZ/plantilla-curso/Containerfile" "$RAIZ/plantilla-curso"

paso "Pruebas de punta a punta del tramo"
pnpm --dir "$AQUI" install --no-frozen-lockfile
cd "$AQUI"
node --test --test-concurrency=1 --test-reporter=spec \
  sdk.aceptacion.test.mjs \
  sdk.ataque.test.mjs \
  repo.test.mjs \
  curso.aceptacion.test.mjs \
  curso.ataque.test.mjs \
  imagen.ataque.test.mjs \
  interfaz.aceptacion.test.mjs
