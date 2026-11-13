import ipaddress
import json
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
LEVANTAR = INFRA / "levantar.sh"
CONTINUO = REPO / "despliegue" / "continuo"
DESPLIEGUE = REPO / "despliegue"
SUFIJO = uuid.uuid4().hex[:8]
CONSERVAR = os.environ.get("CONSERVAR_CONTENEDORES") == "1"
HANDOFF_PLAN = "handoffs/261110_0400_plan-implementacion-plataforma.md"
REDES_DOCUMENTACION = [ipaddress.ip_network(n) for n in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "2001:db8::/32")]
RESOLVEDORES_PUBLICOS = {ipaddress.ip_address(".".join(p)) for p in (["1"] * 4, ["1", "0", "0", "1"], ["8"] * 4, ["8", "8", "4", "4"])}
PATRON_V4 = re.compile(r"(?<![\w.])(\d{1,3}(?:\.\d{1,3}){3})(?:/(\d{1,2}))?(?![\w.]*\d)")
PATRON_V6 = re.compile(r"(?<![\w:.])([0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7})(?:/(\d{1,3}))?(?![\w:])")
PROGRAMAS_REGISTRADOS = ["ssh", "scp", "ansible-playbook", "ansible-galaxy"]

_resultados = {"aceptacion": {"pasan": 0, "total": 0}, "ataque": {"pasan": 0, "total": 0}}


def correr(cmd, cwd=None, env=None, timeout=900, entrada=None, entorno_base=None, combinar=False):
    entorno = dict(os.environ if entorno_base is None else entorno_base)
    if env:
        entorno.update(env)
    return subprocess.run(
        cmd,
        cwd=cwd,
        env=entorno,
        input=entrada,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT if combinar else subprocess.PIPE,
        text=True,
        timeout=timeout,
        shell=isinstance(cmd, str),
    )


def puerto_libre(direccion="127.0.0.1"):
    with socket.socket() as s:
        s.bind((direccion, 0))
        return s.getsockname()[1]


def ip_publica_no_documentada(texto, prefijo):
    try:
        ip = ipaddress.ip_address(texto)
    except ValueError:
        return False
    if not ip.is_global or any(ip in red for red in REDES_DOCUMENTACION) or (prefijo is None and ip in RESOLVEDORES_PUBLICOS):
        return False
    if prefijo is not None and int(prefijo) < ip.max_prefixlen:
        try:
            ipaddress.ip_network(f"{texto}/{prefijo}", strict=True)
            return False
        except ValueError:
            return True
    return True


def ips_publicas_en_texto(texto):
    hallazgos = []
    for numero, linea in enumerate(texto.splitlines(), 1):
        for patron in (PATRON_V4, PATRON_V6):
            for m in patron.finditer(linea):
                if ip_publica_no_documentada(m.group(1), m.group(2)):
                    hallazgos.append((numero, m.group(0)))
    return hallazgos


def archivos_del_repo():
    r = correr(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=REPO)
    assert r.returncode == 0, r.stderr
    return [p for p in r.stdout.split("\0") if p and (REPO / p).is_file()]


def esta_ignorado(ruta_relativa):
    return correr(["git", "check-ignore", "-q", "--no-index", ruta_relativa], cwd=REPO).returncode == 0


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

    def borrar(self):
        if not CONSERVAR:
            correr(["docker", "rm", "-f", self.nombre])


def construir_imagen(carpeta, etiqueta):
    r = correr(["docker", "build", "-q", "-t", etiqueta, str(AQUI / "imagenes" / carpeta)], timeout=2400)
    assert r.returncode == 0, f"no se pudo construir la imagen {etiqueta}\n{r.stdout}\n{r.stderr}"
    return etiqueta


