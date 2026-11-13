#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

requerir_scripts "$RESPALDAR" "$RESTAURAR"

T="$(nuevo_temporal)"
R="$T/srv/campusia"
RAROS=("curso con espacios" "ñandú-2026" '$(touch PWNED)' '`touch PWNED2`' "-rf" "--help" 'a;b|c&d' "comillas'\"x" '*' 'x$HOME')
crear_raiz "$R" algebra-1 "${RAROS[@]}"
entorno_respaldo "$R"
mkdir -p "$T/trabajo"
cd "$T/trabajo" || exit 1

seccion "secretos fuera del respaldo"
ln -s ../config/campusia.env "$R/archivos/enlace-env"
ln -s ../config "$R/archivos/enlace-config"
ln -s "$R/config/campusia.env" "$R/cursos/algebra-1/datos/env"
ln -s /etc/passwd "$R/archivos/passwd"

seccion "permisos del respaldo con umask permisiva"
umask 022
SALIDA="$(CAMPUSIA_AHORA=20261110-043000 bash "$RESPALDAR" 2>"$T/respaldar.err")"
comprobar "respaldar.sh sale con 0 con nombres raros y enlaces" iguales "$?" 0
B="$R/respaldos/20261110-043000"
comprobar "imprime la ruta del respaldo" iguales "$(printf '%s\n' "$SALIDA" | tail -n 1)" "$B"
comprobar "carpeta de respaldos con 0700" modo_es "$R/respaldos" 700
comprobar "carpeta del respaldo con 0700" modo_es "$B" 700
comprobar "respaldo.tar.gz con 0600" modo_es "$B/respaldo.tar.gz" 600
comprobar "respaldo.tar.gz.sha256 con 0600" modo_es "$B/respaldo.tar.gz.sha256" 600
comprobar "nada en los respaldos legible por grupo u otros" iguales "$(find "$R/respaldos" -perm /077 | head -n 3)" ""
umask 077

comprobar_no "el secreto no aparece en el tar descomprimido" bash -c 'gzip -dc "$1" | grep -aqF "$2"' _ "$B/respaldo.tar.gz" "$SECRETO_PRUEBA"
comprobar_no "el secreto no aparece en ningún archivo de respaldos" grep -rqaF "$SECRETO_PRUEBA" "$R/respaldos"
LISTA="$(tar -tvzf "$B/respaldo.tar.gz" 2>/dev/null)"
comprobar_no "el tar no tiene campusia.env" contiene "$LISTA" "campusia.env"
comprobar_no "el tar no tiene la carpeta config" contiene_re "$LISTA" '(^| |/)config(/|$)'
comprobar_no "el tar no tiene enlaces" contiene_re "$LISTA" '^[lh]'
comprobar_no "el tar no tiene el contenido de /etc/passwd" bash -c 'gzip -dc "$1" | grep -aq "^root:x:0:0:"' _ "$B/respaldo.tar.gz"
comprobar "solo carpetas y archivos regulares en el tar" iguales "$(printf '%s\n' "$LISTA" | grep -vE '^[-d]' | head -n 3)" ""

seccion "nombres de curso con caracteres raros"
rm -f "$R/archivos/enlace-env" "$R/archivos/enlace-config" "$R/archivos/passwd" "$R/cursos/algebra-1/datos/env"
ORIGINAL="$(instantanea "$R")"
bash "$RESTAURAR" --destino "$T/prueba" "$B" >"$T/r.out" 2>&1
comprobar "restaurar.sh --destino sale con 0" iguales "$?" 0
comprobar "todos los cursos vuelven idénticos" iguales "$(instantanea "$T/prueba")" "$ORIGINAL"
for id in "${RAROS[@]}"; do
  comprobar "restaura el curso ${id}" test -d "$T/prueba/cursos/$id/.git"
