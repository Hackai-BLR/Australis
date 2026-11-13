import json

import pytest

from conftest import CONTINUO, correr, escribir_ejecutable

INSTALAR = r'''#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$CAMPUSIA_RAIZ/instalado"
echo "$COMMIT" >> "$CAMPUSIA_RAIZ/instalado/historial"
BASE_A="$CAMPUSIA_RAIZ/australis/datos/australis.db"
if [ -e MIGRAR ] && [ -f "$BASE_A" ]; then sqlite3 "$BASE_A" "CREATE TABLE IF NOT EXISTS migrada (x INTEGER)"; fi
if [ ! -e MIGRAR ] && [ -f "$BASE_A" ] && [ -n "$(sqlite3 "$BASE_A" "SELECT name FROM sqlite_master WHERE name='migrada'")" ]; then echo "binario viejo: migracion desconocida" >&2; exit 1; fi
if [ -e ROMPER_AUSTRALIS ]; then touch "$CAMPUSIA_RAIZ/roto-8090"; else rm -f "$CAMPUSIA_RAIZ/roto-8090"; fi
if [ -e ROMPER_NUCLEO ]; then touch "$CAMPUSIA_RAIZ/roto-8080"; else rm -f "$CAMPUSIA_RAIZ/roto-8080"; fi
if [ -e FALLAR_INSTALACION_AUSTRALIS ] && [ -e compilado/bin/australis-server ]; then exit 1; fi
if [ -e compilado/bin/australis-server ]; then echo "$COMMIT" > "$CAMPUSIA_RAIZ/instalado/australis"; else rm -f "$CAMPUSIA_RAIZ/instalado/australis"; fi
echo "$COMMIT" > "$CAMPUSIA_RAIZ/instalado/nucleo"
'''

PRUEBAS = '#!/usr/bin/env bash\nif [ -e FALLAR_PRUEBAS_AUSTRALIS ]; then exit 1; fi\nexit 0\n'

COMPILAR = r'''#!/usr/bin/env bash
mkdir -p compilado/bin
echo nucleo > compilado/bin/campusia-nucleo
if [ ! -e SIN_AUSTRALIS ]; then echo australis > compilado/bin/australis-server; fi
'''

CURL_FALSO = r'''#!/usr/bin/env bash
url="${@: -1}"
echo "$url" >> "$CAMPUSIA_RAIZ/curl.log"
puerto="$(echo "$url" | sed -n 's#^http://127.0.0.1:\([0-9]*\)/.*#\1#p')"
[ ! -e "$CAMPUSIA_RAIZ/roto-$puerto" ]
'''


class Escenario:
    pass


def git(cwd, *args):
    r = correr(["git", *args], cwd=cwd)
    assert r.returncode == 0, f"git {args}: {r.stderr}"
    return r.stdout.strip()


@pytest.fixture(scope="module")
def esc(tmp_modulo):
    e = Escenario()
    e.raiz = tmp_modulo / "campusia"
    e.raiz.mkdir()
    e.origen = tmp_modulo / "origen.git"
    e.trabajo = tmp_modulo / "trabajo"
    e.falsos = tmp_modulo / "falsos"
    escribir_ejecutable(e.falsos / "curl", CURL_FALSO)
    git(tmp_modulo, "init", "-q", "--bare", "-b", "main", str(e.origen))
    git(tmp_modulo, "init", "-q", "-b", "main", str(e.trabajo))
    git(e.trabajo, "config", "user.email", "prueba@ejemplo.com")
    git(e.trabajo, "config", "user.name", "prueba")
    git(e.trabajo, "remote", "add", "origin", str(e.origen))
    escribir_ejecutable(e.trabajo / "despliegue" / "instalar.sh", INSTALAR)
    escribir_ejecutable(e.trabajo / "ci" / "pruebas.sh", PRUEBAS)
    escribir_ejecutable(e.trabajo / "ci" / "compilar.sh", COMPILAR)
    (e.trabajo / ".gitignore").write_text("compilado\n")
    return e


def commit(e, mensaje, marcas=()):
    for m in ("ROMPER_AUSTRALIS", "ROMPER_NUCLEO", "SIN_AUSTRALIS", "FALLAR_INSTALACION_AUSTRALIS", "FALLAR_PRUEBAS_AUSTRALIS", "MIGRAR"):
        (e.trabajo / m).unlink(missing_ok=True)
    for m in marcas:
        (e.trabajo / m).write_text("")
    with open(e.trabajo / "cambios.txt", "a") as f:
        f.write(mensaje + "\n")
    git(e.trabajo, "add", "-A")
    git(e.trabajo, "commit", "-q", "-m", mensaje)
    git(e.trabajo, "push", "-q", "origin", "main")
    return git(e.trabajo, "rev-parse", "HEAD")


def desplegar(e):
    env = {
        "PATH": f"{e.falsos}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "CAMPUSIA_RAIZ": str(e.raiz),
        "DESPLIEGUE_ORIGEN": str(e.origen),
        "DESPLIEGUE_PRUEBAS": "bash ci/pruebas.sh",
        "DESPLIEGUE_COMPILAR": "bash ci/compilar.sh",
        "DESPLIEGUE_INSTALAR": "bash despliegue/instalar.sh",
        "DESPLIEGUE_ESPACIO": "true",
        "DESPLIEGUE_SALUD_ESPERA": "2",
    }
    return correr(["bash", str(CONTINUO / "desplegar.sh")], env=env, timeout=120)