def levantar_contenedor(imagen, nombre):
    correr(["docker", "rm", "-f", nombre])
    r = correr([
        "docker", "run", "-d", "--name", nombre, "--hostname", "campusia-prueba",
        "--cgroupns=private", "--privileged",
        "-v", "/lib/modules:/lib/modules:ro",
        "--cap-add", "NET_ADMIN", "--cap-add", "SYS_ADMIN",
        "--security-opt", "apparmor=unconfined", "--security-opt", "seccomp=unconfined",
        "--tmpfs", "/run", "--tmpfs", "/run/lock",
        imagen,
    ])
    assert r.returncode == 0, r.stderr
    c = Contenedor(nombre)
    limite = time.time() + 120
    estado = ""
    while time.time() < limite:
        estado = c.ejecutar("systemctl is-system-running").stdout.strip()
        if estado in ("running", "degraded"):
            return c
        time.sleep(1)
    raise AssertionError(f"systemd no arrancó en el contenedor: {estado}")


def puerta_de_enlace_docker():
    r = correr(["docker", "network", "inspect", "bridge", "-f", "{{(index .IPAM.Config 0).Gateway}}"])
    assert r.returncode == 0 and r.stdout.strip(), r.stderr
    return r.stdout.strip()


def herramienta(nombre):
    ruta = shutil.which(nombre)
    assert ruta, f"{nombre} no está en el PATH; correr con pruebas/tramo-infraestructura-cierre/correr.sh"
    return ruta


ENVOLTORIO = r'''#!/usr/bin/env python3
import json, os, sys
nombre = os.path.basename(sys.argv[0])
propia = os.path.dirname(os.path.abspath(sys.argv[0]))
with open(os.environ["LLAMADAS_REGISTRO"], "a") as f:
    f.write(json.dumps({"programa": nombre, "argv": sys.argv[1:], "cwd": os.getcwd()}) + "\n")
if os.environ.get("LLAMADAS_FALLAR") == "1":
    sys.exit(97)
for d in os.environ.get("PATH", "").split(os.pathsep):
    if not d or os.path.abspath(d) == propia:
        continue
    real = os.path.join(d, nombre)
    if os.path.isfile(real) and os.access(real, os.X_OK):
        os.execv(real, [real] + sys.argv[1:])
sys.exit(127)
'''

TOFU_FALSO = r'''#!/usr/bin/env python3
import json, os, sys
with open(os.environ["LLAMADAS_REGISTRO"], "a") as f:
    f.write(json.dumps({
        "programa": "tofu",
        "argv": sys.argv[1:],
        "cwd": os.getcwd(),
        "entorno": {k: v for k, v in os.environ.items() if k.startswith("TF_VAR_")},
    }) + "\n")
if os.environ.get("LLAMADAS_FALLAR") == "1":
    sys.exit(97)
sys.exit(0)
'''


def preparar_envoltorios(carpeta):
    carpeta.mkdir(parents=True, exist_ok=True)
    for nombre in PROGRAMAS_REGISTRADOS:
        p = carpeta / nombre
        p.write_text(ENVOLTORIO)
        p.chmod(0o755)
    p = carpeta / "tofu"
    p.write_text(TOFU_FALSO)
    p.chmod(0o755)
    return carpeta


def leer_llamadas(registro):
    registro = pathlib.Path(registro)
    if not registro.exists():
        return []
    return [json.loads(l) for l in registro.read_text().splitlines() if l.strip()]


@pytest.fixture(scope="session")
def tmp_sesion():
    d = pathlib.Path(tempfile.mkdtemp(prefix="campusia-cierre-"))
    yield d
    if not CONSERVAR:
        shutil.rmtree(d, ignore_errors=True)


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


class Instantanea:
    pass