done
comprobar "restaura exactamente los cursos del respaldo" iguales "$(find "$T/prueba/cursos" -mindepth 1 -maxdepth 1 | wc -l)" "$((${#RAROS[@]} + 1))"
comprobar_no "ningún nombre se ejecutó como comando" bash -c 'find "$1" "$2" "$HOME" -maxdepth 4 -name "PWNED*" 2>/dev/null | grep -q .' _ "$T" "$R"
comprobar_no "no apareció nada fuera del destino" existe "$T/trabajo/PWNED"

seccion "respaldos corruptos o manipulados se rechazan sin tocar los datos"
BIN="$T/bin"
LOG="$T/systemctl.log"
systemctl_falso "$BIN" "$LOG"
mkdir -p "$T/afuera"
ANTES="$(instantanea "$R")"
ENV_ANTES="$(sha256sum "$R/config/campusia.env")"
ABSOLUTA="$T/afuera/absoluta.txt"
CASOS=(byte suma-cero sin-suma truncado contenido extra faltante escape escape-profundo absoluta enlace enlace-pasaje duro fifo base-rota bundle-roto manifiesto-escape sin-manifiesto sin-base)
for caso in "${CASOS[@]}"; do
  M="$T/manipulados/$caso"
  arg=""
  [ "$caso" = absoluta ] && arg="$ABSOLUTA"
  [ "$caso" = enlace-pasaje ] && arg="$T/afuera"
  if ! py "$PRUEBAS_DIR/manipular.py" "$B" "$M" "$caso" "$arg" >"$T/manipular.err" 2>&1; then
    falla "no se pudo preparar el caso $caso: $(tail -n 1 "$T/manipular.err")"
    continue
  fi
  : > "$LOG"
  PATH="$BIN:$PATH" RESTAURAR_DETENER=si CAMPUSIA_AHORA=20261112-000000 bash "$RESTAURAR" "$M" >"$T/caso.out" 2>&1
  comprobar "$caso: restaurar.sh sale con 3" iguales "$?" 3
  comprobar "$caso: los datos actuales no cambian" iguales "$(instantanea "$R")" "$ANTES"
  comprobar "$caso: no crea previo-*" iguales "$(find "$R" -maxdepth 1 -name 'previo-*' | head -n 1)" ""
  comprobar "$caso: no detiene el servicio" iguales "$(cat "$LOG")" ""
  bash "$RESTAURAR" --destino "$T/destino-$caso" "$M" >/dev/null 2>&1
  comprobar "$caso: --destino sale con 3" iguales "$?" 3
  comprobar "$caso: --destino queda sin datos" iguales "$(find "$T/destino-$caso" -mindepth 1 2>/dev/null | head -n 1)" ""
done
comprobar "ninguna entrada escapó del destino" iguales "$(find "$T" -maxdepth 2 -name 'fuera*.txt' | head -n 1)" ""
comprobar "ninguna entrada escapó a la carpeta de respaldos" iguales "$(find "$R/respaldos" -name 'fuera*.txt' | head -n 1)" ""
comprobar "la ruta absoluta no se escribió" no_existe "$ABSOLUTA"
comprobar "el enlace no se usó para escribir afuera" no_existe "$T/afuera/escrito.txt"
comprobar "config/campusia.env intacto" iguales "$(sha256sum "$R/config/campusia.env")" "$ENV_ANTES"
comprobar "no quedan temporales de verificación en /tmp" iguales "$(find "${TMPDIR:-/tmp}" -maxdepth 1 -newer "$B/respaldo.tar.gz" -user "$(id -un)" -name '*' ! -name 'campusia-resguardo.*' -type d -exec test -e '{}/MANIFIESTO.sha256' ';' -print 2>/dev/null | head -n 1)" ""

seccion "el respaldo bueno sigue funcionando después de los ataques"
bash "$RESTAURAR" --destino "$T/final" "$B" >/dev/null 2>&1
comprobar "restaura el respaldo original" iguales "$?" 0

terminar
