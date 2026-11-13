import json
import os
import pathlib
import shutil
import stat
import subprocess
import tempfile

import pytest

AQUI = pathlib.Path(__file__).resolve().parent
REPO = AQUI.parent.parent
DESPLIEGUE = REPO / "despliegue"
CONTINUO = DESPLIEGUE / "continuo"
SERVIDOR = REPO / "infraestructura" / "servidor"

_resultados = {"aceptacion": {"pasan": 0, "total": 0}, "ataque": {"pasan": 0, "total": 0}}


def correr(cmd, cwd=None, env=None, timeout=300, entrada=None):
    entorno = dict(os.environ)
    if env:
        entorno.update(env)
    return subprocess.run(
        cmd, cwd=cwd, env=entorno, input=entrada, capture_output=True, text=True,
        timeout=timeout, shell=isinstance(cmd, str),
    )


def escribir_ejecutable(ruta, contenido):
    ruta = pathlib.Path(ruta)
    ruta.parent.mkdir(parents=True, exist_ok=True)
    ruta.write_text(contenido)
    ruta.chmod(ruta.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return ruta


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
    d = pathlib.Path(tempfile.mkdtemp(prefix="campusia-australis-"))
    yield d
    shutil.rmtree(d, ignore_errors=True)