@pytest.fixture(scope="session")
def instantanea(tmp_sesion):
    i = Instantanea()
    trabajo = tmp_sesion / "instantanea"
    trabajo.mkdir()
    for relativa in archivos_del_repo():
        origen = REPO / relativa
        destino = trabajo / relativa
        destino.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(origen, destino, follow_symlinks=False)
    git = ["git", "-c", "user.email=pruebas@campusia.test", "-c", "user.name=pruebas", "-c", "init.defaultBranch=main"]
    for paso in (["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "instantanea de prueba"]):
        r = correr(git + paso, cwd=trabajo, timeout=600)
        assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    i.commit = correr(["git", "rev-parse", "HEAD"], cwd=trabajo).stdout.strip()
    i.base = tmp_sesion / "origen"
    i.base.mkdir()
    i.bare = i.base / "origen.git"
    r = correr(["git", "clone", "-q", "--bare", str(trabajo), str(i.bare)], timeout=600)
    assert r.returncode == 0, r.stderr
    correr(["git", "--git-dir", str(i.bare), "config", "daemon.uploadpack", "true"])
    i.trabajo = trabajo
    return i


@pytest.fixture(scope="session")
def origen_git(instantanea):
    puerta = puerta_de_enlace_docker()
    puerto = puerto_libre(puerta)
    proceso = subprocess.Popen(
        ["git", "daemon", "--reuseaddr", "--export-all", f"--base-path={instantanea.base}",
         f"--listen={puerta}", f"--port={puerto}", str(instantanea.base)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    url = f"git://{puerta}:{puerto}/origen.git"
    limite = time.time() + 20
    while time.time() < limite:
        if correr(["git", "ls-remote", url], timeout=10).returncode == 0:
            break
        time.sleep(0.5)
    else:
        proceso.terminate()
        raise AssertionError("git daemon no respondió")
    yield url
    proceso.terminate()
    proceso.wait(timeout=10)


class Artefactos:
    pass


@pytest.fixture(scope="session")
def artefactos(instantanea, tmp_sesion):
    a = Artefactos()
    fuentes = tmp_sesion / "fuentes" / instantanea.commit
    fuentes.mkdir(parents=True)
    r = correr(f"git --git-dir={instantanea.bare} archive {instantanea.commit} | tar -x -C {fuentes}", timeout=600)
    assert r.returncode == 0, r.stderr
    cache = pathlib.Path(os.environ.get("XDG_CACHE_HOME", pathlib.Path.home() / ".cache")) / "campusia-pruebas-cierre"
    cache.mkdir(parents=True, exist_ok=True)
    imagen = "campusia-pruebas-cierre-compilacion"
    env = {
        "COMMIT": instantanea.commit,
        "FUENTES": str(fuentes),
        "DESPLIEGUE_IMAGEN": imagen,
        "CACHE_DIR": str(cache),
        "DESPLIEGUE_CPUS": str(os.cpu_count() or 2),
        "DESPLIEGUE_MEMORIA": "4g",
    }
    guion = fuentes / "despliegue" / "continuo" / "desplegar.sh"
    assert guion.is_file(), "falta despliegue/continuo/desplegar.sh"
    a.compilacion = correr(["bash", str(guion), "--etapa", "compilar"], cwd=fuentes, env=env, timeout=5400, combinar=True)
    etiqueta = f"{imagen}:{instantanea.commit}"
    correr(["docker", "run", "--rm", "-v", f"{fuentes}:/f", "-v", f"{cache}:/c", etiqueta,
            "chown", "-R", f"{os.getuid()}:{os.getgid()}", "/f", "/c"], timeout=1200)
    a.fuentes = fuentes
    a.binario = fuentes / "compilado" / "bin" / "campusia-nucleo"
    a.interfaz = fuentes / "interfaz" / "dist"
    yield a
    correr(["docker", "rmi", "-f", etiqueta], timeout=300)


@pytest.fixture(scope="session")
def artefactos_listos(artefactos):
    r = artefactos.compilacion
    assert r.returncode == 0, f"la etapa de compilación por defecto falló\n{r.stdout[-6000:]}"
    assert artefactos.binario.is_file(), "la compilación no dejó compilado/bin/campusia-nucleo"
    assert (artefactos.interfaz / "index.html").is_file(), "la compilación no dejó interfaz/dist/index.html"
    return artefactos
