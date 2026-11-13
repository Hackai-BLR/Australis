#!/bin/bash
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRUEBAS=(estatico aceptacion_respaldo aceptacion_rotacion aceptacion_docker ataque_respaldo ataque_docker)
if [ "$#" -gt 0 ]; then PRUEBAS=("$@"); fi
fallidas=()
for p in "${PRUEBAS[@]}"; do
  printf '\n######## %s\n' "$p"
  if ! bash "$DIR/$p.sh"; then fallidas+=("$p"); fi
done
printf '\n'
if [ "${#fallidas[@]}" -gt 0 ]; then
  printf 'Fallaron: %s\n' "${fallidas[*]}"
  exit 1
fi
printf 'Todas las pruebas del tramo pasaron\n'
