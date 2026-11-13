#!/bin/bash
set -euo pipefail
umask 077
export LC_ALL=C

fallar() {
  printf 'respaldar: %s\n' "$*" >&2
  exit 1
}

absoluta() {
  local d="$1"
  case "$d" in
    /*) printf '%s' "$d" ;;
    *) printf '%s/%s' "$PWD" "$d" ;;
  esac
}

es_entero() {
  [[ "$1" =~ ^[0-9]+$ ]] && [ "${#1}" -le 6 ]
}

dias_civiles() {
  local a="$1" m="$2" d="$3" era yoe doy doe
  if [ "$m" -le 2 ]; then a=$((a - 1)); fi
  era=$(( (a >= 0 ? a : a - 399) / 400 ))
  yoe=$(( a - era * 400 ))
  doy=$(( (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1 ))
  doe=$(( yoe * 365 + yoe / 4 - yoe / 100 + doy ))
  printf '%s' $(( era * 146097 + doe - 719468 ))
}

fecha_valida() {
  local n="$1" a m d h mi s dim
  [[ "$n" =~ ^[0-9]{8}-[0-9]{6}$ ]] || return 1
  a=$((10#${n:0:4})); m=$((10#${n:4:2})); d=$((10#${n:6:2}))
  h=$((10#${n:9:2})); mi=$((10#${n:11:2})); s=$((10#${n:13:2}))
  [ "$m" -ge 1 ] && [ "$m" -le 12 ] || return 1
  [ "$h" -le 23 ] && [ "$mi" -le 59 ] && [ "$s" -le 59 ] || return 1
  case "$m" in
    1|3|5|7|8|10|12) dim=31 ;;
    4|6|9|11) dim=30 ;;
    *) if { [ $((a % 4)) -eq 0 ] && [ $((a % 100)) -ne 0 ]; } || [ $((a % 400)) -eq 0 ]; then dim=29; else dim=28; fi ;;
  esac
  [ "$d" -ge 1 ] && [ "$d" -le "$dim" ]
}

dia_de() {
  local n="$1"
  dias_civiles "$((10#${n:0:4}))" "$((10#${n:4:2}))" "$((10#${n:6:2}))"
}

RAIZ="$(absoluta "${CAMPUSIA_RAIZ:-/srv/campusia}")"
RESPALDOS="$(absoluta "${CAMPUSIA_RESPALDOS:-$RAIZ/respaldos}")"
AHORA="${CAMPUSIA_AHORA:-$(date -u +%Y%m%d-%H%M%S)}"
DIARIOS="${RESPALDO_DIARIOS:-7}"
SEMANALES="${RESPALDO_SEMANALES:-4}"

fecha_valida "$AHORA" || fallar "CAMPUSIA_AHORA inválida: $AHORA"
es_entero "$DIARIOS" || fallar "RESPALDO_DIARIOS inválido"
es_entero "$SEMANALES" || fallar "RESPALDO_SEMANALES inválido"
[ -d "$RAIZ" ] || fallar "no existe $RAIZ"

for herramienta in sqlite3 git tar gzip sha256sum flock find; do
  command -v "$herramienta" >/dev/null 2>&1 || fallar "falta $herramienta"
done

mkdir -p -- "$RESPALDOS"
chmod 700 -- "$RESPALDOS"

exec {CANDADO}>>"$RESPALDOS/.candado"
flock -n "$CANDADO" || fallar "hay otro respaldo en curso"

FINAL="$RESPALDOS/$AHORA"
if [ -e "$FINAL" ] || [ -L "$FINAL" ]; then
  fallar "ya existe $FINAL"
fi

find "$RESPALDOS" -mindepth 1 -maxdepth 1 -type d -name '.armando-*' -exec rm -rf -- {} +

TRABAJO=""
limpiar() {
  if [ -n "$TRABAJO" ] && [ -d "$TRABAJO" ]; then
    chmod -R u+rwX -- "$TRABAJO" 2>/dev/null || true
    rm -rf -- "$TRABAJO"
  fi
}
trap limpiar EXIT
trap 'exit 1' INT TERM HUP

TRABAJO="$(mktemp -d "$RESPALDOS/.armando-XXXXXX")"
CONTENIDO="$TRABAJO/contenido"
COPIA="$TRABAJO/copia"
mkdir -- "$CONTENIDO" "$COPIA"

es_sqlite() {
  local cabecera
  cabecera="$(head -c 15 -- "$1" 2>/dev/null | tr -d '\0')" || return 1
  [ "$cabecera" = "SQLite format 3" ]
}

copiar_base() {
  local origen="$1" destino="$2"
  rm -f -- "$COPIA/base" "$COPIA/base-journal"
  if ! (cd -- "$COPIA" && sqlite3 -init /dev/null -batch -bail "$origen" ".timeout 30000" ".backup main base") >/dev/null; then
    rm -f -- "$COPIA/base" "$COPIA/base-journal"
    return 1
  fi
  [ -f "$COPIA/base" ] || return 1
  mv -f -- "$COPIA/base" "$destino"
}

copiar_arbol() {
  local origen="$1" destino="$2" bases="$3" omitir="${4:-}" ruta rel
  local poda=()
  if [ -n "$omitir" ]; then
    poda=(-path "$origen/$omitir" -prune -o)
  fi
  mkdir -p -- "$destino"
  while IFS= read -r -d '' ruta; do
    rel="${ruta#"$origen"/}"
    if [ -L "$ruta" ]; then
      continue
    elif [ -d "$ruta" ]; then
      mkdir -p -- "$destino/$rel"
    elif [ -f "$ruta" ]; then
      case "$rel" in
        *-wal|*-shm|*-journal)
          if [ "$bases" = si ]; then continue; fi
          ;;
      esac
      if [ "$bases" = si ]; then
        case "$rel" in
          *.db|*.sqlite|*.sqlite3)
            if copiar_base "$ruta" "$destino/$rel"; then
              continue
            fi
            if es_sqlite "$ruta"; then
              fallar "no se pudo copiar la base $ruta"
            fi
            ;;
        esac
      fi
      cp -P -- "$ruta" "$destino/$rel"
    fi
  done < <(find "$origen" -mindepth 1 "${poda[@]}" \( -type d -o -type f \) -print0)
}

PLATAFORMA="$RAIZ/datos/campusia.db"
if [ ! -f "$PLATAFORMA" ] || [ -L "$PLATAFORMA" ]; then
  fallar "no existe la base de la plataforma $PLATAFORMA"
fi
mkdir -- "$CONTENIDO/plataforma"
copiar_base "$PLATAFORMA" "$CONTENIDO/plataforma/campusia.db" || fallar "no se pudo copiar $PLATAFORMA"

GIT=(git -c safe.directory='*' -c core.fsmonitor=false -c core.hooksPath=/dev/null)

if [ -d "$RAIZ/cursos" ] && [ ! -L "$RAIZ/cursos" ]; then
  mkdir -- "$CONTENIDO/cursos"
  while IFS= read -r -d '' curso; do
    id="${curso##*/}"
    dest="$CONTENIDO/cursos/$id"
    mkdir -- "$dest"
    if [ -e "$curso/.git" ]; then
      if [ -n "$("${GIT[@]}" -C "$curso" for-each-ref --count=1 2>/dev/null)" ]; then
        "${GIT[@]}" -C "$curso" bundle create -q "$dest/repo.bundle" --all || fallar "no se pudo empaquetar el curso $id"
        if cabeza="$("${GIT[@]}" -C "$curso" symbolic-ref -q HEAD)"; then
          printf 'ref: %s\n' "$cabeza" > "$dest/HEAD"
        elif cabeza="$("${GIT[@]}" -C "$curso" rev-parse -q --verify HEAD)"; then
          printf '%s\n' "$cabeza" > "$dest/HEAD"
        fi
      else
        printf 'respaldar: el curso %s no tiene commits, se omite su repo\n' "$id" >&2
      fi
    fi
    if [ -d "$curso/datos" ] && [ ! -L "$curso/datos" ]; then
      copiar_arbol "$curso/datos" "$dest/datos" si
    fi
  done < <(find "$RAIZ/cursos" -mindepth 1 -maxdepth 1 -type d -print0)
