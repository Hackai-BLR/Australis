#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SERVICIO="$RESPALDO_DIR/campusia-respaldo.service"
TIMER="$RESPALDO_DIR/campusia-respaldo.timer"
LITESTREAM="$RESPALDO_DIR/litestream.yml"
SCRIPTS=("$RESPALDAR" "$RESTAURAR" "$PREPARAR_DOCKER")

seccion "archivos del tramo"
for f in "${SCRIPTS[@]}" "$SERVICIO" "$TIMER" "$LITESTREAM"; do
  comprobar "existe ${f#"$REPO_DIR"/}" test -f "$f"
done
for f in "${SCRIPTS[@]}"; do
  comprobar "${f#"$REPO_DIR"/} es ejecutable" test -x "$f"
  comprobar "${f#"$REPO_DIR"/} empieza con #!/bin/bash o #!/usr/bin/env bash" bash -c 'head -n 1 "$1" | grep -qE "^#!(/bin/bash|/usr/bin/env bash)"' _ "$f"
  comprobar "${f#"$REPO_DIR"/} pasa bash -n" bash -n "$f"
  comprobar_no "${f#"$REPO_DIR"/} no usa eval" grep -qE '(^|[^[:alnum:]_])eval([^[:alnum:]_]|$)' "$f"
  comprobar_no "${f#"$REPO_DIR"/} no tiene comentarios" bash -c 'tail -n +2 "$1" | grep -qE "^[[:space:]]*#"' _ "$f"
done

seccion "shellcheck"
SC=()
if command -v shellcheck >/dev/null 2>&1; then
  SC=(shellcheck)
elif command -v docker >/dev/null 2>&1 && asegurar_imagen koalaman/shellcheck:v0.10.0 && docker image inspect koalaman/shellcheck:v0.10.0 >/dev/null 2>&1; then
  SC=(docker run --rm --network none --mount "type=bind,src=$REPO_DIR,dst=/mnt,readonly" -w /mnt koalaman/shellcheck:v0.10.0)
fi
if [ "${#SC[@]}" -gt 0 ]; then
  for f in "${SCRIPTS[@]}"; do
    rel="${f#"$REPO_DIR"/}"
    if [ -f "$f" ]; then
      if [ "${SC[0]}" = shellcheck ]; then salida="$(shellcheck -s bash -S warning "$f" 2>&1)"; else salida="$("${SC[@]}" -s bash -S warning "$rel" 2>&1)"; fi
      if [ -z "$salida" ]; then ok "shellcheck sin advertencias: $rel"; else falla "shellcheck sin advertencias: $rel"; printf '%s\n' "$salida" | head -n 20 | sed 's/^/    /'; fi
    else
      falla "shellcheck sin advertencias: $rel (no existe)"
    fi
  done
else
  printf '  aviso  shellcheck no disponible, se omite\n'
fi

seccion "campusia-respaldo.service"
S="$(cat "$SERVICIO" 2>/dev/null)"
comprobar "Type=oneshot" contiene_re "$S" '^Type=oneshot$'
comprobar "User=campusia" contiene_re "$S" '^User=campusia$'
comprobar "Group=campusia" contiene_re "$S" '^Group=campusia$'
comprobar "UMask=0077" contiene_re "$S" '^UMask=0077$'
comprobar "ExecStart a respaldar.sh desplegado" contiene_re "$S" '^ExecStart=/srv/campusia/plataforma/despliegue/respaldo/respaldar\.sh$'
comprobar "NoNewPrivileges=yes" contiene_re "$S" '^NoNewPrivileges=(yes|true)$'
comprobar "PrivateTmp=yes" contiene_re "$S" '^PrivateTmp=(yes|true)$'
comprobar "ProtectSystem=strict" contiene_re "$S" '^ProtectSystem=strict$'
comprobar "ReadWritePaths incluye respaldos" contiene_re "$S" '^ReadWritePaths=.*/srv/campusia/respaldos'
comprobar_no "no carga campusia.env" contiene "$S" "campusia.env"

seccion "campusia-respaldo.timer"
TM="$(cat "$TIMER" 2>/dev/null)"
CAL="$(printf '%s\n' "$TM" | sed -n 's/^OnCalendar=//p' | head -n 1)"
comprobar "tiene OnCalendar" test -n "$CAL"
if command -v systemd-analyze >/dev/null 2>&1 && [ -n "$CAL" ]; then
  NORM="$(systemd-analyze calendar "$CAL" 2>/dev/null | sed -n 's/^ *Normalized form: //p')"
  comprobar "OnCalendar es diario a las 04:30" iguales "$NORM" "*-*-* 04:30:00"
else
  comprobar "OnCalendar es diario a las 04:30" iguales "$CAL" "*-*-* 04:30:00"
fi
comprobar "Persistent=true" contiene_re "$TM" '^Persistent=(true|yes)$'
comprobar "Unit=campusia-respaldo.service" contiene_re "$TM" '^Unit=campusia-respaldo\.service$'
comprobar "WantedBy=timers.target" contiene_re "$TM" '^WantedBy=timers\.target$'

seccion "litestream.yml"
L="$(cat "$LITESTREAM" 2>/dev/null)"
comprobar "replica /srv/campusia/datos/campusia.db" contiene_re "$L" 'path: */srv/campusia/datos/campusia\.db'
comprobar "réplica tipo s3" contiene_re "$L" 'type: *s3'
comprobar "endpoint de R2" contiene_re "$L" 'endpoint: *https://[^ ]*\.r2\.cloudflarestorage\.com'
comprobar "bucket campusia-respaldos" contiene_re "$L" 'bucket: *campusia-respaldos'
comprobar "region auto" contiene_re "$L" 'region: *auto'
comprobar "clave de acceso por variable" contiene "$L" '${LITESTREAM_ACCESS_KEY_ID}'
comprobar "secreto por variable" contiene "$L" '${LITESTREAM_SECRET_ACCESS_KEY}'
comprobar_no "sin claves literales" contiene_re "$(printf '%s\n' "$L" | grep -E '(access-key-id|secret-access-key):')" ':[[:space:]]*[^$[:space:]]'
if py -c 'import yaml' 2>/dev/null; then
  comprobar "YAML válido" py -c 'import sys, yaml; yaml.safe_load(open(sys.argv[1]))' "$LITESTREAM"
fi

seccion "alcance del tramo"
BASE="$(cd "$REPO_DIR" && git merge-base main HEAD 2>/dev/null)"
RAMA="$(cd "$REPO_DIR" && git rev-parse --abbrev-ref HEAD 2>/dev/null)"
FUERA=""
if [ "$RAMA" = "tramo-resguardo" ]; then
  FUERA="$(cd "$REPO_DIR" && { git diff --name-only "$BASE" -- nucleo interfaz plantilla-curso sdk despliegue; git ls-files --others --exclude-standard -- nucleo interfaz plantilla-curso sdk despliegue; } 2>/dev/null | grep -vE '^despliegue/(respaldo|docker)/' | head -n 5)"
fi
comprobar "no toca carpetas fuera del tramo" iguales "$FUERA" ""

terminar
