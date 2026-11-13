import os
import shutil
import stat

import pytest

from conftest import CONTINUO, correr, escribir_ejecutable

DOCKER_FALSO = r'''#!/usr/bin/env bash
if [ "$1" = image ]; then exit 0; fi
[ "$1" = run ] || exit 0
shift
red=con-red
fuentes=""
cache=""
memoria=""
entorno=()
while [ $# -gt 0 ]; do
  case "$1" in
    --network) red=sin-red; shift 2 ;;
    --memory) memoria="$2"; shift 2 ;;
    --cpus|--pids-limit|-w) shift 2 ;;
    -v)
      case "$2" in
        *:/fuentes) fuentes="${2%:/fuentes}" ;;
        *:/cache) cache="${2%:/cache}" ;;
      esac
      shift 2 ;;
    -e) entorno+=("$2"); shift 2 ;;
    --rm) shift ;;
    *) break ;;
  esac
done
shift
echo "$red $memoria" >> "$REGISTRO_PRUEBA/docker.log"
cd "$fuentes"
for e in "${entorno[@]}"; do export "${e%%=*}=${e#*=}"; done
export CARGO_TARGET_DIR="$cache/target" CARGO_TARGET_DIR_AUSTRALIS="$cache/target-australis"
exec "$@"
'''

CARGO_FALSO = r'''#!/usr/bin/env bash
echo "cargo $* TARGET=${CARGO_TARGET_DIR##*/}" >> "$REGISTRO_PRUEBA/herramientas.log"
[ ! -e "$REGISTRO_PRUEBA/fallar-cargo" ] || exit 1
if [ "$1" = build ]; then
  while [ $# -gt 0 ]; do
    if [ "$1" = --bin ]; then mkdir -p "$CARGO_TARGET_DIR/release"; echo "ELF $2" > "$CARGO_TARGET_DIR/release/$2"; fi
    shift
  done
fi
exit 0
'''

NPM_FALSO = r'''#!/usr/bin/env bash
echo "npm $* EN=$(basename "$PWD")" >> "$REGISTRO_PRUEBA/herramientas.log"
if [ "$1" = test ] && [ -e "$REGISTRO_PRUEBA/fallar-npm-test" ]; then exit 1; fi
if [ "$1" = run ] && [ "$2" = build ]; then mkdir -p dist; echo "<!doctype html>" > dist/index.html; fi
exit 0
'''


@pytest.fixture()
def etapas(tmp_path):
    e = type("Etapas", (), {})()
    e.registro = tmp_path / "registro"
    e.registro.mkdir()
    e.fuentes = tmp_path / "fuentes"
    e.cache = tmp_path / "cache"
    falsos = tmp_path / "falsos"
    escribir_ejecutable(falsos / "docker", DOCKER_FALSO)
    escribir_ejecutable(falsos / "cargo", CARGO_FALSO)
    escribir_ejecutable(falsos / "npm", NPM_FALSO)
    (e.fuentes / "nucleo").mkdir(parents=True)
    (e.fuentes / "nucleo" / "Cargo.toml").write_text("")
    (e.fuentes / "backend").mkdir()
    (e.fuentes / "backend" / "Cargo.toml").write_text("")
    (e.fuentes / "frontend").mkdir()
    (e.fuentes / "frontend" / "package-lock.json").write_text("{}")
    e.entorno = {
        "PATH": f"{falsos}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "REGISTRO_PRUEBA": str(e.registro),
        "COMMIT": "a" * 40,
        "FUENTES": str(e.fuentes),
        "CACHE_DIR": str(e.cache),
        "DESPLIEGUE_DIR": str(tmp_path / "despliegue"),
        "DESPLIEGUE_MEMORIA": "3g",
    }
    return e


def correr_etapa(e, nombre):
    return correr(["bash", str(CONTINUO / "desplegar.sh"), "--etapa", nombre], env=e.entorno, timeout=120)


def herramientas(e):
    ruta = e.registro / "herramientas.log"
    return ruta.read_text().splitlines() if ruta.exists() else []


@pytest.mark.aceptacion
def test_la_etapa_de_pruebas_corre_las_pruebas_de_australis_sin_red(etapas):
    r = correr_etapa(etapas, "pruebas")
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    log = herramientas(etapas)
    assert "cargo test --offline --locked --manifest-path backend/Cargo.toml TARGET=target-australis" in log
    assert "cargo test --offline --locked --manifest-path nucleo/Cargo.toml TARGET=target" in log
    assert "npm run lint EN=frontend" in log
    assert "npm run build EN=frontend" in log
    assert "npm test EN=frontend" in log
    assert any(l.startswith("cargo fetch --locked --manifest-path backend/Cargo.toml") for l in log)
    assert any(l.startswith("npm ci") and l.endswith("EN=frontend") for l in log)
    redes = (etapas.registro / "docker.log").read_text().splitlines()
    assert redes == ["con-red 3g", "sin-red 3g"], "las dependencias bajan con red y las pruebas corren sin red"


@pytest.mark.aceptacion
def test_la_etapa_de_pruebas_falla_si_fallan_las_pruebas_del_frontend(etapas):
    (etapas.registro / "fallar-npm-test").write_text("")
    r = correr_etapa(etapas, "pruebas")
    assert r.returncode != 0


@pytest.mark.aceptacion
def test_la_etapa_de_pruebas_falla_si_fallan_las_pruebas_del_backend(etapas):
    (etapas.registro / "fallar-cargo").write_text("")
    r = correr_etapa(etapas, "pruebas")
    assert r.returncode != 0


@pytest.mark.aceptacion
def test_la_etapa_de_compilar_deja_el_binario_y_el_frontend_de_australis(etapas):
    r = correr_etapa(etapas, "compilar")
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    binario = etapas.fuentes / "compilado" / "bin" / "australis-server"
    assert binario.read_text().strip() == "ELF australis-server"
    assert os.access(binario, os.X_OK)
    assert (etapas.fuentes / "compilado" / "bin" / "campusia-nucleo").is_file()
    assert (etapas.fuentes / "frontend" / "dist" / "index.html").is_file()
    assert "cargo build --offline --locked --release --manifest-path backend/Cargo.toml --bin australis-server TARGET=target-australis" in herramientas(etapas)
