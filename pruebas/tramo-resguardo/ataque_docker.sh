#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

requerir_scripts "$PREPARAR_DOCKER"
comprobar "docker disponible para las pruebas" docker info
asegurar_imagen debian:trixie
asegurar_imagen debian:bookworm

T="$(nuevo_temporal)"

sin_cambios() {
  local s="$1" desc="$2"
  comprobar "$desc: sale con error" distintos "$(cat "$s/codigo1" 2>/dev/null)" 0
  comprobar "$desc: el escenario corrió" test -f "$s/codigo1"
  comprobar_no "$desc: no instala paquetes" contiene_re "$(cat "$s/log1" 2>/dev/null)" '\|apt-get\|.*install'
  comprobar_no "$desc: no configura el repositorio" bash -c 'grep -rqF download.docker.com "$1/estado1/etc/apt/sources.list.d" 2>/dev/null' _ "$s"
  comprobar_no "$desc: no corre el setuptool" contiene "$(cat "$s/log1" 2>/dev/null)" "dockerd-rootless-setuptool.sh"
}

seccion "sin root"
S="$T/sin-root"
escenario_debian debian:trixie "$S" CORRIDAS=1 COMO_CAMPUSIA=1
sin_cambios "$S" "como campusia"

seccion "sin subuid ni subgid"
S="$T/sin-subuid"
escenario_debian debian:trixie "$S" CORRIDAS=1 SIN_SUBUID=1
sin_cambios "$S" "sin subuid"

seccion "sin usuario campusia"
S="$T/sin-usuario"
escenario_debian debian:trixie "$S" CORRIDAS=1 SIN_USUARIO=1
sin_cambios "$S" "sin usuario"

seccion "otra versión de Debian"
S="$T/bookworm"
escenario_debian debian:bookworm "$S" CORRIDAS=1
sin_cambios "$S" "Debian 12"

seccion "campusia ya estaba en el grupo docker"
S="$T/grupo"
escenario_debian debian:trixie "$S" CORRIDAS=1 EN_GRUPO_DOCKER=1
comprobar "sale con 0" iguales "$(cat "$S/codigo1" 2>/dev/null)" 0
comprobar "el escenario corrió" test -f "$S/grupos"
comprobar_no "saca a campusia del grupo docker" contiene_re "$(cat "$S/grupos" 2>/dev/null)" '(^| )docker( |$)'

seccion "el script no da poder de root al servicio"
SCRIPT="$(cat "$PREPARAR_DOCKER")"
comprobar_no "no agrega a nadie al grupo docker" contiene_re "$SCRIPT" '(usermod[^#]*-a?G[^#]*docker|gpasswd -a|adduser campusia docker)'
comprobar_no "no habilita el docker del sistema" contiene_re "$SCRIPT" 'systemctl (enable|start)[^|;&]*docker\.(service|socket)'
comprobar_no "no abre permisos del socket" contiene_re "$SCRIPT" 'chmod [^|;&]*docker\.sock'

terminar
