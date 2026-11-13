import os
import pathlib
import re
import shutil
import socket
import subprocess
import tempfile
import time
import uuid

import pytest

AQUI = pathlib.Path(__file__).resolve().parent
REPO = AQUI.parent.parent
INFRA = REPO / "infraestructura"
CLOUDFLARE = INFRA / "cloudflare"
SERVIDOR = INFRA / "servidor"
CONTINUO = REPO / "despliegue" / "continuo"
IMAGEN = "campusia-pruebas-debian13-systemd"
SUFIJO = uuid.uuid4().hex[:8]
CONSERVAR = os.environ.get("CONSERVAR_CONTENEDORES") == "1"

_resultados = {"aceptacion": {"pasan": 0, "total": 0}, "ataque": {"pasan": 0, "total": 0}}


def correr(cmd, cwd=None, env=None, timeout=900, entrada=None):
    entorno = dict(os.environ)
    if env:
        entorno.update(env)
    return subprocess.run(
        cmd,
        cwd=cwd,
        env=entorno,
        input=entrada,
        capture_output=True,
        text=True,
        timeout=timeout,
        shell=isinstance(cmd, str),
    )


def puerto_libre():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Contenedor:
    def __init__(self, nombre):
        self.nombre = nombre

    def ejecutar(self, comando, usuario=None, env=None, timeout=600, entrada=None):
        cmd = ["docker", "exec", "-i"]
        if usuario:
            cmd += ["-u", usuario]
        for k, v in (env or {}).items():
            cmd += ["-e", f"{k}={v}"]
        cmd += [self.nombre, "bash", "-c", comando]
        return correr(cmd, timeout=timeout, entrada=entrada)

    def ok(self, comando, **kw):
        r = self.ejecutar(comando, **kw)
        assert r.returncode == 0, f"falló en el contenedor: {comando}\n{r.stdout}\n{r.stderr}"
        return r.stdout

    def copiar(self, origen, destino):
        r = correr(["docker", "cp", str(origen), f"{self.nombre}:{destino}"])
        assert r.returncode == 0, r.stderr

    def ip(self):
        r = correr(["docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", self.nombre])
        return r.stdout.split()[0]

    def puerta_de_enlace(self):
        r = correr(["docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.Gateway}} {{end}}", self.nombre])
        return r.stdout.split()[0]

    def borrar(self):
        if not CONSERVAR:
            correr(["docker", "rm", "-f", self.nombre])


@pytest.fixture(scope="session")
def imagen_debian():
    r = correr(["docker", "build", "-q", "-t", IMAGEN, str(AQUI / "imagenes" / "debian-systemd")], timeout=1800)
    assert r.returncode == 0, f"no se pudo construir la imagen de Debian 13\n{r.stdout}\n{r.stderr}"
    return IMAGEN


def levantar_contenedor(imagen, nombre):
    correr(["docker", "rm", "-f", nombre])
    r = correr([
        "docker", "run", "-d", "--name", nombre, "--hostname", "campusia-prueba",
        "--cgroupns=private",
        "--cap-add", "NET_ADMIN", "--cap-add", "SYS_ADMIN",
        "--security-opt", "apparmor=unconfined", "--security-opt", "seccomp=unconfined",
        "--tmpfs", "/run", "--tmpfs", "/run/lock",
        imagen,
    ])
    assert r.returncode == 0, r.stderr
    c = Contenedor(nombre)
    limite = time.time() + 90
    estado = ""
    while time.time() < limite:
        estado = c.ejecutar("systemctl is-system-running").stdout.strip()
        if estado in ("running", "degraded"):
            return c
        time.sleep(1)
    raise AssertionError(f"systemd no arrancó en el contenedor: {estado}")


@pytest.fixture(scope="session")
def tofu():
    ruta = shutil.which("tofu")
    assert ruta, "tofu no está en el PATH; correr con pruebas/tramo-infraestructura/correr.sh"
    return ruta


@pytest.fixture(scope="session")
def tmp_sesion():
    d = pathlib.Path(tempfile.mkdtemp(prefix="campusia-infra-"))
    yield d
    if not CONSERVAR:
        shutil.rmtree(d, ignore_errors=True)


def archivos_del_repo():
    r = correr(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=REPO)
    assert r.returncode == 0, r.stderr
    rutas = []
    for p in r.stdout.split("\0"):
        if not p:
            continue
        ruta = REPO / p
        if ruta.is_file():
            rutas.append(ruta)
    return rutas


def esta_ignorado(ruta_relativa):
    return correr(["git", "check-ignore", "-q", "--no-index", ruta_relativa], cwd=REPO).returncode == 0


def bloques_hcl(texto, cabecera):
    bloques = []
    for m in re.finditer(cabecera, texto):
        i = texto.find("{", m.end() - 1)
        if i < 0:
            continue
        nivel = 0
        for j in range(i, len(texto)):
            if texto[j] == "{":
                nivel += 1
            elif texto[j] == "}":
                nivel -= 1
                if nivel == 0:
                    bloques.append((m, texto[i:j + 1]))
                    break
    return bloques


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
    if informe.when == "setup" and informe.failed:
        _resultados[tipo]["total"] += 1
        setattr(item, clave, True)
    elif informe.when == "setup" and informe.skipped:
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
        import json
        pathlib.Path(destino).write_text(json.dumps(_resultados))
