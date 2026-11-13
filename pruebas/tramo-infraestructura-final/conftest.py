import importlib.util
import json
import os
import pathlib
import shutil
import tempfile
import uuid

import pytest

AQUI = pathlib.Path(__file__).resolve().parent
REPO = AQUI.parent.parent
CIERRE = REPO / "pruebas" / "tramo-infraestructura-cierre"
DESPLIEGUE = REPO / "despliegue"
INFRA = REPO / "infraestructura"
ARCHIVOS = AQUI / "archivos"
SUFIJO = uuid.uuid4().hex[:8]
CONSERVAR = os.environ.get("CONSERVAR_CONTENEDORES") == "1"


def _cargar_cierre():
    spec = importlib.util.spec_from_file_location("conftest_cierre_final", CIERRE / "conftest.py")
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


cierre = _cargar_cierre()

correr = cierre.correr
Contenedor = cierre.Contenedor
construir_imagen = cierre.construir_imagen
levantar_contenedor = cierre.levantar_contenedor
preparar_envoltorios = cierre.preparar_envoltorios
leer_llamadas = cierre.leer_llamadas
puerto_libre = cierre.puerto_libre

tmp_sesion = cierre.tmp_sesion
instantanea = cierre.instantanea
origen_git = cierre.origen_git
artefactos = cierre.artefactos
artefactos_listos = cierre.artefactos_listos

_resultados = {"aceptacion": {"pasan": 0, "total": 0}, "ataque": {"pasan": 0, "total": 0}}


def pytest_collection_modifyitems(config, items):
    for item in items:
        marcas = {m.name for m in item.iter_markers()}
        if not marcas & {"aceptacion", "ataque"}:
            raise pytest.UsageError(f"la prueba {item.nodeid} no tiene marca aceptacion ni ataque")


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    resultado = yield
    informe = resultado.get_result()
    marcas = {m.name for m in item.iter_markers()}
    tipo = "ataque" if "ataque" in marcas else "aceptacion"
    clave = f"_contada_{tipo}"
    if informe.when == "setup" and (informe.failed or informe.skipped):
        _resultados[tipo]["total"] += 1
        setattr(item, clave, True)
    elif informe.when == "call" and not getattr(item, clave, False):
        _resultados[tipo]["total"] += 1
        if informe.passed:
            _resultados[tipo]["pasan"] += 1
        setattr(item, clave, True)


def pytest_terminal_summary(terminalreporter):
    a = _resultados["aceptacion"]
    t = _resultados["ataque"]
    terminalreporter.write_line("")
    terminalreporter.write_line(f"aceptación: {a['pasan']}/{a['total']}")
    terminalreporter.write_line(f"ataque: {t['pasan']}/{t['total']}")
    destino = os.environ.get("CAMPUSIA_RESULTADOS")
    if destino:
        pathlib.Path(destino).write_text(json.dumps(_resultados))


@pytest.fixture(scope="module")
def tmp_modulo():
    d = pathlib.Path(tempfile.mkdtemp(prefix="campusia-final-"))
    yield d
    if not CONSERVAR:
        shutil.rmtree(d, ignore_errors=True)


def certificado_de_prueba(carpeta):
    carpeta.mkdir(parents=True, exist_ok=True)
    r = correr([
        "openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
        "-keyout", str(carpeta / "origen.key"), "-out", str(carpeta / "origen.pem"), "-days", "30",
        "-subj", "/CN=campusia.tech", "-addext", "subjectAltName=DNS:campusia.tech,DNS:*.campusia.tech",
    ])
    assert r.returncode == 0, r.stderr
    os.chmod(carpeta / "origen.key", 0o644)
    return carpeta / "origen.key", carpeta / "origen.pem"
