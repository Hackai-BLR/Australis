import base64
import hashlib
import json
import os
import shutil
import subprocess

import pytest

from conftest import CONTINUO, escribir_ejecutable
from test_etapas_por_defecto import correr_etapa, etapas  # noqa: F401  (fixture)

RAIZ = CONTINUO.parent.parent
IMAGENES = RAIZ / "pruebas" / "australis" / "imagenes"
pytestmark = pytest.mark.aceptacion
CONTENIDO_SDK = b"paquete-del-sdk-de-prueba"

PNPM_FALSO = r'''#!/usr/bin/env bash
echo "pnpm $* EN=$(basename "$PWD")" >> "$REGISTRO_PRUEBA/herramientas.log"
if [ "$1" = pack ]; then
  mkdir -p "$3"
  printf '%s' "$CONTENIDO_SDK" > "$3/campusia-sdk-0.3.0.tgz"
fi
exit 0
'''


def integridad(datos):
    return "sha512-" + base64.b64encode(hashlib.sha512(datos).digest()).decode()


def linea_de_bloqueo(valor):
    return f"    resolution: {{integrity: {valor}, tarball: file:vendor/campusia-sdk-0.3.0.tgz}}\n"


def preparar_plantilla(e, integridad_bloqueo):
    escribir_ejecutable(e.fuentes.parent / "falsos" / "pnpm", PNPM_FALSO)
    e.entorno["CONTENIDO_SDK"] = CONTENIDO_SDK.decode()
    (e.fuentes / "sdk").mkdir()
    (e.fuentes / "sdk" / "package.json").write_text("{}")
    (e.fuentes / "plantilla-curso").mkdir()
    (e.fuentes / "plantilla-curso" / "package.json").write_text(
        json.dumps({"dependencies": {"@campusia/sdk": "file:vendor/campusia-sdk-0.3.0.tgz"}})
    )
    (e.fuentes / "plantilla-curso" / "pnpm-lock.yaml").write_text(linea_de_bloqueo(integridad_bloqueo))


@pytest.mark.aceptacion
def test_compilar_falla_si_el_bloqueo_de_la_plantilla_no_coincide_con_el_sdk_empaquetado(etapas):  # noqa: F811
    preparar_plantilla(etapas, integridad(b"otro paquete"))
    r = correr_etapa(etapas, "compilar")
    assert r.returncode != 0
    assert "el bloqueo de plantilla-curso no coincide con el SDK empaquetado" in r.stdout + r.stderr


@pytest.mark.aceptacion
def test_compilar_pasa_si_el_bloqueo_coincide_con_el_sdk_empaquetado(etapas):  # noqa: F811
    preparar_plantilla(etapas, integridad(CONTENIDO_SDK))
    r = correr_etapa(etapas, "compilar")
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    assert (etapas.fuentes / "plantilla-curso" / "vendor" / "campusia-sdk-0.3.0.tgz").is_file()


def test_la_imagen_de_pruebas_empaqueta_con_los_modos_del_repositorio():
    texto = (IMAGENES / "nucleo.Dockerfile").read_text()
    assert "chmod" not in texto, "la imagen de pruebas tiene que empaquetar lo mismo que desplegar.sh"
    assert "pnpm pack" in texto and "verificar-sdk.mjs" in texto


@pytest.mark.skipif(shutil.which("node") is None, reason="falta node")
def test_verificar_sdk_informa_la_diferencia_sin_romper_la_imagen(tmp_path):
    empaque = tmp_path / "empaque"
    empaque.mkdir()
    (empaque / "campusia-sdk-0.3.0.tgz").write_bytes(CONTENIDO_SDK)
    bloqueo = tmp_path / "pnpm-lock.yaml"
    bloqueo.write_text(linea_de_bloqueo(integridad(b"x")))
    cmd = ["node", str(IMAGENES / "verificar-sdk.mjs"), str(empaque), str(bloqueo)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    assert r.returncode == 0, "el build de la imagen no decide: lo decide la prueba del checkpoint B"
    assert json.loads((empaque / "bloqueo-sdk.json").read_text())["coincidia"] is False
    bloqueo.write_text(linea_de_bloqueo(integridad(CONTENIDO_SDK)))
    subprocess.run(cmd, check=True, capture_output=True)
    assert json.loads((empaque / "bloqueo-sdk.json").read_text())["coincidia"] is True


@pytest.mark.skipif(shutil.which("pnpm") is None, reason="falta pnpm")
def test_el_sdk_empaquetado_dos_veces_da_los_mismos_bytes(tmp_path):
    copia = tmp_path / "sdk"
    shutil.copytree(RAIZ / "sdk", copia, ignore=shutil.ignore_patterns("node_modules", "dist", "pruebas", "*.tgz"))
    (copia / "dist").mkdir()
    (copia / "dist" / "index.js").write_text("export {};\n")
    hashes = []
    for i in range(2):
        destino = tmp_path / f"salida{i}"
        subprocess.run(["pnpm", "pack", "--pack-destination", str(destino)], cwd=copia, check=True, capture_output=True, shell=os.name == "nt")
        hashes.append(integridad(next(destino.glob("campusia-sdk-*.tgz")).read_bytes()))
        os.utime(copia / "dist" / "index.js", (1, 1 + i))
    assert hashes[0] == hashes[1]
