import configparser
import json
import re
import subprocess
import time

import pytest

from conftest import CONTINUO, SUFIJO, levantar_contenedor

RAIZ = "/srv/campusia"
DIR = f"{RAIZ}/despliegue"
ORIGEN = "/srv/origen/campusia.git"
TRABAJO = "/srv/origen/trabajo"
SCRIPTS = "/opt/continuo"
FALSOS = "/opt/falsos"
ESPACIO = f"{RAIZ}/espacio"
ENTORNO = {
    "PATH": f"{FALSOS}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "CAMPUSIA_RAIZ": RAIZ,
    "DESPLIEGUE_ORIGEN": ORIGEN,
    "DESPLIEGUE_PRUEBAS": "bash ci/pruebas.sh",
    "DESPLIEGUE_COMPILAR": "bash ci/compilar.sh",
    "DESPLIEGUE_INSTALAR": "bash despliegue/instalar.sh",
    "DESPLIEGUE_SALUD": 'test -f "$CAMPUSIA_RAIZ/instalado/version" && test ! -e "$CAMPUSIA_RAIZ/instalado/roto"',
    "DESPLIEGUE_SALUD_ESPERA": "3",
}

PROYECTO = r'''
set -euo pipefail
mkdir -p despliegue ci
cat > despliegue/instalar.sh <<'FIN'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$CAMPUSIA_RAIZ/instalado"
echo "$COMMIT" >> "$CAMPUSIA_RAIZ/instalado/historial"
if [ -e FALLAR_INSTALACION ]; then exit 1; fi
if [ -e ROMPER_SALUD ]; then touch "$CAMPUSIA_RAIZ/instalado/roto"; else rm -f "$CAMPUSIA_RAIZ/instalado/roto"; fi
test -f compilado.txt
echo "$COMMIT" > "$CAMPUSIA_RAIZ/instalado/version"
FIN
cat > ci/pruebas.sh <<'FIN'
#!/usr/bin/env bash
if [ -e FALLAR_PRUEBAS ]; then echo "pruebas fallidas"; exit 1; fi
echo "$COMMIT" >> "$CAMPUSIA_RAIZ/probados"
FIN
cat > ci/compilar.sh <<'FIN'
#!/usr/bin/env bash
if [ -e FALLAR_COMPILACION ]; then exit 1; fi
echo compilado > compilado.txt
FIN
cat > despliegue/construir-espacio.sh <<'FIN'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$CAMPUSIA_RAIZ/espacio"
echo "$COMMIT $*" >> "$CAMPUSIA_RAIZ/espacio/construcciones"
if [ -e "$FUENTES/FALLAR_ESPACIO" ]; then exit 1; fi
echo "$COMMIT" > "$CAMPUSIA_RAIZ/espacio/imagen"
FIN
mkdir -p despliegue/espacio-trabajo plantilla-curso sdk
echo "FROM scratch" > despliegue/espacio-trabajo/Containerfile
echo "{}" > plantilla-curso/package.json
echo "{}" > sdk/package.json
echo "compilado.txt" > .gitignore
'''

DOCKER_FALSO = r'''#!/usr/bin/env bash
echo "$*" >> "$CAMPUSIA_RAIZ/espacio/docker"
if [ "$1 $2" = "image inspect" ]; then
  test -f "$CAMPUSIA_RAIZ/espacio/imagen"
  exit $?
fi
exit 0
'''


class Escenario:
    pass


@pytest.fixture(scope="module")
def esc(imagen_debian):
    assert (CONTINUO / "desplegar.sh").is_file(), "falta despliegue/continuo/desplegar.sh"
    c = levantar_contenedor(imagen_debian, f"campusia-continuo-{SUFIJO}")
    e = Escenario()
    e.c = c
    try:
        c.ok(f"useradd -r -m -d {RAIZ} -s /bin/bash campusia && mkdir -p /srv/origen && chown campusia:campusia /srv/origen")
        c.copiar(CONTINUO, SCRIPTS)
        c.ok(f"chmod -R a+rX {SCRIPTS}")
        c.ok(f"mkdir -p {FALSOS} && cat > {FALSOS}/docker && chmod 755 {FALSOS}/docker", entrada=DOCKER_FALSO)
        c.ok(f"mkdir -p {ESPACIO}", usuario="campusia")
        c.ok(
            f"git init -q --bare -b main {ORIGEN} && git init -q -b main {TRABAJO} && cd {TRABAJO} "
            "&& git config user.email prueba@ejemplo.com && git config user.name prueba "
            f"&& git remote add origin {ORIGEN}",
            usuario="campusia",
        )
        c.ok(f"cd {TRABAJO} && bash -s", usuario="campusia", entrada=PROYECTO)
        yield e
    finally:
        c.borrar()


