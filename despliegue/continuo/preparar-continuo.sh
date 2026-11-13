#!/usr/bin/env bash
set -euo pipefail

ORIGEN_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
CAMPUSIA_RAIZ="${CAMPUSIA_RAIZ:-/srv/campusia}"
DESPLIEGUE_DIR="${DESPLIEGUE_DIR:-$CAMPUSIA_RAIZ/despliegue}"
CAMPUSIA_USUARIO="${CAMPUSIA_USUARIO:-campusia}"
UNIDADES_DIR="$CAMPUSIA_RAIZ/.config/systemd/user"
CAMBIOS=0

if [ "$(id -u)" -ne 0 ]; then
  printf 'preparar-continuo: hay que correrlo como root\n' >&2
  exit 1
fi
if ! id "$CAMPUSIA_USUARIO" >/dev/null 2>&1; then
  printf 'preparar-continuo: no existe el usuario %s\n' "$CAMPUSIA_USUARIO" >&2
  exit 1
fi
GRUPO="$(id -gn "$CAMPUSIA_USUARIO")"
UID_CAMPUSIA="$(id -u "$CAMPUSIA_USUARIO")"

directorio() {
  local ruta="$1" modo="$2"
  if [ -d "$ruta" ] && [ ! -L "$ruta" ] && [ "$(stat -c '%U:%G %a' "$ruta")" = "$CAMPUSIA_USUARIO:$GRUPO $modo" ]; then
    return 0
  fi
  install -d -o "$CAMPUSIA_USUARIO" -g "$GRUPO" -m "$modo" "$ruta"
  CAMBIOS=1
}

archivo() {
  local origen="$1" destino="$2" modo="$3"
  if [ -f "$destino" ] && [ ! -L "$destino" ] && cmp -s "$origen" "$destino" \
    && [ "$(stat -c '%U:%G %a' "$destino")" = "$CAMPUSIA_USUARIO:$GRUPO $modo" ]; then
    return 0
  fi
  rm -f "$destino"
  install -o "$CAMPUSIA_USUARIO" -g "$GRUPO" -m "$modo" "$origen" "$destino"
  CAMBIOS=1
}

enlace() {
  local objetivo="$1" ruta="$2"
  if [ -L "$ruta" ] && [ "$(readlink "$ruta")" = "$objetivo" ] && [ "$(stat -c '%U' "$ruta")" = "$CAMPUSIA_USUARIO" ]; then
    return 0
  fi
  rm -rf "$ruta"
  ln -s "$objetivo" "$ruta"
  chown -h "$CAMPUSIA_USUARIO:$GRUPO" "$ruta"
  CAMBIOS=1
}

if [ ! -d "$CAMPUSIA_RAIZ" ]; then
  directorio "$CAMPUSIA_RAIZ" 750
fi
directorio "$DESPLIEGUE_DIR" 750
for sub in fuentes cache bin bin/imagen; do
  directorio "$DESPLIEGUE_DIR/$sub" 750
done

for guion in desplegar.sh limpiar.sh registro.sh receptor.py; do
  archivo "$ORIGEN_DIR/$guion" "$DESPLIEGUE_DIR/bin/$guion" 755
done
archivo "$ORIGEN_DIR/imagen/Dockerfile" "$DESPLIEGUE_DIR/bin/imagen/Dockerfile" 644
archivo "$ORIGEN_DIR/continuo.env.ejemplo" "$DESPLIEGUE_DIR/bin/continuo.env.ejemplo" 644

for d in "$CAMPUSIA_RAIZ/.config" "$CAMPUSIA_RAIZ/.config/systemd" "$UNIDADES_DIR" "$UNIDADES_DIR/timers.target.wants" "$UNIDADES_DIR/default.target.wants"; do
  if [ -d "$d" ] && [ ! -L "$d" ] && [ "$(stat -c '%U' "$d")" = "$CAMPUSIA_USUARIO" ]; then
    continue
  fi
  directorio "$d" 755
done

