import grp
import hashlib
import os
import sqlite3
import tarfile

import pytest

from conftest import DESPLIEGUE, correr, escribir_ejecutable

RESPALDAR = DESPLIEGUE / "respaldo" / "respaldar.sh"
RESTAURAR = DESPLIEGUE / "respaldo" / "restaurar.sh"
AHORA = "20261112-043000"


def crear_base(ruta, filas):
    ruta.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(ruta)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("CREATE TABLE datos (valor TEXT)")
    con.executemany("INSERT INTO datos VALUES (?)", [(f,) for f in filas])
    con.commit()
    con.close()


def leer_base(ruta):
    con = sqlite3.connect(ruta)
    try:
        return sorted(f[0] for f in con.execute("SELECT valor FROM datos"))
    finally:
        con.close()


def armar_raiz(raiz, con_australis=True):
    crear_base(raiz / "datos" / "campusia.db", ["nucleo-1"])
    if con_australis:
        crear_base(raiz / "australis" / "datos" / "australis.db", ["australis-1", "australis-2"])
        subidas = raiz / "australis" / "archivos" / "campus-1"
        subidas.mkdir(parents=True)
        (subidas / "programa.pdf").write_bytes(b"%PDF-1.4 falso")
    return raiz


def respaldar(raiz):
    return correr(["bash", str(RESPALDAR)], env={"CAMPUSIA_RAIZ": str(raiz), "CAMPUSIA_AHORA": AHORA})


def entorno_restaurar(raiz, bin_falso=None):
    env = {
        "CAMPUSIA_RAIZ": str(raiz),
        "CAMPUSIA_USUARIO": os.popen("id -un").read().strip(),
        "CAMPUSIA_GRUPO": grp.getgrgid(os.getgid()).gr_name,
        "CAMPUSIA_AHORA": "20261113-100000",
    }
    if bin_falso:
        env["PATH"] = f"{bin_falso}:{os.environ['PATH']}"
    return env


class Respaldo:
    pass


@pytest.fixture(scope="module")
def respaldo(tmp_modulo):
    r = Respaldo()
    r.raiz = armar_raiz(tmp_modulo / "raiz")
    r.resultado = respaldar(r.raiz)
    r.carpeta = r.raiz / "respaldos" / AHORA
    return r


@pytest.mark.aceptacion
def test_el_respaldo_diario_termina_bien(respaldo):
    assert respaldo.resultado.returncode == 0, respaldo.resultado.stderr
    assert (respaldo.carpeta / "respaldo.tar.gz").is_file()


@pytest.mark.aceptacion
def test_el_respaldo_incluye_la_base_y_las_subidas_de_australis(respaldo):
    with tarfile.open(respaldo.carpeta / "respaldo.tar.gz") as t:
        nombres = set(t.getnames())
    assert "plataforma/campusia.db" in nombres
    assert "australis/australis.db" in nombres
    assert "australis/archivos/campus-1/programa.pdf" in nombres


@pytest.mark.aceptacion
def test_el_manifiesto_cubre_los_archivos_de_australis(respaldo):
    with tarfile.open(respaldo.carpeta / "respaldo.tar.gz") as t:
        manifiesto = t.extractfile("MANIFIESTO.sha256").read().decode()
    assert "australis/australis.db" in manifiesto
    assert "australis/archivos/campus-1/programa.pdf" in manifiesto


@pytest.mark.aceptacion
def test_el_respaldo_copia_la_base_de_australis_con_su_contenido(respaldo, tmp_modulo):
    destino = tmp_modulo / "extraido"
    destino.mkdir()
    with tarfile.open(respaldo.carpeta / "respaldo.tar.gz") as t:
        t.extractall(destino)
    assert leer_base(destino / "australis" / "australis.db") == ["australis-1", "australis-2"]
    assert leer_base(destino / "plataforma" / "campusia.db") == ["nucleo-1"]


@pytest.mark.aceptacion
def test_sin_australis_instalado_el_respaldo_sigue_funcionando(tmp_modulo):
    raiz = armar_raiz(tmp_modulo / "raiz-sin-australis", con_australis=False)
    r = respaldar(raiz)
    assert r.returncode == 0, r.stderr
    with tarfile.open(raiz / "respaldos" / AHORA / "respaldo.tar.gz") as t:
        nombres = t.getnames()
    assert not any(n.startswith("australis") for n in nombres)


