#!/usr/bin/env bash
set -euo pipefail

SCRIPT="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT")"

export CAMPUSIA_RAIZ="${CAMPUSIA_RAIZ:-/srv/campusia}"
export DESPLIEGUE_DIR="${DESPLIEGUE_DIR:-$CAMPUSIA_RAIZ/despliegue}"
export DESPLIEGUE_ORIGEN="${DESPLIEGUE_ORIGEN:-git@github.com:ORGANIZACION/campusia.git}"
export DESPLIEGUE_RAMA="${DESPLIEGUE_RAMA:-main}"
export DESPLIEGUE_CLAVE="${DESPLIEGUE_CLAVE:-$CAMPUSIA_RAIZ/.ssh/campusia_deploy}"
export DESPLIEGUE_PRUEBAS="${DESPLIEGUE_PRUEBAS:-bash $(printf %q "$SCRIPT") --etapa pruebas}"
export DESPLIEGUE_COMPILAR="${DESPLIEGUE_COMPILAR:-bash $(printf %q "$SCRIPT") --etapa compilar}"
export DESPLIEGUE_ESPACIO="${DESPLIEGUE_ESPACIO:-bash $(printf %q "$SCRIPT") --etapa espacio}"
export DESPLIEGUE_ESPACIO_IMAGEN="${DESPLIEGUE_ESPACIO_IMAGEN:-${ESPACIO_IMAGEN:-campusia-espacio:1}}"
export DESPLIEGUE_ESPACIO_CARPETAS="${DESPLIEGUE_ESPACIO_CARPETAS:-sdk plantilla-curso despliegue/espacio-trabajo despliegue/construir-espacio.sh}"
INSTALAR_POR_DEFECTO='sudo -n /usr/local/sbin/campusia-instalar "$COMMIT"'
export DESPLIEGUE_INSTALAR="${DESPLIEGUE_INSTALAR:-$INSTALAR_POR_DEFECTO}"
SALUD_POR_DEFECTO='curl -fsS --max-time 5 http://127.0.0.1:${NUCLEO_PUERTO:-8080}/salud'
export DESPLIEGUE_SALUD="${DESPLIEGUE_SALUD:-$SALUD_POR_DEFECTO}"
export DESPLIEGUE_SALUD_ESPERA="${DESPLIEGUE_SALUD_ESPERA:-60}"
export DESPLIEGUE_CPUS="${DESPLIEGUE_CPUS:-1.5}"
export DESPLIEGUE_MEMORIA="${DESPLIEGUE_MEMORIA:-3g}"
export DESPLIEGUE_IMAGEN="${DESPLIEGUE_IMAGEN:-campusia-despliegue}"
export CACHE_DIR="${CACHE_DIR:-$DESPLIEGUE_DIR/cache}"

REPO="$DESPLIEGUE_DIR/repo.git"
REGISTRO="$DESPLIEGUE_DIR/registro.log"
ACTUAL="$DESPLIEGUE_DIR/actual"

decir() {
  printf 'desplegar: %s\n' "$*" >&2
}

preparar_docker() {
  if [ -z "${DOCKER_HOST:-}" ]; then
    local socket="/run/user/$(id -u)/docker.sock"
    if [ -S "$socket" ]; then
      export DOCKER_HOST="unix://$socket"
    fi
  fi
}

imagen_lista() {
  local contexto="$SCRIPT_DIR/imagen"
  if [ -f "$FUENTES/despliegue/continuo/imagen/Dockerfile" ]; then
    contexto="$FUENTES/despliegue/continuo/imagen"
  fi
  if ! docker image inspect "$DESPLIEGUE_IMAGEN:$COMMIT" >/dev/null 2>&1; then
    docker build -q -t "$DESPLIEGUE_IMAGEN:$COMMIT" "$contexto" >/dev/null
  fi
}

