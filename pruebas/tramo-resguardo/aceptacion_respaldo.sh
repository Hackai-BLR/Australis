#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

requerir_scripts "$RESPALDAR" "$RESTAURAR"

T="$(nuevo_temporal)"
R="$T/srv/campusia"
crear_raiz "$R"
entorno_respaldo "$R"
cd "$T" || exit 1

seccion "respaldo con la base en uso y datos en el WAL"
coproc WAL { py "$PRUEBAS_DIR/mantener_wal.py" "$R/datos/campusia.db"; }
read -r -t 20 listo <&"${WAL[0]}"
comprobar "la base queda abierta con filas solo en el WAL" iguales "${listo:-}" "listo"
comprobar "el WAL tiene datos sin volcar" test -s "$R/datos/campusia.db-wal"

salida="$(CAMPUSIA_AHORA=20261110-043000 bash "$RESPALDAR" 2>"$T/respaldar.err")"
codigo=$?
exec {WAL[1]}>&-
wait "$WAL_PID" 2>/dev/null

comprobar "respaldar.sh sale con 0" iguales "$codigo" 0
ESPERADO="$R/respaldos/20261110-043000"
comprobar "imprime la ruta del respaldo en la última línea" iguales "$(printf '%s\n' "$salida" | tail -n 1)" "$ESPERADO"
comprobar "crea respaldo.tar.gz" test -s "$ESPERADO/respaldo.tar.gz"
comprobar "crea respaldo.tar.gz.sha256" test -s "$ESPERADO/respaldo.tar.gz.sha256"
comprobar "la suma externa verifica" bash -c 'cd "$1" && sha256sum --quiet -c respaldo.tar.gz.sha256' _ "$ESPERADO"
comprobar "la suma externa nombra respaldo.tar.gz" grep -qE '^[0-9a-f]{64}  respaldo\.tar\.gz$' "$ESPERADO/respaldo.tar.gz.sha256"

LISTA="$(tar -tzf "$ESPERADO/respaldo.tar.gz" 2>/dev/null | sed 's#^\./##')"
comprobar "el tar tiene MANIFIESTO.sha256" contiene "$LISTA" "MANIFIESTO.sha256"
comprobar "el tar tiene plataforma/campusia.db" contiene "$LISTA" "plataforma/campusia.db"
comprobar "el tar tiene el bundle de algebra-1" contiene "$LISTA" "cursos/algebra-1/repo.bundle"
comprobar "el tar tiene el bundle de programacion" contiene "$LISTA" "cursos/programacion/repo.bundle"
comprobar "el tar tiene la base del curso" contiene "$LISTA" "cursos/algebra-1/datos/curso.db"
comprobar "el tar tiene las subidas del curso" contiene "$LISTA" "cursos/programacion/datos/subidas/tarea.bin"
comprobar "el tar tiene los archivos de la plataforma" contiene "$LISTA" "archivos/entregas/2026/tp1 ana.pdf"
comprobar_no "el tar no tiene archivos -wal ni -shm" contiene_re "$LISTA" '-(wal|shm)$'
comprobar_no "el tar no tiene rutas absolutas" contiene_re "$LISTA" '^/'

EXTR="$T/extraido"
mkdir -p "$EXTR"
tar -xzf "$ESPERADO/respaldo.tar.gz" -C "$EXTR" 2>/dev/null
comprobar "el manifiesto verifica dentro del tar" bash -c 'cd "$1" && sha256sum --quiet -c MANIFIESTO.sha256' _ "$EXTR"
EN_MANIFIESTO="$(sed -E 's/^[0-9a-f]{64}  //; s#^\./##' "$EXTR/MANIFIESTO.sha256" 2>/dev/null | sort)"
EN_TAR="$(cd "$EXTR" && find . -type f ! -name MANIFIESTO.sha256 -printf '%P\n' | sort)"
comprobar "el manifiesto lista exactamente los archivos del tar" iguales "$EN_MANIFIESTO" "$EN_TAR"
comprobar "la copia de la base incluye lo que estaba en el WAL" iguales "$(sqlite3 "$EXTR/plataforma/campusia.db" "SELECT count(*) FROM auditoria WHERE que LIKE 'en-wal-%'" 2>/dev/null)" "50"
comprobar "el bundle verifica" git -C "$R/cursos/algebra-1" bundle verify "$EXTR/cursos/algebra-1/repo.bundle"

ORIGINAL="$(instantanea "$R")"

seccion "restauración en modo de prueba (--destino)"
ANTES_RAIZ="$(instantanea "$R")"
bash "$RESTAURAR" --destino "$T/prueba" "$ESPERADO" >"$T/r1.out" 2>&1
comprobar "restaurar.sh --destino sale con 0" iguales "$?" 0
comprobar "el destino tiene todo igual al original" iguales "$(instantanea "$T/prueba")" "$ORIGINAL"
comprobar "el destino tiene la base de la plataforma" test -f "$T/prueba/datos/campusia.db"
comprobar "no toca la raíz real" iguales "$(instantanea "$R")" "$ANTES_RAIZ"
comprobar_no "el destino no tiene config" existe "$T/prueba/config"
comprobar "el repo restaurado no tiene remotos" iguales "$(git -C "$T/prueba/cursos/algebra-1" remote)" ""
comprobar "el repo restaurado tiene ramas main y prueba" iguales "$(git -C "$T/prueba/cursos/algebra-1" for-each-ref --format='%(refname:short)' refs/heads | sort | tr '\n' ' ')" "main prueba "
comprobar "el repo restaurado tiene etiquetas v1 y v2" iguales "$(git -C "$T/prueba/cursos/algebra-1" tag | sort | tr '\n' ' ')" "v1 v2 "
comprobar "el árbol de trabajo está en HEAD" test -f "$T/prueba/cursos/algebra-1/src/unidades.ts"
comprobar_no "el árbol de trabajo no tiene archivos de la rama prueba" existe "$T/prueba/cursos/algebra-1/src/borrador.ts"