def commit(e, mensaje, marcas=(), tocar=()):
    guion = f"cd {TRABAJO} && rm -f FALLAR_PRUEBAS FALLAR_COMPILACION FALLAR_INSTALACION ROMPER_SALUD FALLAR_ESPACIO && "
    for m in marcas:
        guion += f"touch {m} && "
    for ruta in tocar:
        guion += f"echo '{mensaje}' >> {ruta} && "
    guion += f"echo '{mensaje}' >> cambios.txt && git add -A && git commit -q -m '{mensaje}' && git push -q origin main && git rev-parse HEAD"
    return e.c.ok(guion, usuario="campusia").strip().splitlines()[-1]


def desplegar(e, extra=None, argumentos=""):
    env = dict(ENTORNO)
    if extra:
        env.update(extra)
    return e.c.ejecutar(f"bash {SCRIPTS}/desplegar.sh {argumentos}", usuario="campusia", env=env, timeout=600)


def registro(e):
    r = e.c.ejecutar(f"cat {DIR}/registro.log", usuario="campusia")
    if r.returncode != 0:
        return []
    return [json.loads(l) for l in r.stdout.splitlines() if l.strip()]


def leer(e, ruta):
    r = e.c.ejecutar(f"cat {ruta}")
    return r.stdout.strip() if r.returncode == 0 else None


def construcciones(e):
    texto = leer(e, f"{ESPACIO}/construcciones") or ""
    return [l.split()[0] for l in texto.splitlines() if l.strip()]


def unidad(nombre):
    p = configparser.ConfigParser(strict=False, interpolation=None)
    p.optionxform = str
    p.read(CONTINUO / "systemd" / nombre)
    return p


@pytest.mark.aceptacion
def test_preparar_continuo_instala_unidades(esc):
    c = esc.c
    r = c.ejecutar(f"bash {SCRIPTS}/preparar-continuo.sh", env={"CAMPUSIA_RAIZ": RAIZ, "DESPLIEGUE_ORIGEN": ORIGEN}, timeout=300)
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    assert r.stdout.strip().splitlines()[-1] in ("CAMBIOS=1", "CAMBIOS=0")
    for d in ("fuentes", "cache", "bin"):
        assert c.ok(f"stat -c %U {DIR}/{d}").strip() == "campusia"
    c.ok(f"test -x {DIR}/bin/desplegar.sh && test -f {DIR}/bin/receptor.py && test -x {DIR}/bin/limpiar.sh && test -x {DIR}/bin/registro.sh")
    usuario = f"{RAIZ}/.config/systemd/user"
    for u in ("campusia-despliegue.service", "campusia-despliegue.timer", "campusia-receptor.service", "campusia-limpieza.service", "campusia-limpieza.timer"):
        c.ok(f"test -f {usuario}/{u}")
    c.ok(f"test -L {usuario}/timers.target.wants/campusia-despliegue.timer")
    c.ok(f"test -L {usuario}/timers.target.wants/campusia-limpieza.timer")
    c.ok(f"test -L {usuario}/default.target.wants/campusia-receptor.service")
    r = c.ejecutar(f"bash {SCRIPTS}/preparar-continuo.sh", env={"CAMPUSIA_RAIZ": RAIZ, "DESPLIEGUE_ORIGEN": ORIGEN}, timeout=300)
    assert r.returncode == 0
    assert r.stdout.strip().splitlines()[-1] == "CAMBIOS=0", "preparar-continuo.sh no es idempotente"


