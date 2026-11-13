#!/usr/bin/env bash
set -uo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$AQUI/../.." && pwd)"
CIERRE="$REPO/pruebas/tramo-infraestructura-cierre"
HERR="$REPO/pruebas/tramo-infraestructura/.herramientas"
export ANSIBLE_HOME="${ANSIBLE_HOME:-$HERR/ansible}"
RESULTADOS="$(mktemp -d)"
trap 'rm -rf "$RESULTADOS"' EXIT

codigo_anterior=0
if [ "${SOLO_FINAL:-0}" != "1" ]; then
  echo "== pruebas anteriores: tramo-infraestructura-cierre (incluye tramo-infraestructura)"
  bash "$CIERRE/correr.sh" 2>&1 | tee "$RESULTADOS/anteriores.txt"
  codigo_anterior=${PIPESTATUS[0]}
fi

if ! [ -x "$HERR/venv/bin/python" ] || ! [ -x "$HERR/bin/tofu" ]; then
  echo "== preparando herramientas"
  CAMPUSIA_RESULTADOS="$RESULTADOS/descartar.json" bash "$REPO/pruebas/tramo-infraestructura/correr.sh" --collect-only -q >/dev/null 2>&1 || true
fi

export PATH="$HERR/bin:$HERR/venv/bin:$PATH"
export ANSIBLE_COLLECTIONS_PATH="$HERR/colecciones"
export TF_PLUGIN_CACHE_DIR="$HERR/tofu-plugins"
export ANSIBLE_NOCOLOR=1
export ANSIBLE_FORCE_COLOR=0
export PYTHONDONTWRITEBYTECODE=1

echo "== pruebas del tramo: tramo-infraestructura-final"
cd "$AQUI"
CAMPUSIA_RESULTADOS="$RESULTADOS/final.json" python -m pytest "$@"
codigo_final=$?

python - "$RESULTADOS" <<'FIN'
import json, pathlib, re, sys
carpeta = pathlib.Path(sys.argv[1])
total = {"aceptacion": [0, 0], "ataque": [0, 0]}
print("")
print("== resumen")
anteriores = carpeta / "anteriores.txt"
if anteriores.exists():
    texto = anteriores.read_text(errors="replace")
    a = re.findall(r"(?m)^aceptación: (\d+)/(\d+)\s*$", texto)
    t = re.findall(r"(?m)^ataque: (\d+)/(\d+)\s*$", texto)
    if a and t:
        print(f"anteriores: aceptación {a[-1][0]}/{a[-1][1]}, ataque {t[-1][0]}/{t[-1][1]}")
        total["aceptacion"][0] += int(a[-1][0]); total["aceptacion"][1] += int(a[-1][1])
        total["ataque"][0] += int(t[-1][0]); total["ataque"][1] += int(t[-1][1])
    else:
        print("anteriores: sin resultados")
archivo = carpeta / "final.json"
if archivo.exists():
    datos = json.loads(archivo.read_text())
    a, t = datos["aceptacion"], datos["ataque"]
    print(f"tramo-infraestructura-final: aceptación {a['pasan']}/{a['total']}, ataque {t['pasan']}/{t['total']}")
    for tipo in total:
        total[tipo][0] += datos[tipo]["pasan"]
        total[tipo][1] += datos[tipo]["total"]
else:
    print("tramo-infraestructura-final: sin resultados")
print(f"aceptación: {total['aceptacion'][0]}/{total['aceptacion'][1]}")
print(f"ataque: {total['ataque'][0]}/{total['ataque'][1]}")
FIN

if [ "$codigo_anterior" -ne 0 ] || [ "$codigo_final" -ne 0 ]; then
  exit 1
fi
exit 0
