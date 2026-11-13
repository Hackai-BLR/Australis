#!/usr/bin/env bash
set -euo pipefail

CAMPUSIA_RAIZ="${CAMPUSIA_RAIZ:-/srv/campusia}"
DESPLIEGUE_DIR="${DESPLIEGUE_DIR:-$CAMPUSIA_RAIZ/despliegue}"
REGISTRO="$DESPLIEGUE_DIR/registro.log"
CANTIDAD=20

while getopts ":n:" opcion; do
  case "$opcion" in
    n) CANTIDAD="$OPTARG" ;;
    *) printf 'uso: registro.sh [-n N]\n' >&2; exit 64 ;;
  esac
done

if ! [[ "$CANTIDAD" =~ ^[0-9]+$ ]]; then
  printf 'uso: registro.sh [-n N]\n' >&2
  exit 64
fi

[ -f "$REGISTRO" ] && [ "$CANTIDAD" -gt 0 ] || exit 0

campo() {
  local linea="$1" nombre="$2"
  if [[ "$linea" =~ \"$nombre\":\ *\"([^\"]*)\" ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  elif [[ "$linea" =~ \"$nombre\":\ *([0-9.]+|null) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

tail -n "$CANTIDAD" "$REGISTRO" | while IFS= read -r linea; do
  [ -n "$linea" ] || continue
  fecha="$(campo "$linea" fecha)"
  commit="$(campo "$linea" commit)"
  resultado="$(campo "$linea" resultado)"
  duracion="$(campo "$linea" duracion_s)"
  printf '%s  %s  %-17s %ss\n' "${fecha:--}" "${commit:0:7}" "${resultado:--}" "${duracion:-0}"
done
exit 0
