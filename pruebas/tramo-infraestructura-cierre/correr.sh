#!/usr/bin/env bash
set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$AQUI/../.." && pwd)"
ANTERIOR="$REPO/pruebas/tramo-infraestructura"
HERR="$ANTERIOR/.herramientas"
export ANSIBLE_HOME="${ANSIBLE_HOME:-$HERR/ansible}"
RESULTADOS="$(mktemp -d)"
trap 'rm -rf "$RESULTADOS"' EXIT

codigo_anterior=0
if [ "${SOLO_CIERRE:-0}" != "1" ]; then
  echo "== pruebas de la fase anterior: tramo-infraestructura"
  CAMPUSIA_RESULTADOS="$RESULTADOS/tramo-infraestructura.json" bash "$ANTERIOR/correr.sh"
  codigo_anterior=$?
fi

if ! [ -x "$HERR/venv/bin/python" ] || ! [ -x "$HERR/bin/tofu" ]; then
  echo "== preparando herramientas"
  CAMPUSIA_RESULTADOS="$RESULTADOS/descartar.json" bash "$ANTERIOR/correr.sh" --collect-only -q >/dev/null 2>&1 || true
fi

export PATH="$HERR/bin:$HERR/venv/bin:$PATH"
export ANSIBLE_COLLECTIONS_PATH="$HERR/colecciones"
export TF_PLUGIN_CACHE_DIR="$HERR/tofu-plugins"
export ANSIBLE_NOCOLOR=1
export ANSIBLE_FORCE_COLOR=0
export PYTHONDONTWRITEBYTECODE=1

echo "== pruebas del cierre: tramo-infraestructura-cierre"
cd "$AQUI"
CAMPUSIA_RESULTADOS="$RESULTADOS/tramo-infraestructura-cierre.json" python -m pytest "$@"
codigo_cierre=$?

python - "$RESULTADOS" <<'FIN'
import json, pathlib, sys
carpeta = pathlib.Path(sys.argv[1])
total = {"aceptacion": [0, 0], "ataque": [0, 0]}
print("")
print("== resumen")
for nombre in ("tramo-infraestructura", "tramo-infraestructura-cierre"):
    archivo = carpeta / f"{nombre}.json"
    if not archivo.exists():
        print(f"{nombre}: sin resultados")
        continue
    datos = json.loads(archivo.read_text())
    a, t = datos["aceptacion"], datos["ataque"]
    print(f"{nombre}: aceptación {a['pasan']}/{a['total']}, ataque {t['pasan']}/{t['total']}")
    for tipo in total:
        total[tipo][0] += datos[tipo]["pasan"]
        total[tipo][1] += datos[tipo]["total"]
print(f"aceptación: {total['aceptacion'][0]}/{total['aceptacion'][1]}")
print(f"ataque: {total['ataque'][0]}/{total['ataque'][1]}")
FIN

if [ "$codigo_anterior" -ne 0 ] || [ "$codigo_cierre" -ne 0 ]; then
  exit 1
fi
exit 0
