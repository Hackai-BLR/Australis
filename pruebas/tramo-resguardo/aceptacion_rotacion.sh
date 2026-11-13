#!/bin/bash
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

requerir_scripts "$RESPALDAR"

T="$(nuevo_temporal)"
R="$T/srv/campusia"
crear_raiz "$R" algebra-1
entorno_respaldo "$R"
cd "$T" || exit 1

listar() { find "$1" -mindepth 1 -maxdepth 1 ! -name '.*' -printf '%f\n' | sort; }

esperado() {
  local ahora="$1" diarios="$2" semanales="$3" dir="$4"
  local -a nombres
  mapfile -t nombres < <(listar "$dir")
  py "$PRUEBAS_DIR/rotacion_esperada.py" "$ahora" "$diarios" "$semanales" "${nombres[@]}" "$ahora" | sort -u
}

seccion "rotación con respaldos simulados de 70 días"
D="$R/respaldos"
mkdir -p "$D"
chmod 700 "$D"
for i in $(seq 1 70); do
  dia="$(date -u -d "2026-11-11 -$i days" +%Y%m%d)"
  if [ $((i % 5)) -eq 0 ]; then continue; fi
  if [ $((i % 2)) -eq 0 ]; then
    mkdir -p "$D/$dia-010000" "$D/$dia-130000"
    printf 'x' > "$D/$dia-010000/respaldo.tar.gz"
    printf 'x' > "$D/$dia-130000/respaldo.tar.gz"
  else
    mkdir -p "$D/$dia-043000"
    printf 'x' > "$D/$dia-043000/respaldo.tar.gz"
  fi
done
mkdir -p "$D/20261111-010000" "$D/20261120-043000" "$D/notas" "$D/20261399-000000" "$D/2026111-043000"
ESPERADO="$(esperado 20261111-043000 7 4 "$D")"
CAMPUSIA_AHORA=20261111-043000 bash "$RESPALDAR" >"$T/rot1.out" 2>&1
comprobar "respaldar.sh sale con 0" iguales "$?" 0
OBTENIDO="$(listar "$D")"
comprobar "conserva exactamente los diarios y semanales esperados" iguales "$OBTENIDO" "$ESPERADO"
if [ "$OBTENIDO" != "$ESPERADO" ]; then diff <(printf '%s\n' "$ESPERADO") <(printf '%s\n' "$OBTENIDO") | sed 's/^/    /'; fi
comprobar "conserva el respaldo nuevo" test -s "$D/20261111-043000/respaldo.tar.gz"
comprobar "borra el de más temprano el mismo día" no_existe "$D/20261111-010000"
comprobar "conserva el único de ayer" existe "$D/20261110-043000"
comprobar "conserva el más reciente de anteayer" existe "$D/20261109-130000"
comprobar "borra el más temprano de anteayer" no_existe "$D/20261109-010000"
comprobar "borra lo de hace 60 días" no_existe "$D/20260912-010000"
comprobar "no toca respaldos con fecha futura" existe "$D/20261120-043000"
comprobar "no toca carpetas que no son respaldos" existe "$D/notas"
comprobar "no toca nombres con fecha inválida" existe "$D/20261399-000000"
comprobar "no toca nombres con formato incompleto" existe "$D/2026111-043000"
comprobar "quedan 7 diarios y semanales anteriores" test "$(grep -c '^2026' <<<"$OBTENIDO")" -ge 9

seccion "respaldos reales durante 30 días seguidos"
D2="$T/respaldos-diarios"
export CAMPUSIA_RESPALDOS="$D2"
fallaron=0
for i in $(seq 0 29); do
  ahora="$(date -u -d "2026-10-01 +$i days" +%Y%m%d)-043000"
  CAMPUSIA_AHORA="$ahora" bash "$RESPALDAR" >/dev/null 2>&1 || fallaron=$((fallaron + 1))
  if [ $((i % 3)) -eq 0 ]; then
    ahora2="$(date -u -d "2026-10-01 +$i days" +%Y%m%d)-180000"
    CAMPUSIA_AHORA="$ahora2" bash "$RESPALDAR" >/dev/null 2>&1 || fallaron=$((fallaron + 1))
  fi
done
comprobar "las 40 corridas salen con 0" iguales "$fallaron" 0
ULTIMO="20261030-043000"
OBTENIDO="$(listar "$D2")"
ESPERADO="$(py "$PRUEBAS_DIR/rotacion_esperada.py" "$ULTIMO" 7 4 $(
  for i in $(seq 0 29); do
    printf '%s-043000 ' "$(date -u -d "2026-10-01 +$i days" +%Y%m%d)"
    if [ $((i % 3)) -eq 0 ]; then printf '%s-180000 ' "$(date -u -d "2026-10-01 +$i days" +%Y%m%d)"; fi
  done
))"
comprobar "la rotación acumulada deja lo esperado" iguales "$OBTENIDO" "$ESPERADO"
if [ "$OBTENIDO" != "$ESPERADO" ]; then diff <(printf '%s\n' "$ESPERADO") <(printf '%s\n' "$OBTENIDO") | sed 's/^/    /'; fi
malos=0
while IFS= read -r n; do
  [ -n "$n" ] || continue
  (cd "$D2/$n" && sha256sum --quiet -c respaldo.tar.gz.sha256 >/dev/null 2>&1) || malos=$((malos + 1))
done <<<"$OBTENIDO"
comprobar "cada respaldo conservado verifica" iguales "$malos" 0
comprobar "no quedan carpetas temporales" iguales "$(find "$D2" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended ! -regex '.*/[0-9]{8}-[0-9]{6}' | head -n 3)" ""

seccion "cantidades configurables"
D3="$T/respaldos-cortos"
export CAMPUSIA_RESPALDOS="$D3"
for i in $(seq 0 20); do
  ahora="$(date -u -d "2026-10-01 +$i days" +%Y%m%d)-043000"
  RESPALDO_DIARIOS=2 RESPALDO_SEMANALES=1 CAMPUSIA_AHORA="$ahora" bash "$RESPALDAR" >/dev/null 2>&1
done
OBTENIDO="$(listar "$D3")"
ESPERADO="$(printf '20261020-043000\n20261021-043000\n')"
comprobar "con 2 diarios y 1 semanal quedan los dos últimos días" iguales "$OBTENIDO" "$ESPERADO"

terminar