UNIDADES="campusia-despliegue.service campusia-despliegue.timer campusia-receptor.service campusia-limpieza.service campusia-limpieza.timer"
for u in $UNIDADES; do
  archivo "$ORIGEN_DIR/systemd/$u" "$UNIDADES_DIR/$u" 644
done
enlace "$UNIDADES_DIR/campusia-despliegue.timer" "$UNIDADES_DIR/timers.target.wants/campusia-despliegue.timer"
enlace "$UNIDADES_DIR/campusia-limpieza.timer" "$UNIDADES_DIR/timers.target.wants/campusia-limpieza.timer"
enlace "$UNIDADES_DIR/campusia-receptor.service" "$UNIDADES_DIR/default.target.wants/campusia-receptor.service"

directorio_root() {
  local ruta="$1" modo="$2"
  if [ -d "$ruta" ] && [ ! -L "$ruta" ] && [ "$(stat -c '%U:%G %a' "$ruta")" = "root:root $modo" ]; then
    return 0
  fi
  if [ -L "$ruta" ] || { [ -e "$ruta" ] && [ ! -d "$ruta" ]; }; then
    rm -f "$ruta"
  fi
  install -d -o root -g root -m "$modo" "$ruta"
  chown root:root "$ruta"
  chmod "$modo" "$ruta"
  CAMBIOS=1
}

archivo_root() {
  local origen="$1" destino="$2" modo="$3"
  if [ -f "$destino" ] && [ ! -L "$destino" ] && cmp -s "$origen" "$destino" \
    && [ "$(stat -c '%U:%G %a' "$destino")" = "root:root $modo" ]; then
    return 0
  fi
  local temporal
  temporal="$(mktemp "$(dirname "$destino")/.campusia-instalar.XXXXXX")"
  install -o root -g root -m "$modo" "$origen" "$temporal"
  mv -f "$temporal" "$destino"
  CAMBIOS=1
}

INSTALADOR=/usr/local/sbin/campusia-instalar
SUDOERS=/etc/sudoers.d/campusia-instalar

if [ ! -d /usr/local/sbin ]; then
  install -d -o root -g root -m 0755 /usr/local/sbin
  CAMBIOS=1
fi
archivo_root "$ORIGEN_DIR/campusia-instalar" "$INSTALADOR" 755
directorio_root /var/lib/campusia-instalar 700

if ! command -v visudo >/dev/null 2>&1; then
  printf 'preparar-continuo: falta visudo; hay que instalar sudo\n' >&2
  exit 1
fi
REGLA="$(mktemp)"
trap 'rm -f "$REGLA"' EXIT
printf 'Defaults!%s env_reset\n%s ALL=(root) NOPASSWD: %s\n' "$INSTALADOR" "$CAMPUSIA_USUARIO" "$INSTALADOR" >"$REGLA"
chmod 0440 "$REGLA"
if ! visudo -cf "$REGLA" >/dev/null; then
  printf 'preparar-continuo: la regla de sudo no es válida\n' >&2
  exit 1
fi
if [ ! -d /etc/sudoers.d ] || [ -L /etc/sudoers.d ]; then
  directorio_root /etc/sudoers.d 755
fi
archivo_root "$REGLA" "$SUDOERS" 440
rm -f "$REGLA"

BUS="/run/user/$UID_CAMPUSIA/bus"
if [ "$CAMBIOS" = 1 ] && [ -S "$BUS" ] && command -v runuser >/dev/null 2>&1; then
  como_campusia() {
    runuser -u "$CAMPUSIA_USUARIO" -- env XDG_RUNTIME_DIR="/run/user/$UID_CAMPUSIA" DBUS_SESSION_BUS_ADDRESS="unix:path=$BUS" "$@"
  }
  {
    como_campusia systemctl --user daemon-reload
    como_campusia systemctl --user start campusia-despliegue.timer campusia-limpieza.timer
    if [ -f "$CAMPUSIA_RAIZ/config/campusia.env" ]; then
      como_campusia systemctl --user restart campusia-receptor.service
    fi
  } >/dev/null 2>&1 || printf 'preparar-continuo: no se pudieron recargar las unidades de usuario\n' >&2
fi

printf 'CAMBIOS=%s\n' "$CAMBIOS"
