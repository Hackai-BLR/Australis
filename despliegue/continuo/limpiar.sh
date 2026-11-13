#!/usr/bin/env bash
set -euo pipefail

CAMPUSIA_RAIZ="${CAMPUSIA_RAIZ:-/srv/campusia}"
DESPLIEGUE_DIR="${DESPLIEGUE_DIR:-$CAMPUSIA_RAIZ/despliegue}"
CACHE_DIR="${CACHE_DIR:-$DESPLIEGUE_DIR/cache}"
CACHE_MAX="${CACHE_MAX:-4G}"
CACHE_MAX_DIAS="${CACHE_MAX_DIAS:-30}"
DESPLIEGUE_CONSERVAR="${DESPLIEGUE_CONSERVAR:-3}"
DESPLIEGUE_IMAGEN="${DESPLIEGUE_IMAGEN:-campusia-despliegue}"

decir() {
  printf 'limpiar: %s\n' "$*" >&2
}

a_bytes() {
  local valor="$1"
  if ! [[ "$valor" =~ ^([0-9]+)([KkMmGg]?)([iI]?[bB])?$ ]]; then
    return 1
  fi
  local numero=$((10#${BASH_REMATCH[1]}))
  case "${BASH_REMATCH[2]}" in
    K|k) numero=$((numero * 1024)) ;;
    M|m) numero=$((numero * 1024 * 1024)) ;;
    G|g) numero=$((numero * 1024 * 1024 * 1024)) ;;
  esac
  printf '%s\n' "$numero"
}

if ! MAXIMO="$(a_bytes "$CACHE_MAX")"; then
  decir "CACHE_MAX invalido: $CACHE_MAX"
  exit 64
fi
if ! [[ "$CACHE_MAX_DIAS" =~ ^[0-9]+$ ]]; then
  decir "CACHE_MAX_DIAS invalido: $CACHE_MAX_DIAS"
  exit 64
fi
if ! [[ "$DESPLIEGUE_CONSERVAR" =~ ^[0-9]+$ ]] || [ "$DESPLIEGUE_CONSERVAR" -lt 1 ]; then
  decir "DESPLIEGUE_CONSERVAR invalido: $DESPLIEGUE_CONSERVAR"
  exit 64
fi
if ! [[ "$DESPLIEGUE_IMAGEN" =~ ^[a-z0-9][a-z0-9._/-]*$ ]]; then
  decir "DESPLIEGUE_IMAGEN invalido: $DESPLIEGUE_IMAGEN"
  exit 64
fi

mkdir -p "$DESPLIEGUE_DIR"
exec 9>>"$DESPLIEGUE_DIR/despliegue.lock"
if ! flock -n 9; then
  decir "hay un despliegue en curso"
  exit 75
fi

limpiar_cache() {
  [ -d "$CACHE_DIR" ] || return 0
  local raiz
  raiz="$(cd -P "$CACHE_DIR" && pwd)"
  find "$raiz" -xdev -type f -mmin "+$((CACHE_MAX_DIAS * 1440))" -delete
  local total=0 tamano ruta resto
  while IFS= read -r -d '' resto; do
    tamano="${resto#* }"
    tamano="${tamano%% *}"
    total=$((total + tamano))
  done < <(find "$raiz" -xdev -type f -printf '%T@ %s %p\0')
  if [ "$total" -gt "$MAXIMO" ]; then
    while IFS= read -r -d '' resto; do
      [ "$total" -gt "$MAXIMO" ] || break
      resto="${resto#* }"
      tamano="${resto%% *}"
      ruta="${resto#* }"
      if rm -f -- "$ruta"; then
        total=$((total - tamano))
      fi
    done < <(find "$raiz" -xdev -type f -printf '%T@ %s %p\0' | sort -z -n -k1,1)
  fi
  find "$raiz" -xdev -mindepth 1 -depth -type d -empty -delete
}

declare -A CONSERVADOS=()

elegir_conservados() {
  local actual=""
  if [ -f "$DESPLIEGUE_DIR/actual" ]; then
    actual="$(tr -d '[:space:]' <"$DESPLIEGUE_DIR/actual")"
    if [[ "$actual" =~ ^[0-9a-f]{40}$ ]]; then
      CONSERVADOS["$actual"]=1
    fi
  fi
  local fuentes="$DESPLIEGUE_DIR/fuentes"
  [ -d "$fuentes" ] || return 0
  local linea nombre
  while IFS= read -r -d '' linea; do
    [ "${#CONSERVADOS[@]}" -lt "$DESPLIEGUE_CONSERVAR" ] || break
    nombre="${linea#* }"
    CONSERVADOS["$nombre"]=1
  done < <(find "$fuentes" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\0' | sort -z -n -r -k1,1)
}

limpiar_fuentes() {
  local fuentes="$DESPLIEGUE_DIR/fuentes"
  [ -d "$fuentes" ] || return 0
  local ruta nombre
  while IFS= read -r -d '' ruta; do
    nombre="${ruta##*/}"
    if [ -z "${CONSERVADOS[$nombre]:-}" ]; then
      rm -rf -- "$ruta"
    fi
  done < <(find "$fuentes" -mindepth 1 -maxdepth 1 -print0)
}

limpiar_previos() {
  local previos="$DESPLIEGUE_DIR/previos"
  [ -d "$previos" ] || return 0
  local ruta nombre
  while IFS= read -r -d '' ruta; do
    nombre="${ruta##*/}"
    nombre="${nombre%.db}"
    if [ -z "${CONSERVADOS[$nombre]:-}" ]; then
      rm -f -- "$ruta"
    fi
  done < <(find "$previos" -mindepth 1 -maxdepth 1 -type f -name '*.db' -print0)
}

docker_disponible() {
  command -v docker >/dev/null 2>&1 || return 1
  if timeout 20 docker version >/dev/null 2>&1; then
    return 0
  fi
  if [ -z "${DOCKER_HOST:-}" ]; then
    local socket="/run/user/$(id -u)/docker.sock"
    if [ -S "$socket" ]; then
      export DOCKER_HOST="unix://$socket"
      timeout 20 docker version >/dev/null 2>&1 && return 0
      unset DOCKER_HOST
    fi
  fi
  return 1
}

limpiar_imagenes() {
  if ! docker_disponible; then
    decir "docker no responde; se omiten las imagenes"
    return 0
  fi
  local repositorio etiqueta
  while IFS=' ' read -r repositorio etiqueta; do
    [ "$repositorio" = "$DESPLIEGUE_IMAGEN" ] || continue
    [ -n "$etiqueta" ] && [ "$etiqueta" != "<none>" ] || continue
    if [ -z "${CONSERVADOS[$etiqueta]:-}" ]; then
      docker image rm "$DESPLIEGUE_IMAGEN:$etiqueta" >/dev/null || decir "no se pudo borrar $DESPLIEGUE_IMAGEN:$etiqueta"
    fi
  done < <(docker image ls "$DESPLIEGUE_IMAGEN" --format '{{.Repository}} {{.Tag}}')
}

limpiar_cache
elegir_conservados
limpiar_fuentes
limpiar_previos
limpiar_imagenes
exit 0