fi

if [ -d "$RAIZ/archivos" ] && [ ! -L "$RAIZ/archivos" ]; then
  copiar_arbol "$RAIZ/archivos" "$CONTENIDO/archivos" no .subiendo
fi

if [ -n "$(find "$CONTENIDO" -mindepth 1 ! -type f ! -type d -print -quit)" ]; then
  fallar "el contenido tiene entradas que no son archivos ni carpetas"
fi

(cd -- "$CONTENIDO" && find . -type f -printf '%P\0' | sort -z | xargs -0 -r sha256sum --) > "$TRABAJO/manifiesto"
mv -- "$TRABAJO/manifiesto" "$CONTENIDO/MANIFIESTO.sha256"

ENTRADAS=(MANIFIESTO.sha256)
for e in plataforma cursos archivos; do
  if [ -e "$CONTENIDO/$e" ]; then ENTRADAS+=("$e"); fi
done

tar -C "$CONTENIDO" --sort=name --owner=0 --group=0 --numeric-owner -czf "$TRABAJO/respaldo.tar.gz" -- "${ENTRADAS[@]}"
(cd -- "$TRABAJO" && sha256sum respaldo.tar.gz > respaldo.tar.gz.sha256)

chmod -R u+rwX -- "$CONTENIDO" "$COPIA"
rm -rf -- "$CONTENIDO" "$COPIA"
chmod 600 -- "$TRABAJO/respaldo.tar.gz" "$TRABAJO/respaldo.tar.gz.sha256"
chmod 700 -- "$TRABAJO"

