#!/bin/bash
set -euo pipefail
umask 077
export LC_ALL=C

uso() {
  printf 'uso: restaurar.sh [--destino DIR] <respaldo>\n' >&2
  exit 1
}

fallar() {
  printf 'restaurar: %s\n' "$*" >&2
  exit 1
}

rechazar() {
  printf 'restaurar: respaldo rechazado: %s\n' "$*" >&2
  exit 3
}

absoluta() {
  local d="$1"
  case "$d" in
    /*) printf '%s' "$d" ;;
    *) printf '%s/%s' "$PWD" "$d" ;;
  esac
}

DESTINO=""
CON_DESTINO=no
POSICIONALES=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --destino)
      [ "$#" -ge 2 ] || uso
      [ "$CON_DESTINO" = no ] || uso
      [ -n "$2" ] || uso
      DESTINO="$2"
      CON_DESTINO=si
      shift 2
      ;;
    --)
      shift
      while [ "$#" -gt 0 ]; do POSICIONALES+=("$1"); shift; done
      ;;
    -*)
      uso
      ;;
    *)
      POSICIONALES+=("$1")
      shift
      ;;
  esac
done
[ "${#POSICIONALES[@]}" -eq 1 ] || uso
[ -n "${POSICIONALES[0]}" ] || uso

RAIZ="$(absoluta "${CAMPUSIA_RAIZ:-/srv/campusia}")"
AHORA="${CAMPUSIA_AHORA:-$(date -u +%Y%m%d-%H%M%S)}"
USUARIO="${CAMPUSIA_USUARIO:-campusia}"
GRUPO="${CAMPUSIA_GRUPO:-campusia}"
DETENER="${RESTAURAR_DETENER:-si}"
SERVICIO="${CAMPUSIA_SERVICIO:-campusia.service}"

[[ "$AHORA" =~ ^[0-9]{8}-[0-9]{6}$ ]] || fallar "CAMPUSIA_AHORA inválida: $AHORA"
case "$DETENER" in si|no) ;; *) fallar "RESTAURAR_DETENER tiene que ser si o no" ;; esac
id -u -- "$USUARIO" >/dev/null 2>&1 || fallar "no existe el usuario $USUARIO"
getent group -- "$GRUPO" >/dev/null 2>&1 || fallar "no existe el grupo $GRUPO"

for herramienta in sqlite3 git tar gzip sha256sum find; do
  command -v "$herramienta" >/dev/null 2>&1 || fallar "falta $herramienta"
done

RESPALDO="$(absoluta "${POSICIONALES[0]}")"
if [ -d "$RESPALDO" ]; then
  TAR="$RESPALDO/respaldo.tar.gz"
elif [ -f "$RESPALDO" ]; then
  TAR="$RESPALDO"
else
  fallar "no existe el respaldo $RESPALDO"
fi
SUMA="$TAR.sha256"

if [ "$CON_DESTINO" = si ]; then
  DESTINO="$(absoluta "$DESTINO")"
  DESTINO="${DESTINO%/}"
  [ -n "$DESTINO" ] || fallar "destino no válido"
  if [ -e "$DESTINO" ] || [ -L "$DESTINO" ]; then
    [ -d "$DESTINO" ] && [ ! -L "$DESTINO" ] || fallar "el destino no es una carpeta: $DESTINO"
    [ -z "$(find "$DESTINO" -mindepth 1 -maxdepth 1 -print -quit)" ] || fallar "el destino no está vacío: $DESTINO"
    [ -w "$DESTINO" ] || fallar "no se puede escribir en $DESTINO"
    BASE_TEMPORAL="$DESTINO"
    DESTINO_EXISTE=si
  else
    BASE_TEMPORAL="$(dirname -- "$DESTINO")"
    [ -d "$BASE_TEMPORAL" ] && [ -w "$BASE_TEMPORAL" ] || fallar "no se puede crear $DESTINO"
    DESTINO_EXISTE=no
  fi
else
  [ -d "$RAIZ" ] || fallar "no existe $RAIZ"
  PREVIO="$RAIZ/previo-$AHORA"
  if [ -e "$PREVIO" ] || [ -L "$PREVIO" ]; then
    fallar "ya existe $PREVIO"
  fi
  BASE_TEMPORAL="$RAIZ"
fi

TEMPORAL=""
DETENIDO=no
terminar() {
  local codigo=$?
  if [ -n "$TEMPORAL" ] && [ -d "$TEMPORAL" ]; then
    chmod -R u+rwX -- "$TEMPORAL" 2>/dev/null || true
    rm -rf -- "$TEMPORAL"
  fi
  if [ "$DETENIDO" = si ]; then
    DETENIDO=no
    systemctl start "$SERVICIO" || codigo=1
  fi
  exit "$codigo"
}
trap terminar EXIT
trap 'exit 1' INT TERM HUP

TEMPORAL="$(mktemp -d "$BASE_TEMPORAL/.campusia-restaurar.XXXXXX")"
COPIA="$TEMPORAL/respaldo.tar.gz"
EXTRAIDO="$TEMPORAL/extraido"
NUEVO="$TEMPORAL/nuevo"
TRABAJO="$TEMPORAL/trabajo"
mkdir -- "$EXTRAIDO" "$NUEVO" "$TRABAJO"

[ -f "$TAR" ] || rechazar "falta respaldo.tar.gz"
[ -f "$SUMA" ] || rechazar "falta respaldo.tar.gz.sha256"
cp -- "$TAR" "$COPIA" || rechazar "no se pudo leer respaldo.tar.gz"
LINEA_SUMA="$(head -c 4096 -- "$SUMA")" || rechazar "no se pudo leer la suma"
[[ "$LINEA_SUMA" =~ ^([0-9a-f]{64})\ \ respaldo\.tar\.gz$ ]] || rechazar "formato de suma inválido"
ESPERADA="${BASH_REMATCH[1]}"
CALCULADA="$(sha256sum -- "$COPIA")" || rechazar "no se pudo calcular la suma"
CALCULADA="${CALCULADA%% *}"
[ "$CALCULADA" = "$ESPERADA" ] || rechazar "la suma de respaldo.tar.gz no coincide"

gzip -t -- "$COPIA" 2>/dev/null || rechazar "gzip corrupto"
NOMBRES="$TRABAJO/nombres"
TIPOS="$TRABAJO/tipos"
tar -tzPf "$COPIA" --quoting-style=escape > "$NOMBRES" 2>/dev/null || rechazar "el tar no se puede leer"
tar -tvzPf "$COPIA" --quoting-style=escape > "$TIPOS" 2>/dev/null || rechazar "el tar no se puede leer"
[ "$(wc -l < "$NOMBRES")" = "$(wc -l < "$TIPOS")" ] || rechazar "listado inconsistente"
[ -s "$NOMBRES" ] || rechazar "el tar está vacío"

if grep -qv -e '^-' -e '^d' -- "$TIPOS"; then
  rechazar "el tar tiene entradas que no son carpetas ni archivos regulares"
fi
while IFS= read -r nombre; do
  case "$nombre" in
    ''|/*|..|../*|*/..|*/../*)
      rechazar "ruta no permitida en el tar"
      ;;
  esac
done < "$NOMBRES"

tar -xzf "$COPIA" -C "$EXTRAIDO" --no-same-owner --no-same-permissions --no-overwrite-dir 2>/dev/null || rechazar "no se pudo extraer el tar"
rm -f -- "$COPIA"

if [ -n "$(find "$EXTRAIDO" -mindepth 1 ! -type f ! -type d -print -quit)" ]; then
  rechazar "el tar tiene entradas que no son carpetas ni archivos regulares"
fi
chmod -R u+rwX,go-rwx -- "$EXTRAIDO"

MANIFIESTO="$EXTRAIDO/MANIFIESTO.sha256"
[ -f "$MANIFIESTO" ] || rechazar "falta MANIFIESTO.sha256"
(cd -- "$EXTRAIDO" && find . -type f ! -path ./MANIFIESTO.sha256 -printf '%P\0' | sort -z | xargs -0 -r sha256sum --) > "$TRABAJO/calculado" || rechazar "no se pudieron calcular las sumas"
sort -- "$MANIFIESTO" > "$TRABAJO/declarado" || rechazar "manifiesto ilegible"
sort -- "$TRABAJO/calculado" > "$TRABAJO/calculado-ordenado"
cmp -s -- "$TRABAJO/declarado" "$TRABAJO/calculado-ordenado" || rechazar "el manifiesto no coincide con el contenido"

BASE="$EXTRAIDO/plataforma/campusia.db"
[ -f "$BASE" ] || rechazar "falta plataforma/campusia.db"
mkdir -- "$TRABAJO/prueba-base"
cp -- "$BASE" "$TRABAJO/prueba-base/base.db"
INTEGRIDAD="$(sqlite3 -init /dev/null -batch "$TRABAJO/prueba-base/base.db" "PRAGMA integrity_check" 2>/dev/null)" || rechazar "la base de la plataforma está dañada"
[ "$INTEGRIDAD" = ok ] || rechazar "la base de la plataforma está dañada"
rm -rf -- "$TRABAJO/prueba-base"

GIT=(git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c init.templateDir= -c advice.detachedHead=false)

armar_repo() {
  local bundle="$1" repo="$2" cabeza_archivo="$3" cabeza="" ref sha
  "${GIT[@]}" init -q -- "$repo" >/dev/null 2>&1 || return 1
  "${GIT[@]}" -C "$repo" config core.sharedRepository 0600 || return 1
  "${GIT[@]}" -C "$repo" bundle verify -q "$bundle" >/dev/null 2>&1 || return 1
  [ -n "$("${GIT[@]}" bundle list-heads "$bundle" 2>/dev/null)" ] || return 1
  "${GIT[@]}" -C "$repo" -c fetch.fsckObjects=true -c transfer.fsckObjects=true fetch -q --no-tags --update-head-ok -- "$bundle" 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*' >/dev/null 2>&1 || return 1
  if [ -f "$cabeza_archivo" ]; then
    cabeza="$(head -c 1024 -- "$cabeza_archivo")" || return 1
  else
    sha="$("${GIT[@]}" bundle list-heads "$bundle" 2>/dev/null | while IFS=' ' read -r s r; do if [ "$r" = HEAD ]; then printf '%s' "$s"; fi; done)"
    if [ -n "$sha" ]; then
      cabeza="$sha"
      while IFS=' ' read -r s r; do
        if [ "$s" = "$sha" ]; then
          if [ "$r" = refs/heads/main ] || [[ "$cabeza" != ref:* ]]; then cabeza="ref: $r"; fi
        fi
      done < <("${GIT[@]}" -C "$repo" for-each-ref --format='%(objectname) %(refname)' refs/heads)
    fi
  fi
  if [[ "$cabeza" =~ ^ref:\ (refs/heads/.+)$ ]]; then
    ref="${BASH_REMATCH[1]}"
    "${GIT[@]}" check-ref-format "$ref" >/dev/null 2>&1 || return 1
    "${GIT[@]}" -C "$repo" symbolic-ref HEAD "$ref" || return 1
  elif [[ "$cabeza" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then
    "${GIT[@]}" -C "$repo" cat-file -e "${BASH_REMATCH[1]}^{commit}" 2>/dev/null || return 1
    "${GIT[@]}" -C "$repo" update-ref --no-deref HEAD "${BASH_REMATCH[1]}" || return 1
  elif [ -n "$cabeza" ]; then
    return 1
  fi
  if "${GIT[@]}" -C "$repo" rev-parse -q --verify HEAD >/dev/null 2>&1; then
    "${GIT[@]}" -C "$repo" reset -q --hard >/dev/null 2>&1 || return 1
  fi
  [ -z "$("${GIT[@]}" -C "$repo" remote)" ] || return 1
  [ -n "$("${GIT[@]}" -C "$repo" for-each-ref --count=1 refs/heads refs/tags)" ] || return 1
  "${GIT[@]}" -C "$repo" fsck --no-dangling --no-progress >/dev/null 2>&1 || return 1
  return 0
}

mkdir -- "$NUEVO/datos" "$NUEVO/cursos"
mv -- "$BASE" "$NUEVO/datos/campusia.db"

if [ -d "$EXTRAIDO/cursos" ]; then
  while IFS= read -r -d '' curso; do
    id="${curso##*/}"
    dest="$NUEVO/cursos/$id"
    if [ -f "$curso/repo.bundle" ]; then
      armar_repo "$curso/repo.bundle" "$dest" "$curso/HEAD" || rechazar "el repo del curso no verifica: $id"
    else
      mkdir -- "$dest"
    fi
    if [ -d "$curso/datos" ]; then
      if [ -e "$dest/datos" ]; then
        rechazar "el curso tiene datos/ dentro del repo: $id"
      fi
      mv -- "$curso/datos" "$dest/datos"
    fi
  done < <(find "$EXTRAIDO/cursos" -mindepth 1 -maxdepth 1 -type d -print0)