en_contenedor() {
  local red="$1"
  local directorios="$2"
  local guion="$3"
  local opciones_red=()
  if [ "$red" = "sin-red" ]; then
    opciones_red=(--network none)
  fi
  mkdir -p "$CACHE_DIR/cargo" "$CACHE_DIR/target" "$CACHE_DIR/pnpm/store" "$CACHE_DIR/pnpm/cache"
  docker run --rm "${opciones_red[@]}" \
    --cpus "$DESPLIEGUE_CPUS" \
    --memory "$DESPLIEGUE_MEMORIA" \
    --pids-limit 4096 \
    -v "$FUENTES:/fuentes" \
    -v "$CACHE_DIR:/cache" \
    -w /fuentes \
    -e COMMIT="$COMMIT" \
    -e DIRECTORIOS_NODE="$directorios" \
    -e CARGO_HOME=/cache/cargo \
    -e CARGO_TARGET_DIR=/cache/target \
    -e npm_config_store_dir=/cache/pnpm/store \
    -e npm_config_cache_dir=/cache/pnpm/cache \
    -e pnpm_config_store_dir=/cache/pnpm/store \
    -e pnpm_config_cache_dir=/cache/pnpm/cache \
    -e CI=true \
    "$DESPLIEGUE_IMAGEN:$COMMIT" \
    bash -euo pipefail -c "$guion"
}

GUION_NODE='
pnpm_instalar() {
  local d="$1"
  shift
  (cd "$d" && pnpm install --frozen-lockfile "$@" --store-dir /cache/pnpm/store --config.cache-dir=/cache/pnpm/cache --config.manage-package-manager-versions=false --config.package-manager-strict=false)
}
pnpm_correr() {
  local d="$1"
  shift
  (cd "$d" && pnpm run "$@")
}
directorios_node() {
  for d in $DIRECTORIOS_NODE; do
    if [ -f "$d/package.json" ] && [ -f "$d/pnpm-lock.yaml" ]; then printf "%s\n" "$d"; fi
  done
}
'

GUION_DEPENDENCIAS="$GUION_NODE"'
if [ -f nucleo/Cargo.toml ]; then cargo fetch --locked --manifest-path nucleo/Cargo.toml; fi
for d in $(directorios_node); do
  pnpm_instalar "$d"
done
'

GUION_INSTALAR_NODE="$GUION_NODE"'
for d in $(directorios_node); do
  pnpm_instalar "$d" --offline
done
'

GUION_PRUEBAS="$GUION_INSTALAR_NODE"'
if [ -f nucleo/Cargo.toml ]; then cargo test --offline --locked --manifest-path nucleo/Cargo.toml; fi
for d in $(directorios_node); do
  pnpm_correr "$d" --if-present build
  pnpm_correr "$d" --if-present test
done
'

GUION_COMPILAR="$GUION_INSTALAR_NODE"'
rm -rf compilado
mkdir -p compilado/bin
if [ -f nucleo/Cargo.toml ]; then
  cargo build --offline --locked --release --manifest-path nucleo/Cargo.toml --bin campusia-nucleo
  install -m 0755 "$CARGO_TARGET_DIR/release/campusia-nucleo" compilado/bin/campusia-nucleo
fi
if [ -f interfaz/package.json ]; then
  rm -rf interfaz/dist
  pnpm_correr interfaz build
  test -f interfaz/dist/index.html
fi
if [ -f sdk/package.json ] && [ -f plantilla-curso/package.json ]; then
  rm -rf sdk/dist
  pnpm_correr sdk build
  mkdir -p plantilla-curso/vendor
  rm -f plantilla-curso/vendor/campusia-sdk-*.tgz
  (cd sdk && pnpm pack --pack-destination ../plantilla-curso/vendor >/dev/null)
  esperado="$(node -e "const p=require(\"./plantilla-curso/package.json\");const v=String((p.dependencies||{})[\"@campusia/sdk\"]||\"\");process.stdout.write(v.startsWith(\"file:\")?v.slice(5):\"\")")"
  if [ -n "$esperado" ]; then
    test -f "plantilla-curso/$esperado" || { echo "falta plantilla-curso/$esperado despues de empaquetar el SDK" >&2; exit 1; }
  fi
  compgen -G "plantilla-curso/vendor/campusia-sdk-*.tgz" >/dev/null
fi
'

espacio_cambio() {
  local repo="$DESPLIEGUE_DIR/repo.git"
  local carpetas=()
  read -r -a carpetas <<<"$DESPLIEGUE_ESPACIO_CARPETAS"
  [[ "${REFERENCIA:-}" =~ ^[0-9a-f]{40}$ ]] || return 0
  [ -d "$repo" ] || return 0
  git --git-dir="$repo" cat-file -e "$REFERENCIA^{commit}" 2>/dev/null || return 0
  git --git-dir="$repo" cat-file -e "$COMMIT^{commit}" 2>/dev/null || return 0
  ! git --git-dir="$repo" diff --quiet "$REFERENCIA" "$COMMIT" -- "${carpetas[@]}"
}