if [ -e "$FINAL" ] || [ -L "$FINAL" ]; then
  fallar "ya existe $FINAL"
fi
mv -T -- "$TRABAJO" "$FINAL"
TRABAJO=""

printf '%s\n' "$FINAL"

HOY="$(dia_de "$AHORA")"
LUNES_HOY=$(( HOY - (HOY + 3) % 7 ))
declare -A MEJOR_DIA=()
declare -A MEJOR_SEMANA=()
CANDIDATOS=()
while IFS= read -r -d '' ruta; do
  n="${ruta##*/}"
  fecha_valida "$n" || continue
  [ -L "$ruta" ] && continue
  [[ "$n" > "$AHORA" ]] && continue
  CANDIDATOS+=("$n")
  dia="$(dia_de "$n")"
  lunes=$(( dia - (dia + 3) % 7 ))
  if [ "$dia" -le "$HOY" ] && [ "$dia" -gt $(( HOY - DIARIOS )) ]; then
    actual="${MEJOR_DIA[$dia]:-}"
    if [ -z "$actual" ] || [[ "$n" > "$actual" ]]; then MEJOR_DIA[$dia]="$n"; fi
  fi
  if [ "$lunes" -le "$LUNES_HOY" ] && [ "$lunes" -gt $(( LUNES_HOY - 7 * SEMANALES )) ]; then
    actual="${MEJOR_SEMANA[$lunes]:-}"
    if [ -z "$actual" ] || [[ "$n" > "$actual" ]]; then MEJOR_SEMANA[$lunes]="$n"; fi
  fi
done < <(find "$RESPALDOS" -mindepth 1 -maxdepth 1 -type d -print0)

declare -A CONSERVAR=(["$AHORA"]=1)
for n in "${MEJOR_DIA[@]}" "${MEJOR_SEMANA[@]}"; do
  CONSERVAR[$n]=1
done
for n in "${CANDIDATOS[@]}"; do
  if [ -z "${CONSERVAR[$n]:-}" ]; then
    chmod -R u+rwX -- "${RESPALDOS:?}/$n" 2>/dev/null || true
    rm -rf -- "${RESPALDOS:?}/$n"
  fi
done

exit 0
