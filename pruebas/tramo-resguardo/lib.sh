set -uo pipefail

PRUEBAS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$PRUEBAS_DIR/../.." && pwd)"
RESPALDO_DIR="$REPO_DIR/despliegue/respaldo"
DOCKER_DIR="$REPO_DIR/despliegue/docker"
RESPALDAR="$RESPALDO_DIR/respaldar.sh"
RESTAURAR="$RESPALDO_DIR/restaurar.sh"
PREPARAR_DOCKER="$DOCKER_DIR/preparar-docker.sh"
FALLAS=0
PASADAS=0
SECRETO_PRUEBA="SECRETO_DE_PRUEBA_7f3a9c21e5b84d06"

ok() { PASADAS=$((PASADAS + 1)); printf '  ok     %s\n' "$1"; }
falla() { FALLAS=$((FALLAS + 1)); printf '  FALLA  %s\n' "$1"; }

comprobar() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else falla "$desc"; fi
}

comprobar_no() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then falla "$desc"; else ok "$desc"; fi
}

iguales() { [ "$1" = "$2" ]; }
distintos() { [ "$1" != "$2" ]; }
existe() { [ -e "$1" ]; }
no_existe() { [ ! -e "$1" ] && [ ! -L "$1" ]; }
modo_es() { [ "$(stat -c %a -- "$1")" = "$2" ]; }
contiene() { printf '%s' "$1" | grep -qF -- "$2"; }
contiene_re() { printf '%s' "$1" | grep -qE -- "$2"; }

seccion() { printf '\n== %s\n' "$1"; }

terminar() {
  printf '\n%s: %d pasadas, %d fallas\n' "$(basename "$0")" "$PASADAS" "$FALLAS"
  [ "$FALLAS" -eq 0 ]
  exit $?
}

TEMPORALES=()
nuevo_temporal() {
  local d
  d="$(mktemp -d "${TMPDIR:-/tmp}/campusia-resguardo.XXXXXX")"
  TEMPORALES+=("$d")
  printf '%s' "$d"
}
limpiar_temporales() {
  local d
  for d in "${TEMPORALES[@]}"; do
    chmod -R u+rwX "$d" 2>/dev/null
    rm -rf "$d"
  done
}
trap limpiar_temporales EXIT

py() { python3 -I "$@"; }

instantanea() { py "$PRUEBAS_DIR/instantanea.py" "$1"; }

crear_curso() {
  local raiz="$1" id="$2"
  local dir="$raiz/cursos/$id"
  mkdir -p -- "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email "profe@austral.edu.ar"
  git -C "$dir" config user.name "Profe Prueba"
  git -C "$dir" config commit.gpgsign false
  printf 'datos/\n' > "$dir/.gitignore"
  printf '# Curso %s\n' "$id" > "$dir/README.md"
  mkdir -p "$dir/src"
  printf 'export const nombre = "%s";\n' "$id" > "$dir/src/index.ts"
  git -C "$dir" add -A
  GIT_COMMITTER_DATE="2026-10-01T10:00:00Z" git -C "$dir" commit -q --date="2026-10-01T10:00:00Z" -m "Versión inicial"
  git -C "$dir" tag v1
  printf 'export const unidades = 3;\n' > "$dir/src/unidades.ts"
  git -C "$dir" add -A
  GIT_COMMITTER_DATE="2026-10-05T10:00:00Z" git -C "$dir" commit -q --date="2026-10-05T10:00:00Z" -m "Agrega unidades"
  git -C "$dir" tag -a v2 -m "Versión 2"
  git -C "$dir" checkout -q -b prueba
  printf 'export const borrador = true;\n' > "$dir/src/borrador.ts"
  git -C "$dir" add -A
  GIT_COMMITTER_DATE="2026-10-07T10:00:00Z" git -C "$dir" commit -q --date="2026-10-07T10:00:00Z" -m "Borrador del agente"
  git -C "$dir" checkout -q main
  mkdir -p "$dir/datos/subidas"
  sqlite3 "$dir/datos/curso.db" "PRAGMA journal_mode=WAL; CREATE TABLE entregas(id INTEGER PRIMARY KEY, alumno TEXT, nota REAL, archivo BLOB); INSERT INTO entregas(alumno, nota, archivo) VALUES ('ana@austral.edu.ar', 9.5, x'00ff10'), ('bruno@austral.edu.ar', 7, NULL), ('ñoño@austral.edu.ar', 4.25, x'cafe');" >/dev/null
  head -c 4096 /dev/urandom > "$dir/datos/subidas/tarea.bin"
  printf 'notas del curso %s\n' "$id" > "$dir/datos/notas.txt"
}