fi

if [ -d "$EXTRAIDO/archivos" ]; then
  mv -- "$EXTRAIDO/archivos" "$NUEVO/archivos"
else
  mkdir -- "$NUEVO/archivos"
fi

chown -R -- "$USUARIO:$GRUPO" "$NUEVO/datos" "$NUEVO/cursos" "$NUEVO/archivos" || fallar "no se pudo cambiar el dueño"
chmod -R go-w -- "$NUEVO/datos" "$NUEVO/cursos" "$NUEVO/archivos"
chmod 700 -- "$NUEVO/datos"
chmod 600 -- "$NUEVO/datos/campusia.db"
while IFS= read -r -d '' datos; do
  chmod 700 -- "$datos"
  find "$datos" -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) -exec chmod 600 -- {} +
done < <(find "$NUEVO/cursos" -mindepth 2 -maxdepth 2 -type d -name datos -print0)

if [ "$CON_DESTINO" = si ]; then
  if [ "$DESTINO_EXISTE" = si ]; then
    mv -- "$NUEVO/datos" "$NUEVO/cursos" "$NUEVO/archivos" "$DESTINO/"
  else
    mv -T -- "$NUEVO" "$DESTINO"
  fi
  printf '%s\n' "$DESTINO"
  exit 0
fi

if [ "$DETENER" = si ]; then
  systemctl stop "$SERVICIO" || fallar "no se pudo detener $SERVICIO"
  DETENIDO=si