@pytest.mark.aceptacion
def test_primer_despliegue(esc):
    a = commit(esc, "primera version")
    esc.a = a
    r = desplegar(esc)
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    assert leer(esc, f"{RAIZ}/instalado/version") == a
    assert leer(esc, f"{DIR}/actual") == a
    esc.c.ok(f"test -f {DIR}/fuentes/{a}/ci/pruebas.sh")
    assert a in (leer(esc, f"{RAIZ}/probados") or "")
    entradas = registro(esc)
    assert len(entradas) == 1
    ultima = entradas[-1]
    assert ultima["commit"] == a and ultima["resultado"] == "exito" and ultima["anterior"] is None
    assert isinstance(ultima["duracion_s"], (int, float)) and ultima["duracion_s"] >= 0
    assert re.match(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d", ultima["fecha"])
    assert construcciones(esc) == [a], "el primer despliegue tiene que construir la imagen del espacio"
    linea = leer(esc, f"{ESPACIO}/construcciones")
    assert "--etiqueta campusia-espacio:1" in linea
    assert f"--plantilla {DIR}/fuentes/{a}/plantilla-curso" in linea
    assert f"--espacio {DIR}/fuentes/{a}/despliegue/espacio-trabajo" in linea


@pytest.mark.aceptacion
def test_sin_cambios_no_hace_nada(esc):
    antes = registro(esc)
    r = desplegar(esc)
    assert r.returncode == 0, r.stderr
    assert registro(esc) == antes
    assert leer(esc, f"{RAIZ}/instalado/historial").splitlines().count(esc.a) == 1


@pytest.mark.aceptacion
def test_segundo_despliegue(esc):
    b = commit(esc, "segunda version")
    esc.b = b
    r = desplegar(esc)
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    assert leer(esc, f"{RAIZ}/instalado/version") == b
    assert leer(esc, f"{DIR}/actual") == b
    ultima = registro(esc)[-1]
    assert ultima["commit"] == b and ultima["anterior"] == esc.a and ultima["resultado"] == "exito"
    assert construcciones(esc) == [esc.a], "sin cambios en sdk, plantilla ni espacio no se reconstruye la imagen"


@pytest.mark.aceptacion
@pytest.mark.parametrize("ruta", ["sdk/package.json", "plantilla-curso/package.json", "despliegue/espacio-trabajo/Containerfile"])
def test_cambios_del_espacio_reconstruyen_la_imagen(esc, ruta):
    antes = construcciones(esc)
    x = commit(esc, f"cambio en {ruta}", tocar=[ruta])
    r = desplegar(esc)
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    assert construcciones(esc) == antes + [x]
    assert leer(esc, f"{ESPACIO}/imagen") == x
    assert leer(esc, f"{DIR}/actual") == x
    esc.b = x


@pytest.mark.aceptacion
def test_imagen_inexistente_se_reconstruye(esc):
    esc.c.ok(f"rm -f {ESPACIO}/imagen", usuario="campusia")
    antes = construcciones(esc)
    x = commit(esc, "sin imagen")
    r = desplegar(esc)
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    assert construcciones(esc) == antes + [x]
    assert leer(esc, f"{ESPACIO}/imagen") == x
    esc.b = x


@pytest.mark.aceptacion
def test_imagen_con_la_etiqueta_de_campusia_env(esc):
    x = commit(esc, "otra etiqueta", tocar=["sdk/package.json"])
    r = desplegar(esc, extra={"ESPACIO_IMAGEN": "campusia-espacio:prueba"})
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    assert "--etiqueta campusia-espacio:prueba" in leer(esc, f"{ESPACIO}/construcciones").splitlines()[-1]
    assert "image inspect campusia-espacio:prueba" in leer(esc, f"{ESPACIO}/docker")
    esc.b = x


@pytest.mark.aceptacion
def test_registro_consultable(esc):
    r = esc.c.ejecutar(f"bash {SCRIPTS}/registro.sh -n 5", usuario="campusia", env={"CAMPUSIA_RAIZ": RAIZ})
    assert r.returncode == 0, r.stderr
    assert esc.b[:7] in r.stdout and "exito" in r.stdout
    r = esc.c.ejecutar(f"bash {SCRIPTS}/registro.sh -n 1", usuario="campusia", env={"CAMPUSIA_RAIZ": RAIZ})
    assert esc.a[:7] not in r.stdout
    r = esc.c.ejecutar(f"bash {SCRIPTS}/registro.sh", usuario="campusia", env={"CAMPUSIA_RAIZ": "/tmp/no-existe"})
    assert r.returncode == 0


@pytest.mark.ataque
def test_pruebas_fallidas_no_se_instalan(esc):
    c_ = commit(esc, "pruebas rotas", marcas=["FALLAR_PRUEBAS"])
    esc.rota = c_
    r = desplegar(esc)
    assert r.returncode == 1, f"{r.returncode}\n{r.stdout}\n{r.stderr}"
    assert leer(esc, f"{RAIZ}/instalado/version") == esc.b
    assert leer(esc, f"{DIR}/actual") == esc.b
    assert c_ not in leer(esc, f"{RAIZ}/instalado/historial")
    ultima = registro(esc)[-1]
    assert ultima["commit"] == c_ and ultima["resultado"] == "fallo-pruebas"


@pytest.mark.aceptacion
def test_commit_fallido_no_se_reintenta(esc):
    antes = registro(esc)
    r = desplegar(esc)
    assert r.returncode == 0
    assert registro(esc) == antes
    r = desplegar(esc, argumentos="--forzar")
    assert r.returncode == 1
    assert registro(esc)[-1]["resultado"] == "fallo-pruebas"
    assert len(registro(esc)) == len(antes) + 1


@pytest.mark.ataque
def test_compilacion_fallida_no_se_instala(esc):
    d = commit(esc, "compilacion rota", marcas=["FALLAR_COMPILACION"])
    r = desplegar(esc)
    assert r.returncode == 1
    assert leer(esc, f"{RAIZ}/instalado/version") == esc.b
    assert d not in leer(esc, f"{RAIZ}/instalado/historial")
    assert registro(esc)[-1]["resultado"] == "fallo-compilacion"


@pytest.mark.ataque
def test_instalacion_fallida_vuelve_a_la_anterior(esc):
    d = commit(esc, "instalacion rota", marcas=["FALLAR_INSTALACION"])
    r = desplegar(esc)
    assert r.returncode == 1
    assert leer(esc, f"{RAIZ}/instalado/version") == esc.b
    assert leer(esc, f"{DIR}/actual") == esc.b
    assert registro(esc)[-1]["resultado"] == "fallo-instalacion"


@pytest.mark.ataque
def test_salud_fallida_vuelve_a_la_version_anterior(esc):
    d = commit(esc, "salud rota", marcas=["ROMPER_SALUD"])
    r = desplegar(esc)
    assert r.returncode == 2, f"{r.returncode}\n{r.stdout}\n{r.stderr}"
    assert d in leer(esc, f"{RAIZ}/instalado/historial"), "la versión nueva tenía que llegar a instalarse"
    assert leer(esc, f"{RAIZ}/instalado/version") == esc.b
    assert leer(esc, f"{DIR}/actual") == esc.b
    esc.c.ok(f"test ! -e {RAIZ}/instalado/roto")
    ultima = registro(esc)[-1]
    assert ultima["commit"] == d and ultima["resultado"] == "revertido" and ultima["anterior"] == esc.b


@pytest.mark.ataque
def test_espacio_fallido_vuelve_a_la_anterior(esc):
    antes = construcciones(esc)
    d = commit(esc, "espacio roto", marcas=["FALLAR_ESPACIO"], tocar=["plantilla-curso/package.json"])
    r = desplegar(esc)
    assert r.returncode == 1, f"{r.returncode}\n{r.stdout}\n{r.stderr}"
    assert construcciones(esc) == antes + [d]
    historial = leer(esc, f"{RAIZ}/instalado/historial").splitlines()
    assert historial[-2:] == [d, esc.b], "después de fallar el espacio se tenía que reinstalar la versión anterior"
    assert leer(esc, f"{RAIZ}/instalado/version") == esc.b
    assert leer(esc, f"{DIR}/actual") == esc.b
    assert leer(esc, f"{ESPACIO}/imagen") != d
    ultima = registro(esc)[-1]
    assert ultima["commit"] == d and ultima["resultado"] == "fallo-espacio" and ultima["anterior"] == esc.b


@pytest.mark.ataque
def test_salud_fallida_reconstruye_el_espacio_anterior(esc):
    antes = construcciones(esc)
    d = commit(esc, "salud rota con espacio", marcas=["ROMPER_SALUD"], tocar=["despliegue/espacio-trabajo/Containerfile"])
    r = desplegar(esc)
    assert r.returncode == 2, f"{r.returncode}\n{r.stdout}\n{r.stderr}"
    assert construcciones(esc) == antes + [d, esc.b], "la imagen del espacio tenía que volver a la versión anterior"
    assert leer(esc, f"{ESPACIO}/imagen") == esc.b
    assert leer(esc, f"{RAIZ}/instalado/version") == esc.b
    assert registro(esc)[-1]["resultado"] == "revertido"


@pytest.mark.ataque
def test_un_solo_despliegue_a_la_vez(esc):
    f = commit(esc, "version lenta")
    antes = len(registro(esc))
    env = dict(ENTORNO)
    env["DESPLIEGUE_PRUEBAS"] = "sleep 8; bash ci/pruebas.sh"
    cmd = ["docker", "exec", "-u", "campusia"]
    for k, v in env.items():
        cmd += ["-e", f"{k}={v}"]
    cmd += [esc.c.nombre, "bash", f"{SCRIPTS}/desplegar.sh"]
    primero = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    time.sleep(3)
    segundo = desplegar(esc, extra={"DESPLIEGUE_PRUEBAS": "sleep 8; bash ci/pruebas.sh"})
    salida, error = primero.communicate(timeout=300)
    assert segundo.returncode == 75, f"el segundo despliegue no respetó el cerrojo: {segundo.returncode}\n{segundo.stderr}"
    assert primero.returncode == 0, f"{salida}\n{error}"
    entradas = registro(esc)
    assert len(entradas) == antes + 1
    assert entradas[-1]["commit"] == f and entradas[-1]["resultado"] == "exito"
    assert leer(esc, f"{RAIZ}/instalado/historial").splitlines().count(f) == 1


@pytest.mark.ataque
def test_fuentes_son_un_checkout_limpio(esc):
    actual = leer(esc, f"{DIR}/actual")
    esc.c.ok(f"test ! -e {DIR}/fuentes/{actual}/FALLAR_PRUEBAS && test ! -e {DIR}/fuentes/{actual}/ROMPER_SALUD")
    archivos = esc.c.ok(f"cd {DIR}/fuentes/{actual} && find . -path ./.git -prune -o -type f -print | sort").split()
    esperados = esc.c.ok(f"cd {TRABAJO} && git ls-tree -r --name-only {actual} | sed 's|^|./|' | sort", usuario="campusia").split()
    sobrantes = set(archivos) - set(esperados) - {"./compilado.txt"}
    assert not sobrantes, f"archivos ajenos al commit en las fuentes: {sobrantes}"


@pytest.mark.aceptacion
def test_unidades_de_systemd():
    servicio = unidad("campusia-despliegue.service")
    assert servicio.get("Service", "Type") == "oneshot"
    assert "desplegar.sh" in servicio.get("Service", "ExecStart")
    temporizador = unidad("campusia-despliegue.timer")
    t = dict(temporizador.items("Timer"))
    assert t.get("OnUnitActiveSec", "").replace(" ", "") in ("5min", "5m", "300", "300s") or t.get("OnCalendar", "").replace(" ", "") == "*:0/5"
    receptor = unidad("campusia-receptor.service")
    assert "receptor.py" in receptor.get("Service", "ExecStart")
    assert receptor.get("Service", "Restart") in ("on-failure", "always")
    assert "/srv/campusia/config/campusia.env" in receptor.get("Service", "EnvironmentFile")
    limpieza = unidad("campusia-limpieza.timer")
    assert limpieza.get("Timer", "OnCalendar").strip().lower() == "weekly"
    assert "limpiar.sh" in unidad("campusia-limpieza.service").get("Service", "ExecStart")


@pytest.mark.ataque
def test_compilacion_con_limites_y_sin_red():
    servicio = unidad("campusia-despliegue.service")
    assert servicio.get("Service", "CPUQuota", fallback=""), "falta CPUQuota"
    assert servicio.get("Service", "MemoryMax", fallback=""), "falta MemoryMax"
    texto = (CONTINUO / "desplegar.sh").read_text()
    assert re.search(r"--network[ =]none", texto), "las pruebas y la compilación tienen que correr sin red"
    assert re.search(r"--cpus", texto) and re.search(r"--memory", texto), "faltan límites de CPU y memoria en los contenedores"
    assert "DESPLIEGUE_CPUS" in texto and "DESPLIEGUE_MEMORIA" in texto
    assert re.search(r'en_contenedor sin-red "interfaz sdk" "\$GUION_COMPILAR"', texto), "la compilación tiene que incluir el SDK"
    assert "pnpm pack --pack-destination ../plantilla-curso/vendor" in texto
    assert (CONTINUO / "imagen" / "Dockerfile").is_file()
    assert (CONTINUO / "continuo.env.ejemplo").is_file()