etapa_espacio() {
  local construir="$FUENTES/despliegue/construir-espacio.sh"
  if ! [ -f "$construir" ] || ! [ -d "$FUENTES/despliegue/espacio-trabajo" ]; then
    decir "el commit no tiene despliegue/construir-espacio.sh; no se toca la imagen del espacio"
    return 0
  fi
  preparar_docker
  local motivo=""
  if ! docker image inspect "$DESPLIEGUE_ESPACIO_IMAGEN" >/dev/null 2>&1; then
    motivo="la imagen no existe"
  elif espacio_cambio; then
    motivo="cambiaron $DESPLIEGUE_ESPACIO_CARPETAS"
  fi
  if [ -z "$motivo" ]; then
    decir "imagen del espacio $DESPLIEGUE_ESPACIO_IMAGEN sin cambios"
    return 0
  fi
  decir "reconstruyendo $DESPLIEGUE_ESPACIO_IMAGEN: $motivo"
  bash "$construir" --etiqueta "$DESPLIEGUE_ESPACIO_IMAGEN" --cli docker \
    --plantilla "$FUENTES/plantilla-curso" --espacio "$FUENTES/despliegue/espacio-trabajo"
}

etapa_por_defecto() {
  local nombre="$1"
  : "${COMMIT:?}" "${FUENTES:?}"
  if [ "$nombre" = "espacio" ]; then
    etapa_espacio
    return $?
  fi
  preparar_docker
  imagen_lista
  case "$nombre" in
    pruebas)
      en_contenedor con-red "interfaz sdk" "$GUION_DEPENDENCIAS"
      en_contenedor sin-red "interfaz sdk" "$GUION_PRUEBAS"
      ;;
    compilar)
      en_contenedor con-red "interfaz sdk" "$GUION_DEPENDENCIAS"
      en_contenedor sin-red "interfaz sdk" "$GUION_COMPILAR"
      ;;
    *)
      decir "etapa desconocida: $nombre"
      return 64
      ;;
  esac
}

if [ "${1:-}" = "--etapa" ]; then
  etapa_por_defecto "${2:-}"
  exit $?
fi

FORZAR=0
for arg in "$@"; do
  case "$arg" in
    --forzar) FORZAR=1 ;;
    *) decir "argumento desconocido: $arg"; exit 64 ;;
  esac
done

if ! [[ "$DESPLIEGUE_SALUD_ESPERA" =~ ^[0-9]+$ ]]; then
  decir "DESPLIEGUE_SALUD_ESPERA invalido"
  exit 64
fi

mkdir -p "$DESPLIEGUE_DIR"
exec 9>>"$DESPLIEGUE_DIR/despliegue.lock"
if ! flock -n 9; then
  decir "hay otro despliegue o limpieza en curso"
  exit 75
fi

mkdir -p "$DESPLIEGUE_DIR/fuentes" "$CACHE_DIR"

if [ -f "$DESPLIEGUE_CLAVE" ]; then
  export GIT_SSH_COMMAND="ssh -i $(printf %q "$DESPLIEGUE_CLAVE") -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
fi
export GIT_TERMINAL_PROMPT=0

if ! [ -d "$REPO" ]; then
  rm -rf "$REPO.tmp"
  git clone -q --mirror "$DESPLIEGUE_ORIGEN" "$REPO.tmp"
  mv "$REPO.tmp" "$REPO"
fi
git --git-dir="$REPO" remote set-url origin "$DESPLIEGUE_ORIGEN"
git --git-dir="$REPO" fetch -q --prune origin

NUEVO="$(git --git-dir="$REPO" rev-parse -q --verify "refs/heads/$DESPLIEGUE_RAMA^{commit}" || true)"
if ! [[ "$NUEVO" =~ ^[0-9a-f]{40}$ ]]; then
  decir "no se encontro la rama $DESPLIEGUE_RAMA en el origen"
  exit 1
fi

ANTERIOR=""
if [ -f "$ACTUAL" ]; then
  ANTERIOR="$(tr -d '[:space:]' <"$ACTUAL")"
  if ! [[ "$ANTERIOR" =~ ^[0-9a-f]{40}$ ]]; then
    ANTERIOR=""
  fi
fi

if [ "$NUEVO" = "$ANTERIOR" ]; then
  exit 0
fi