crear_raiz() {
  local raiz="$1"
  shift
  mkdir -p "$raiz/datos" "$raiz/cursos" "$raiz/archivos/entregas/2026" "$raiz/archivos/vacia" "$raiz/config"
  sqlite3 "$raiz/datos/campusia.db" "
    PRAGMA journal_mode=WAL;
    CREATE TABLE usuarios(id INTEGER PRIMARY KEY, email TEXT UNIQUE, rol TEXT, creado TEXT);
    CREATE TABLE cursos(id TEXT PRIMARY KEY, nombre TEXT, dueno INTEGER REFERENCES usuarios(id));
    CREATE TABLE auditoria(id INTEGER PRIMARY KEY, quien INTEGER, que TEXT, datos BLOB, cuando TEXT);
    INSERT INTO usuarios(email, rol, creado) VALUES
      ('owner@campusia.tech', 'owner', '2026-11-01T00:00:00Z'),
      ('admin@austral.edu.ar', 'administrador', '2026-11-01T00:00:00Z'),
      ('profe@austral.edu.ar', 'profesor', '2026-11-02T00:00:00Z'),
      ('ana@austral.edu.ar', 'comun', '2026-11-03T00:00:00Z');
    INSERT INTO cursos VALUES ('algebra-1', 'Álgebra I', 3), ('programacion', 'Programación', 3);
    INSERT INTO auditoria(quien, que, datos, cuando) VALUES (1, 'login', x'0102030405', '2026-11-04T12:00:00Z'), (3, 'publicacion', NULL, '2026-11-05T12:00:00Z');
  " >/dev/null
  head -c 20000 /dev/urandom > "$raiz/archivos/entregas/2026/tp1 ana.pdf"
  printf 'hola\n' > "$raiz/archivos/entregas/2026/leeme.txt"
  : > "$raiz/archivos/entregas/vacio.txt"
  printf 'ACCESO=%s\nBREVO_API_KEY=%s-brevo\n' "$SECRETO_PRUEBA" "$SECRETO_PRUEBA" > "$raiz/config/campusia.env"
  chmod 600 "$raiz/config/campusia.env"
  local id
  if [ "$#" -eq 0 ]; then set -- algebra-1 programacion; fi
  for id in "$@"; do crear_curso "$raiz" "$id"; done
}

entorno_respaldo() {
  local raiz="$1"
  export CAMPUSIA_RAIZ="$raiz"
  export CAMPUSIA_RESPALDOS="$raiz/respaldos"
  export CAMPUSIA_USUARIO
  CAMPUSIA_USUARIO="$(id -un)"
  export CAMPUSIA_GRUPO
  CAMPUSIA_GRUPO="$(id -gn)"
  export RESTAURAR_DETENER=no
  unset CAMPUSIA_AHORA RESPALDO_DIARIOS RESPALDO_SEMANALES CAMPUSIA_SERVICIO
}

systemctl_falso() {
  local dir="$1" log="$2"
  mkdir -p "$dir"
  cat > "$dir/systemctl" <<EOF
#!/bin/bash
printf '%s\n' "\$*" >> "$log"
exit 0
EOF
  chmod +x "$dir/systemctl"
  : > "$log"
}

requerir_scripts() {
  local f faltan=0
  for f in "$@"; do
    if [ ! -f "$f" ]; then
      falla "no existe ${f#"$REPO_DIR"/}"
      faltan=1
    fi
  done
  if [ "$faltan" -ne 0 ]; then terminar; fi
}

escenario_debian() {
  local imagen="$1" salida="$2"
  shift 2
  local -a vars=()
  local v
  for v in "$@"; do vars+=(-e "$v"); done
  mkdir -p "$salida"
  docker run --rm --network none "${vars[@]}" \
    --mount "type=bind,src=$DOCKER_DIR,dst=/despliegue,readonly" \
    --mount "type=bind,src=$PRUEBAS_DIR/stubs,dst=/sustitutos,readonly" \
    --mount "type=bind,src=$PRUEBAS_DIR/escenario_debian.sh,dst=/escenario.sh,readonly" \
    "$imagen" bash /escenario.sh 2>"$salida.err" | tar -C "$salida" -xf - 2>>"$salida.err"
}

asegurar_imagen() {
  docker image inspect "$1" >/dev/null 2>&1 || docker pull -q "$1" >/dev/null 2>&1
}