@pytest.mark.aceptacion
def test_restaurar_en_una_carpeta_devuelve_la_base_y_las_subidas_de_australis(respaldo, tmp_modulo):
    destino = tmp_modulo / "restaurado"
    r = correr(["bash", str(RESTAURAR), "--destino", str(destino), str(respaldo.carpeta)],
               env=entorno_restaurar(respaldo.raiz))
    assert r.returncode == 0, r.stderr
    assert leer_base(destino / "australis" / "datos" / "australis.db") == ["australis-1", "australis-2"]
    assert (destino / "australis" / "archivos" / "campus-1" / "programa.pdf").read_bytes() == b"%PDF-1.4 falso"
    assert leer_base(destino / "datos" / "campusia.db") == ["nucleo-1"]


@pytest.mark.aceptacion
def test_restaurar_en_su_lugar_frena_y_arranca_los_dos_servicios(respaldo, tmp_modulo):
    raiz = armar_raiz(tmp_modulo / "raiz-en-su-lugar")
    llamadas = tmp_modulo / "systemctl.log"
    falsos = tmp_modulo / "falsos"
    escribir_ejecutable(falsos / "systemctl", f'#!/bin/sh\necho "$@" >> {llamadas}\n')
    con = sqlite3.connect(raiz / "australis" / "datos" / "australis.db")
    con.execute("DELETE FROM datos")
    con.execute("INSERT INTO datos VALUES ('cambiado-despues')")
    con.commit()
    con.close()
    r = correr(["bash", str(RESTAURAR), str(respaldo.carpeta)], env=entorno_restaurar(raiz, falsos))
    assert r.returncode == 0, r.stderr
    assert leer_base(raiz / "australis" / "datos" / "australis.db") == ["australis-1", "australis-2"]
    previo = raiz / "previo-20261113-100000"
    assert leer_base(previo / "australis" / "datos" / "australis.db") == ["cambiado-despues"]
    log = llamadas.read_text().split("\n")
    assert "stop campusia.service" in log and "stop campusia-australis.service" in log
    assert "start campusia.service" in log and "start campusia-australis.service" in log


def rearmar(respaldo, tmp_modulo, nombre, cambiar):
    extraido = tmp_modulo / f"{nombre}-extraido"
    extraido.mkdir()
    with tarfile.open(respaldo.carpeta / "respaldo.tar.gz") as t:
        t.extractall(extraido)
    cambiar(extraido)
    lineas = []
    for ruta in sorted(p for p in extraido.rglob("*") if p.is_file() and p.name != "MANIFIESTO.sha256"):
        lineas.append(f"{hashlib.sha256(ruta.read_bytes()).hexdigest()}  {ruta.relative_to(extraido).as_posix()}")
    (extraido / "MANIFIESTO.sha256").write_text("\n".join(lineas) + "\n")
    carpeta = tmp_modulo / f"{nombre}-respaldo"
    carpeta.mkdir()
    with tarfile.open(carpeta / "respaldo.tar.gz", "w:gz") as t:
        for hijo in sorted(extraido.iterdir()):
            t.add(hijo, arcname=hijo.name)
    suma = hashlib.sha256((carpeta / "respaldo.tar.gz").read_bytes()).hexdigest()
    (carpeta / "respaldo.tar.gz.sha256").write_text(f"{suma}  respaldo.tar.gz\n")
    return carpeta


@pytest.mark.ataque
def test_un_respaldo_con_la_base_de_australis_danada_se_rechaza(respaldo, tmp_modulo):
    carpeta = rearmar(
        respaldo, tmp_modulo, "danada",
        lambda e: (e / "australis" / "australis.db").write_bytes(b"no es una base" * 100),
    )
    destino = tmp_modulo / "no-debe-existir"
    r = correr(["bash", str(RESTAURAR), "--destino", str(destino), str(carpeta)], env=entorno_restaurar(respaldo.raiz))
    assert r.returncode == 3, r.stderr
    assert "Australis" in r.stderr
    assert not destino.exists()


@pytest.mark.ataque
def test_un_respaldo_con_australis_sin_base_se_rechaza(respaldo, tmp_modulo):
    carpeta = rearmar(respaldo, tmp_modulo, "sin-base", lambda e: (e / "australis" / "australis.db").unlink())
    destino = tmp_modulo / "no-debe-existir-2"
    r = correr(["bash", str(RESTAURAR), "--destino", str(destino), str(carpeta)], env=entorno_restaurar(respaldo.raiz))
    assert r.returncode == 3, r.stderr
    assert not destino.exists()