fi

mkdir -- "$PREVIO"
if [ -e "$RAIZ/datos/campusia.db" ] || [ -L "$RAIZ/datos/campusia.db" ]; then
  mkdir -p -- "$PREVIO/datos"
  for sufijo in "" -wal -shm -journal; do
    if [ -e "$RAIZ/datos/campusia.db$sufijo" ] || [ -L "$RAIZ/datos/campusia.db$sufijo" ]; then
      mv -- "$RAIZ/datos/campusia.db$sufijo" "$PREVIO/datos/"
    fi
  done
fi
for parte in cursos archivos; do
  if [ -e "$RAIZ/$parte" ] || [ -L "$RAIZ/$parte" ]; then
    mv -- "$RAIZ/$parte" "$PREVIO/$parte"
  fi
done

if [ -L "$RAIZ/datos" ]; then
  mv -- "$RAIZ/datos" "$PREVIO/datos-enlace"
fi
if [ ! -d "$RAIZ/datos" ]; then
  mkdir -- "$RAIZ/datos"
fi
chown -- "$USUARIO:$GRUPO" "$RAIZ/datos"
chmod 700 -- "$RAIZ/datos"
mv -- "$NUEVO/datos/campusia.db" "$RAIZ/datos/campusia.db"
mv -- "$NUEVO/cursos" "$RAIZ/cursos"
mv -- "$NUEVO/archivos" "$RAIZ/archivos"

printf '%s\n' "$RAIZ"
exit 0