def registro(e):
    ruta = e.raiz / "despliegue" / "registro.log"
    return [json.loads(l) for l in ruta.read_text().splitlines() if l.strip()]


def actual(e):
    return (e.raiz / "despliegue" / "actual").read_text().strip()


def curl_log(e):
    ruta = e.raiz / "curl.log"
    return ruta.read_text().split() if ruta.exists() else []


def instalado(e, nombre):
    ruta = e.raiz / "instalado" / nombre
    return ruta.read_text().strip() if ruta.exists() else None


@pytest.mark.aceptacion
def test_un_despliegue_sano_comprueba_el_nucleo_y_australis(esc):
    c1 = commit(esc, "uno")
    r = desplegar(esc)
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    assert registro(esc)[-1]["resultado"] == "exito"
    assert actual(esc) == c1
    urls = curl_log(esc)
    assert "http://127.0.0.1:8080/salud" in urls
    assert "http://127.0.0.1:8090/api/health" in urls
    assert instalado(esc, "nucleo") == c1 and instalado(esc, "australis") == c1


@pytest.mark.aceptacion
def test_si_australis_no_responde_se_revierten_los_dos_juntos(esc):
    anterior = actual(esc)
    commit(esc, "dos", marcas=["ROMPER_AUSTRALIS"])
    r = desplegar(esc)
    assert r.returncode == 2, f"{r.stdout}\n{r.stderr}"
    assert registro(esc)[-1]["resultado"] == "revertido"
    assert actual(esc) == anterior
    assert instalado(esc, "nucleo") == anterior, "el núcleo no volvió a la versión anterior"
    assert instalado(esc, "australis") == anterior, "Australis no volvió a la versión anterior"


@pytest.mark.aceptacion
def test_si_el_nucleo_no_responde_tambien_se_revierten_los_dos(esc):
    anterior = actual(esc)
    commit(esc, "tres", marcas=["ROMPER_NUCLEO"])
    r = desplegar(esc)
    assert r.returncode == 2, f"{r.stdout}\n{r.stderr}"
    assert registro(esc)[-1]["resultado"] == "revertido"
    assert instalado(esc, "nucleo") == anterior and instalado(esc, "australis") == anterior


@pytest.mark.aceptacion
def test_si_falla_la_instalacion_de_australis_vuelve_la_version_anterior(esc):
    anterior = actual(esc)
    commit(esc, "cuatro", marcas=["FALLAR_INSTALACION_AUSTRALIS"])
    r = desplegar(esc)
    assert r.returncode == 1, f"{r.stdout}\n{r.stderr}"
    assert registro(esc)[-1]["resultado"] == "fallo-instalacion"
    assert actual(esc) == anterior
    assert instalado(esc, "nucleo") == anterior and instalado(esc, "australis") == anterior


@pytest.mark.aceptacion
def test_un_commit_con_las_pruebas_de_australis_rotas_no_se_instala(esc):
    anterior = actual(esc)
    commit(esc, "cinco", marcas=["FALLAR_PRUEBAS_AUSTRALIS"])
    r = desplegar(esc)
    assert r.returncode == 1
    assert registro(esc)[-1]["resultado"] == "fallo-pruebas"
    assert instalado(esc, "nucleo") == anterior


@pytest.mark.aceptacion
def test_un_commit_sin_australis_no_comprueba_su_salud(esc):
    commit(esc, "seis", marcas=["SIN_AUSTRALIS"])
    (esc.raiz / "curl.log").unlink(missing_ok=True)
    r = desplegar(esc)
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    assert registro(esc)[-1]["resultado"] == "exito"
    urls = curl_log(esc)
    assert "http://127.0.0.1:8080/salud" in urls
    assert not any(":8090/" in u for u in urls)


@pytest.mark.aceptacion
def test_la_copia_previa_incluye_la_base_de_australis(esc):
    import sqlite3

    base = esc.raiz / "australis" / "datos" / "australis.db"
    base.parent.mkdir(parents=True)
    con = sqlite3.connect(base)
    con.execute("CREATE TABLE t (v TEXT)")
    con.execute("INSERT INTO t VALUES ('antes')")
    con.commit()
    con.close()
    c = commit(esc, "siete")
    r = desplegar(esc)
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    copia = esc.raiz / "despliegue" / "previos" / f"{c}-australis.db"
    assert copia.is_file()
    con = sqlite3.connect(copia)
    try:
        assert con.execute("SELECT v FROM t").fetchall() == [("antes",)]
    finally:
        con.close()


@pytest.mark.aceptacion
def test_al_revertir_se_restaura_la_base_de_australis_anterior_a_la_migracion(esc):
    import sqlite3

    anterior = actual(esc)
    commit(esc, "ocho", marcas=["MIGRAR", "ROMPER_NUCLEO"])
    r = desplegar(esc)
    assert r.returncode == 2, f"{r.stdout}\n{r.stderr}"
    assert registro(esc)[-1]["resultado"] == "revertido", f"{r.stdout}\n{r.stderr}"
    assert actual(esc) == anterior
    assert instalado(esc, "australis") == anterior
    con = sqlite3.connect(esc.raiz / "australis" / "datos" / "australis.db")
    try:
        assert con.execute("SELECT v FROM t").fetchall() == [("antes",)]
        assert con.execute("SELECT name FROM sqlite_master WHERE name='migrada'").fetchall() == []
    finally:
        con.close()
