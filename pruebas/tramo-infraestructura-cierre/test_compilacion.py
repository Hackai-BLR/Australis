import json
import os
import tarfile

import pytest


@pytest.mark.aceptacion
def test_la_compilacion_por_defecto_produce_binario_e_interfaz(artefactos_listos):
    binario = artefactos_listos.binario
    assert binario.read_bytes()[:4] == b"\x7fELF", "el binario del núcleo no es un ejecutable ELF"
    assert os.access(binario, os.X_OK)
    assert (artefactos_listos.interfaz / "index.html").stat().st_size > 0


@pytest.mark.aceptacion
def test_la_interfaz_compilada_no_tiene_enlaces(artefactos_listos):
    for raiz, carpetas, archivos in os.walk(artefactos_listos.interfaz):
        for nombre in carpetas + archivos:
            assert not os.path.islink(os.path.join(raiz, nombre)), f"enlace en la interfaz compilada: {nombre}"


@pytest.mark.aceptacion
def test_la_compilacion_empaqueta_el_sdk_en_la_plantilla(artefactos_listos):
    fuentes = artefactos_listos.fuentes
    dependencia = json.loads((fuentes / "plantilla-curso" / "package.json").read_text())["dependencies"]["@campusia/sdk"]
    assert dependencia.startswith("file:")
    tgz = fuentes / "plantilla-curso" / dependencia[len("file:"):]
    assert tgz.is_file(), f"la compilación no dejó {tgz.relative_to(fuentes)}"
    assert not tgz.is_symlink()
    with tarfile.open(tgz) as t:
        nombres = t.getnames()
    assert "package/package.json" in nombres
    assert "package/dist/index.js" in nombres and "package/dist/hono.js" in nombres
    assert (fuentes / "sdk" / "dist" / "index.js").is_file()
