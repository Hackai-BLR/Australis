#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

requerir_scripts "$PREPARAR_DOCKER"
comprobar "docker disponible para las pruebas" docker info
asegurar_imagen debian:trixie

T="$(nuevo_temporal)"
S="$T/salida"
escenario_debian debian:trixie "$S" CORRIDAS=2
UID_C="$(cat "$S/uid" 2>/dev/null)"
LOG1="$(cat "$S/log1" 2>/dev/null)"
LOG="$(cat "$S/log2" 2>/dev/null)"
LOG2="${LOG#"$LOG1"}"
SOCK="unix:///run/user/$UID_C/docker.sock"
E1="$S/estado1"
E2="$S/estado2"

lineas() { printf '%s\n' "$LOG" | grep -F -- "|$1|" | grep -E "^$2\|" ; }

seccion "preparar-docker.sh en Debian 13 simulado"
comprobar "el escenario corrió" test -n "$UID_C"
comprobar "primera corrida sale con 0" iguales "$(cat "$S/codigo1" 2>/dev/null)" 0
comprobar "segunda corrida sale con 0" iguales "$(cat "$S/codigo2" 2>/dev/null)" 0
if [ "$(cat "$S/codigo1" 2>/dev/null)" != 0 ]; then tail -n 15 "$S/corrida1.out" 2>/dev/null | sed 's/^/    /'; fi

seccion "repositorio oficial de Docker"
comprobar "descarga la clave de download.docker.com" contiene "$(lineas curl root)" "https://download.docker.com/linux/debian/gpg"
comprobar "guarda la clave en /etc/apt/keyrings/docker.asc" test -s "$E1/etc/apt/keyrings/docker.asc"
FUENTES="$(grep -rlF 'download.docker.com' "$E2/etc/apt/sources.list.d" 2>/dev/null)"
comprobar "hay exactamente un archivo de fuentes de Docker" iguales "$(printf '%s' "$FUENTES" | grep -c .)" 1
CONT="$(cat $FUENTES 2>/dev/null)"
comprobar "la fuente apunta a https://download.docker.com/linux/debian" contiene "$CONT" "https://download.docker.com/linux/debian"
comprobar "la fuente es para trixie" contiene "$CONT" "trixie"
comprobar "la fuente usa stable" contiene "$CONT" "stable"
comprobar "la fuente firma con docker.asc" contiene_re "$CONT" '[Ss]igned-[Bb]y[:=] ?/etc/apt/keyrings/docker\.asc'
comprobar "la fuente no cambia en la segunda corrida" diff -r "$E1/etc/apt/sources.list.d" "$E2/etc/apt/sources.list.d"

seccion "paquetes"
INSTALAR="$(lineas apt-get root | grep -E '\| ?.*install' )"
for p in docker-ce docker-ce-cli containerd.io docker-ce-rootless-extras uidmap dbus-user-session; do
  comprobar "instala $p" contiene_re "$INSTALAR" "(^|[ |])$p( |$)"
done
comprobar "instala slirp4netns o passt" contiene_re "$INSTALAR" '(^|[ |])(slirp4netns|passt)( |$)'
comprobar "corre apt-get update" contiene_re "$(lineas apt-get root)" '\|.*update'

seccion "Docker sin root para campusia"
comprobar "dockerd-rootless-setuptool.sh install como campusia" contiene_re "$(lineas dockerd-rootless-setuptool.sh campusia)" '\|.*install'
comprobar_no "dockerd-rootless-setuptool.sh nunca como root" contiene "$(lineas dockerd-rootless-setuptool.sh root)" "setuptool"
comprobar "el setuptool recibe XDG_RUNTIME_DIR" contiene "$(lineas dockerd-rootless-setuptool.sh campusia)" "XDG_RUNTIME_DIR=/run/user/$UID_C|"
comprobar "habilita el servicio de usuario docker" contiene_re "$(lineas systemctl campusia)" '\|.*--user.*enable.*docker|\|.*enable.*--user.*docker'
HELLO="$(lineas docker campusia | grep -E '\|run .*--rm.*hello-world')"
comprobar "prueba docker run --rm hello-world como campusia" contiene "$HELLO" "hello-world"
comprobar "con DOCKER_HOST del socket sin root" contiene "$HELLO" "DOCKER_HOST=$SOCK|"
comprobar "prueba límites de CPU y memoria sin root" contiene_re "$(lineas docker campusia)" '\|run .*--cpus.*--memory|\|run .*--memory.*--cpus'
comprobar_no "nunca usa docker como root" contiene "$(lineas docker root)" "docker"

seccion "Docker con root deshabilitado"
DESHAB="$(lineas systemctl root | grep -F 'disable')"
comprobar "deshabilita docker.service" contiene "$DESHAB" "docker.service"
comprobar "deshabilita docker.socket" contiene "$DESHAB" "docker.socket"
comprobar_no "campusia no queda en el grupo docker" contiene_re "$(cat "$S/grupos" 2>/dev/null)" '(^| )docker( |$)'

seccion "linger y cgroups"
comprobar "activa linger si faltaba" contiene "$(lineas loginctl root)" "enable-linger campusia"
comprobar_no "no repite enable-linger en la segunda corrida" contiene "$LOG2" "enable-linger"
DELEG="$(cat "$E2/etc/systemd/system/user@.service.d/delegate.conf" 2>/dev/null)"
comprobar "escribe delegate.conf" test -n "$DELEG"
comprobar "delegate.conf en [Service]" contiene "$DELEG" "[Service]"
for c in cpu cpuset io memory pids; do
  comprobar "delega $c" contiene_re "$(printf '%s\n' "$DELEG" | grep '^Delegate=')" "[= ]$c( |$)"
done
comprobar "recarga systemd" contiene "$(lineas systemctl root)" "daemon-reload"

seccion "drop-in de la unidad del núcleo"
DROP="$(cat "$E2/etc/systemd/system/campusia.service.d/docker.conf" 2>/dev/null)"
comprobar "escribe campusia.service.d/docker.conf" test -n "$DROP"
comprobar "DOCKER_HOST con el uid real" contiene_re "$DROP" "^Environment=\"?DOCKER_HOST=unix:///run/user/$UID_C/docker\.sock\"?$"
comprobar "XDG_RUNTIME_DIR con el uid real" contiene_re "$DROP" "^Environment=\"?XDG_RUNTIME_DIR=/run/user/$UID_C\"?$"
comprobar "After=user@uid.service" contiene "$DROP" "After=user@$UID_C.service"
comprobar "Wants=user@uid.service" contiene "$DROP" "Wants=user@$UID_C.service"

seccion "idempotencia"
comprobar "/etc/systemd/system queda igual tras la segunda corrida" diff -r "$E1/etc/systemd/system" "$E2/etc/systemd/system"
comprobar "keyrings quedan igual tras la segunda corrida" diff -r "$E1/etc/apt/keyrings" "$E2/etc/apt/keyrings"

seccion "con linger ya activo"
S2="$T/salida-linger"
escenario_debian debian:trixie "$S2" CORRIDAS=1 CON_LINGER=1
comprobar "sale con 0" iguales "$(cat "$S2/codigo1" 2>/dev/null)" 0
comprobar_no "no llama a enable-linger" contiene "$(cat "$S2/log1" 2>/dev/null)" "enable-linger"

terminar
