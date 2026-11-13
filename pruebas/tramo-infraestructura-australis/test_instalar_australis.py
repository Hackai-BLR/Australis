import os
import stat

import pytest

from conftest import DESPLIEGUE, correr, escribir_ejecutable

BINARIO_NUCLEO = """#!/bin/sh
set -e
[ "$1" = migrar ] || exit 3
ruta="${DATABASE_URL#sqlite://}"
mkdir -p "$(dirname "$ruta")"
: > "$ruta"
"""

BINARIO_AUSTRALIS = "#!/bin/sh\necho australis\n"


def preparar(carpeta):
    carpeta.mkdir(parents=True, exist_ok=True)
    escribir_ejecutable(carpeta / "nucleo", BINARIO_NUCLEO)
    escribir_ejecutable(carpeta / "australis", BINARIO_AUSTRALIS)
    (carpeta / "interfaz").mkdir(exist_ok=True)
    (carpeta / "interfaz" / "index.html").write_text("<!doctype html><title>Campus IA</title>")
    (carpeta / "frontend" / "assets").mkdir(parents=True, exist_ok=True)
    (carpeta / "frontend" / "index.html").write_text("<!doctype html><title>Australis</title>")
    (carpeta / "frontend" / "assets" / "app.js").write_text("console.log(1)")
    return carpeta


def instalar(raiz, origen, con_australis=True):
    cmd = ["bash", str(DESPLIEGUE / "instalar.sh"), "--binario", str(origen / "nucleo"),
           "--interfaz", str(origen / "interfaz"), "--raiz", str(raiz), "--sin-servicios"]
    if con_australis:
        cmd += ["--australis-binario", str(origen / "australis"), "--australis-frontend", str(origen / "frontend")]
    return correr(cmd, timeout=300)


class Instalacion:
    pass


@pytest.fixture(scope="module")
def instalado(tmp_modulo):
    i = Instalacion()
    i.origen = preparar(tmp_modulo / "origen")
    i.raiz = tmp_modulo / "raiz"
    i.primera = instalar(i.raiz, i.origen)
    i.segunda = instalar(i.raiz, i.origen) if i.primera.returncode == 0 else None
    i.srv = i.raiz / "srv" / "campusia"
    return i


@pytest.mark.aceptacion
def test_instalar_corre_dos_veces_sin_fallar(instalado):
    assert instalado.primera.returncode == 0, f"{instalado.primera.stdout}\n{instalado.primera.stderr}"
    assert instalado.segunda is not None and instalado.segunda.returncode == 0, instalado.segunda and instalado.segunda.stderr
    assert "campusia-australis" in instalado.segunda.stdout


@pytest.mark.aceptacion
def test_instala_el_binario_de_australis_junto_al_del_nucleo(instalado):
    destino = instalado.raiz / "usr" / "local" / "bin" / "australis-server"
    assert destino.is_file() and os.access(destino, os.X_OK)
    assert destino.read_bytes() == (instalado.origen / "australis").read_bytes()
    assert (instalado.raiz / "usr" / "local" / "bin" / "campusia-nucleo").is_file()


@pytest.mark.aceptacion
def test_instala_el_frontend_de_australis_completo(instalado):
    carpeta = instalado.srv / "australis" / "frontend"
    assert (carpeta / "index.html").read_text() == (instalado.origen / "frontend" / "index.html").read_text()
    assert (carpeta / "assets" / "app.js").is_file()


@pytest.mark.aceptacion
def test_la_base_y_las_subidas_viven_bajo_srv_campusia(instalado):
    base = instalado.srv / "australis"
    assert (base / "datos").is_dir()
    assert (base / "archivos").is_dir()
    assert stat.S_IMODE((base / "archivos").stat().st_mode) == 0o700


@pytest.mark.aceptacion
def test_la_base_de_australis_no_comparte_archivo_con_la_del_nucleo(instalado):
    assert (instalado.srv / "datos" / "campusia.db").is_file()
    assert not (instalado.srv / "datos" / "australis.db").exists()


@pytest.mark.aceptacion
def test_instala_la_unidad_de_systemd_de_australis(instalado):
    unidad = instalado.raiz / "etc" / "systemd" / "system" / "campusia-australis.service"
    assert unidad.read_bytes() == (DESPLIEGUE / "campusia-australis.service").read_bytes()
    assert stat.S_IMODE(unidad.stat().st_mode) == 0o644
    assert (instalado.raiz / "etc" / "systemd" / "system" / "campusia-nucleo.service").is_file()


@pytest.mark.aceptacion
def test_sin_las_opciones_de_australis_no_se_instala_nada_de_australis(tmp_modulo):
    origen = preparar(tmp_modulo / "origen-solo-nucleo")
    raiz = tmp_modulo / "raiz-solo-nucleo"
    r = instalar(raiz, origen, con_australis=False)
    assert r.returncode == 0, r.stderr
    assert not (raiz / "usr" / "local" / "bin" / "australis-server").exists()
    assert not (raiz / "srv" / "campusia" / "australis").exists()
    assert not (raiz / "etc" / "systemd" / "system" / "campusia-australis.service").exists()


@pytest.mark.aceptacion
def test_reinstalar_conserva_la_base_y_las_subidas(instalado):
    base = instalado.srv / "australis"
    (base / "datos" / "australis.db").write_text("datos")
    (base / "archivos" / "a.pdf").write_text("pdf")
    r = instalar(instalado.raiz, instalado.origen)
    assert r.returncode == 0, r.stderr
    assert (base / "datos" / "australis.db").read_text() == "datos"
    assert (base / "archivos" / "a.pdf").read_text() == "pdf"


@pytest.mark.aceptacion
def test_reinstalar_reemplaza_el_frontend_viejo(instalado):
    carpeta = instalado.srv / "australis" / "frontend"
    (carpeta / "viejo.js").write_text("viejo")
    r = instalar(instalado.raiz, instalado.origen)
    assert r.returncode == 0, r.stderr
    assert not (carpeta / "viejo.js").exists()


@pytest.mark.ataque
def test_rechaza_el_binario_sin_el_frontend(tmp_modulo):
    origen = preparar(tmp_modulo / "origen-mitad")
    r = correr(["bash", str(DESPLIEGUE / "instalar.sh"), "--binario", str(origen / "nucleo"),
                "--interfaz", str(origen / "interfaz"), "--raiz", str(tmp_modulo / "raiz-mitad"),
                "--sin-servicios", "--australis-binario", str(origen / "australis")])
    assert r.returncode != 0
    assert "van juntos" in r.stderr
    assert not (tmp_modulo / "raiz-mitad" / "usr" / "local" / "bin" / "australis-server").exists()


@pytest.mark.ataque
def test_rechaza_un_frontend_sin_index_html(tmp_modulo):
    origen = preparar(tmp_modulo / "origen-sin-index")
    (origen / "frontend" / "index.html").unlink()
    r = instalar(tmp_modulo / "raiz-sin-index", origen)
    assert r.returncode != 0
    assert "index.html" in r.stderr
    assert not (tmp_modulo / "raiz-sin-index" / "usr" / "local" / "bin" / "australis-server").exists()


@pytest.mark.ataque
def test_rechaza_un_binario_de_australis_que_no_existe(tmp_modulo):
    origen = preparar(tmp_modulo / "origen-sin-bin")
    (origen / "australis").unlink()
    r = instalar(tmp_modulo / "raiz-sin-bin", origen)
    assert r.returncode != 0
    assert "binario de Australis" in r.stderr