if [ "$FORZAR" = 0 ] && [ -f "$REGISTRO" ]; then
  if grep -F "\"commit\": \"$NUEVO\"" "$REGISTRO" | grep -vqF '"resultado": "exito"'; then
    decir "el commit $NUEVO ya fallo; se reintenta solo con --forzar"
    exit 0
  fi
fi

INICIO="$(date +%s)"

registrar() {
  local resultado="$1"
  local fin
  fin="$(date +%s)"
  local duracion=$((fin - INICIO))
  [ "$duracion" -ge 0 ] || duracion=0
  local anterior_json="null"
  if [ -n "$ANTERIOR" ]; then
    anterior_json="\"$ANTERIOR\""
  fi
  printf '{"fecha": "%s", "commit": "%s", "anterior": %s, "resultado": "%s", "duracion_s": %d}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$NUEVO" "$anterior_json" "$resultado" "$duracion" >>"$REGISTRO"
  decir "$NUEVO: $resultado en ${duracion}s"
}

checkout() {
  local commit="$1"
  local destino="$DESPLIEGUE_DIR/fuentes/$commit"
  local indice="$DESPLIEGUE_DIR/.indice-$$"
  rm -rf "$destino" "$indice"
  mkdir -p "$destino"
  GIT_INDEX_FILE="$indice" git --git-dir="$REPO" --work-tree="$destino" read-tree --reset -u "$commit"
  rm -f "$indice"
  touch "$destino"
}

etapa() {
  local comando="$1"
  local commit="$2"
  local referencia="${3:-}"
  local fuentes="$DESPLIEGUE_DIR/fuentes/$commit"
  (
    exec 9>&-
    cd "$fuentes"
    export COMMIT="$commit" FUENTES="$fuentes" REFERENCIA="$referencia"
    exec bash -c "$comando"
  )
}

salud() {
  local commit="$1"
  local limite=$((SECONDS + DESPLIEGUE_SALUD_ESPERA))
  while true; do
    if etapa "$DESPLIEGUE_SALUD" "$commit"; then
      return 0
    fi
    if [ "$SECONDS" -ge "$limite" ]; then
      return 1
    fi
    sleep 1
  done
}

copia_de_datos() {
  local base="$CAMPUSIA_RAIZ/datos/campusia.db"
  if [ -f "$base" ] && command -v sqlite3 >/dev/null 2>&1; then
    mkdir -p "$DESPLIEGUE_DIR/previos"
    sqlite3 "$base" ".backup '$DESPLIEGUE_DIR/previos/$NUEVO.db'" || decir "no se pudo copiar la base"
  fi
}

anterior_disponible() {
  [ -n "$ANTERIOR" ] && [ -d "$DESPLIEGUE_DIR/fuentes/$ANTERIOR" ]
}

checkout "$NUEVO"

if ! etapa "$DESPLIEGUE_PRUEBAS" "$NUEVO"; then
  registrar fallo-pruebas
  exit 1
fi

if ! etapa "$DESPLIEGUE_COMPILAR" "$NUEVO"; then
  registrar fallo-compilacion
  exit 1
fi

copia_de_datos

volver_a_la_anterior() {
  local espacio_tocado="$1"
  anterior_disponible || return 1
  etapa "$DESPLIEGUE_INSTALAR" "$ANTERIOR" || { decir "no se pudo reinstalar $ANTERIOR"; return 1; }
  if [ "$espacio_tocado" = 1 ]; then
    etapa "$DESPLIEGUE_ESPACIO" "$ANTERIOR" "$NUEVO" || { decir "no se pudo reconstruir el espacio de $ANTERIOR"; return 1; }
  fi
  return 0
}

if ! etapa "$DESPLIEGUE_INSTALAR" "$NUEVO"; then
  volver_a_la_anterior 0 || true
  registrar fallo-instalacion
  exit 1
fi

if ! etapa "$DESPLIEGUE_ESPACIO" "$NUEVO" "$ANTERIOR"; then
  volver_a_la_anterior 0 || true
  registrar fallo-espacio
  exit 1
fi

if ! salud "$NUEVO"; then
  if ! anterior_disponible; then
    registrar fallo-salud
    exit 2
  fi
  if volver_a_la_anterior 1 && salud "$ANTERIOR"; then
    registrar revertido
  else
    registrar fallo-reversion
  fi
  exit 2
fi

printf '%s\n' "$NUEVO" >"$ACTUAL.tmp"
mv -f "$ACTUAL.tmp" "$ACTUAL"
registrar exito
exit 0
