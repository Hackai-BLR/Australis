#!/bin/bash
set -euo pipefail

USUARIO=campusia
MIN_IDS=65536

error() {
  printf 'preparar-docker: %s\n' "$1" >&2
  exit 1
}

escribir() {
  local destino="$1" modo="$2" contenido="$3" temporal
  temporal="$(mktemp "${destino}.XXXXXX")"
  printf '%s\n' "$contenido" > "$temporal"
  chmod "$modo" "$temporal"
  mv -f "$temporal" "$destino"
}

rango_suficiente() {
  local archivo="$1" nombre="$2" uid="$3"
  [ -r "$archivo" ] || return 1
  awk -F: -v n="$nombre" -v u="$uid" -v m="$MIN_IDS" '
    ($1 == n || $1 == u) && $3 + 0 >= m { hay = 1 }
    END { exit hay ? 0 : 1 }
  ' "$archivo"
}

if [ "$(id -u)" -ne 0 ]; then
  error "se tiene que correr como root"
fi

[ -r /etc/os-release ] || error "no se encuentra /etc/os-release"
ID_SO="$(. /etc/os-release && printf '%s' "${ID:-}")"
CODENAME="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-}")"
if [ "$ID_SO" != debian ] || [ "$CODENAME" != trixie ]; then
  error "se necesita Debian 13 (trixie)"
fi

if ! id -u "$USUARIO" >/dev/null 2>&1; then
  error "no existe el usuario $USUARIO"
fi
UID_C="$(id -u "$USUARIO")"
if ! rango_suficiente /etc/subuid "$USUARIO" "$UID_C"; then
  error "$USUARIO necesita al menos $MIN_IDS ids en /etc/subuid"
fi
if ! rango_suficiente /etc/subgid "$USUARIO" "$UID_C"; then
  error "$USUARIO necesita al menos $MIN_IDS ids en /etc/subgid"
fi

RUNTIME="/run/user/$UID_C"
SOCKET="unix://$RUNTIME/docker.sock"

export DEBIAN_FRONTEND=noninteractive

if ! command -v modprobe >/dev/null 2>&1; then
  apt-get update
  apt-get install -y kmod
fi
if [ ! -d /sys/module/br_netfilter ]; then
  modprobe br_netfilter || error "no se pudo cargar br_netfilter"
fi
install -m 0755 -d /etc/modules-load.d
escribir /etc/modules-load.d/campusia-docker.conf 0644 "br_netfilter"

if [ ! -e "/var/lib/systemd/linger/$USUARIO" ]; then
  loginctl enable-linger "$USUARIO"
fi

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

rm -f /etc/apt/sources.list.d/docker.list
escribir /etc/apt/sources.list.d/docker.sources 0644 "Types: deb
URIs: https://download.docker.com/linux/debian
Suites: trixie
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc"

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-ce-rootless-extras uidmap dbus-user-session slirp4netns

systemctl disable --now docker.service docker.socket

if id -nG "$USUARIO" | tr ' ' '\n' | grep -qx docker; then
  gpasswd -d "$USUARIO" docker
fi

install -m 0755 -d /etc/systemd/system/user@.service.d
escribir /etc/systemd/system/user@.service.d/delegate.conf 0644 "[Service]
Delegate=cpu cpuset io memory pids"
RED_CONF=/etc/systemd/user/docker.service.d/campusia-red.conf
RED_CONTENIDO="[Service]
Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_DETACH_NETNS=false"
RED_CAMBIO=0
if [ ! -f "$RED_CONF" ] || [ -L "$RED_CONF" ] || [ "$(cat "$RED_CONF")" != "$RED_CONTENIDO" ]; then
  RED_CAMBIO=1
fi
install -m 0755 -d /etc/systemd/user/docker.service.d
escribir "$RED_CONF" 0644 "$RED_CONTENIDO"
systemctl daemon-reload

esperar_bus() {
  local _
  for _ in $(seq 1 "$1"); do
    [ -S "$RUNTIME/bus" ] && return 0
    sleep 1
  done
  return 1
}

systemctl start "user@$UID_C.service"
if [ -d /run/systemd/system ] && ! esperar_bus 10; then
  systemctl restart "user@$UID_C.service"
  esperar_bus 60 || error "no aparece $RUNTIME/bus"
fi

como_usuario() {
  runuser -u "$USUARIO" -- env \
    XDG_RUNTIME_DIR="$RUNTIME" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$RUNTIME/bus" \
    DOCKER_HOST="$SOCKET" \
    "$@"
}

cd /
HOGAR="$(getent passwd "$USUARIO" | cut -d: -f6)"
[ -n "$HOGAR" ] && [ -d "$HOGAR" ] || error "$USUARIO no tiene carpeta personal"
if [ "$(stat -f -c %T "$HOGAR")" = overlayfs ] && [ ! -e "$HOGAR/.config/docker/daemon.json" ]; then
  como_usuario mkdir -p "$HOGAR/.config/docker"
  como_usuario sh -c 'umask 077 && printf "%s\n" "{\"storage-driver\": \"vfs\"}" > "$1"' sh "$HOGAR/.config/docker/daemon.json"
fi

como_usuario dockerd-rootless-setuptool.sh install
como_usuario systemctl --user daemon-reload
como_usuario systemctl --user enable --now docker
if [ "$RED_CAMBIO" = 1 ]; then
  como_usuario systemctl --user restart docker
fi
como_usuario docker run --rm hello-world
como_usuario docker run --rm --cpus 0.5 --memory 64m hello-world

install -m 0755 -d /etc/systemd/system/campusia.service.d
escribir /etc/systemd/system/campusia.service.d/docker.conf 0644 "[Unit]
Wants=user@$UID_C.service
After=user@$UID_C.service
StartLimitIntervalSec=0

[Service]
Environment=XDG_RUNTIME_DIR=$RUNTIME
Environment=DOCKER_HOST=$SOCKET
ExecStartPre=/usr/bin/timeout 90 /bin/sh -c 'until /usr/bin/docker version >/dev/null 2>&1; do sleep 1; done'
TimeoutStartSec=120"
systemctl daemon-reload