mkdir -p "$T/ocupado"
printf 'x' > "$T/ocupado/algo"
bash "$RESTAURAR" --destino "$T/ocupado" "$ESPERADO" >/dev/null 2>&1
comprobar "--destino con una carpeta no vacía sale con 1" iguales "$?" 1
comprobar "--destino no vacío queda intacto" iguales "$(ls -A "$T/ocupado")" "algo"

seccion "respaldar, borrar y restaurar en la raíz real"
BIN="$T/bin"
LOG="$T/systemctl.log"
systemctl_falso "$BIN" "$LOG"
rm -rf "$R/datos" "$R/cursos" "$R/archivos"
ENV_ANTES="$(sha256sum "$R/config/campusia.env")"
PATH="$BIN:$PATH" RESTAURAR_DETENER=si CAMPUSIA_AHORA=20261110-050000 bash "$RESTAURAR" "$ESPERADO/respaldo.tar.gz" >"$T/r2.out" 2>&1
comprobar "restaurar.sh con la ruta del tar sale con 0" iguales "$?" 0
comprobar "todo volvió idéntico" iguales "$(instantanea "$R")" "$ORIGINAL"
comprobar "detuvo el servicio" grep -qx 'stop campusia.service' "$LOG"
comprobar "inició el servicio" grep -qx 'start campusia.service' "$LOG"
comprobar "detuvo antes de iniciar" iguales "$(grep -oE '^(stop|start)' "$LOG" | tr '\n' ' ')" "stop start "
comprobar "no tocó config/campusia.env" iguales "$(sha256sum "$R/config/campusia.env")" "$ENV_ANTES"
comprobar "el respaldo sigue en su lugar" test -s "$ESPERADO/respaldo.tar.gz"

seccion "dueños y permisos de lo restaurado"
comprobar "datos/ con 0700" modo_es "$R/datos" 700
comprobar "datos/campusia.db con 0600" modo_es "$R/datos/campusia.db" 600
comprobar "datos del curso con 0700" modo_es "$R/cursos/algebra-1/datos" 700
comprobar "base del curso con 0600" modo_es "$R/cursos/algebra-1/datos/curso.db" 600
comprobar "nada restaurado escribible por grupo u otros" iguales "$(find "$R/datos" "$R/cursos" "$R/archivos" -perm /022 ! -type l | head -n 5)" ""
comprobar "todo restaurado pertenece al usuario configurado" iguales "$(find "$R/datos" "$R/cursos" "$R/archivos" \( ! -user "$CAMPUSIA_USUARIO" -o ! -group "$CAMPUSIA_GRUPO" \) | head -n 5)" ""
comprobar "la base restaurada pasa integrity_check" iguales "$(sqlite3 "$R/datos/campusia.db" 'PRAGMA integrity_check')" "ok"
comprobar "git fsck del curso restaurado" git -C "$R/cursos/programacion" fsck --no-progress

seccion "restaurar sobre datos actuales los guarda en previo-*"
sqlite3 "$R/datos/campusia.db" "INSERT INTO usuarios(email, rol, creado) VALUES ('posterior@austral.edu.ar', 'comun', '2026-11-10T06:00:00Z')"
printf 'cambio\n' > "$R/archivos/entregas/2026/leeme.txt"
: > "$LOG"
PATH="$BIN:$PATH" RESTAURAR_DETENER=no CAMPUSIA_AHORA=20261111-000000 bash "$RESTAURAR" "$ESPERADO" >"$T/r3.out" 2>&1
comprobar "restaurar.sh sale con 0" iguales "$?" 0
comprobar "la raíz volvió al respaldo" iguales "$(instantanea "$R")" "$ORIGINAL"
PREVIO="$R/previo-20261111-000000"
comprobar "guardó la base anterior en previo-*" iguales "$(sqlite3 "$PREVIO/datos/campusia.db" "SELECT count(*) FROM usuarios WHERE email='posterior@austral.edu.ar'" 2>/dev/null)" "1"
comprobar "guardó los archivos anteriores en previo-*" grep -qx cambio "$PREVIO/archivos/entregas/2026/leeme.txt"
comprobar "guardó los cursos anteriores en previo-*" test -d "$PREVIO/cursos/algebra-1/.git"
comprobar "con RESTAURAR_DETENER=no no llama a systemctl" iguales "$(cat "$LOG")" ""

seccion "un segundo respaldo con el mismo nombre se rechaza"
CAMPUSIA_AHORA=20261110-043000 bash "$RESPALDAR" >/dev/null 2>&1
comprobar "respaldar.sh sale con 1" iguales "$?" 1
comprobar "el respaldo existente no cambió" bash -c 'cd "$1" && sha256sum --quiet -c respaldo.tar.gz.sha256' _ "$ESPERADO"

seccion "argumentos inválidos"
bash "$RESTAURAR" >/dev/null 2>&1
comprobar "restaurar.sh sin argumentos sale con 1" iguales "$?" 1
bash "$RESTAURAR" --destino "$T/x" "$T/no-existe" >/dev/null 2>&1
comprobar "restaurar.sh con un respaldo inexistente sale con 1" iguales "$?" 1

terminar
