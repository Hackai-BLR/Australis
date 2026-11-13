import os
import stat

import pytest

from conftest import DESPLIEGUE, correr

BINARIO_FALSO = """#!/bin/sh
set -e
[ "$1" = migrar ] || exit 3
ruta="${DATABASE_URL#sqlite://}"
mkdir -p "$(dirname "$ruta")"
: > "$ruta"
"""

GUIONES = ("respaldar.sh", "restaurar.sh")
UNIDADES = ("campusia-respaldo.service", "campusia-respaldo.timer")


class Instalacion:
    pass


def instalar(raiz, origen):
    return correr(
        ["bash", str(DESPLIEGUE / "instalar.sh"), "--binario", str(origen / "binario"),
         "--interfaz", str(origen / "interfaz"), "--raiz", str(raiz), "--sin-servicios"],
        timeout=300,
    )


def preparar_origen(carpeta):
    carpeta.mkdir(parents=True, exist_ok=True)
    (carpeta / "binario").write_text(BINARIO_FALSO)
    (carpeta / "binario").chmod(0o755)
    (carpeta / "interfaz").mkdir(exist_ok=True)
    (carpeta / "interfaz" / "index.html").write_text("<!doctype html><title>Campus IA</title>")
    return carpeta


@pytest.fixture(scope="module")
def instalado(tmp_modulo):
    i = Instalacion()
    i.origen = preparar_origen(tmp_modulo / "origen")
    i.raiz = tmp_modulo / "raiz"
    i.primera = instalar(i.raiz, i.origen)
    i.segunda = instalar(i.raiz, i.origen) if i.primera.returncode == 0 else None
    i.destino = i.raiz / "srv" / "campusia" / "plataforma" / "despliegue" / "respaldo"
    i.unidades = i.raiz / "etc" / "systemd" / "system"
    return i


@pytest.mark.aceptacion
def test_instalar_corre_dos_veces_sin_fallar(instalado):
    assert instalado.primera.returncode == 0, f"{instalado.primera.stdout}\n{instalado.primera.stderr}"
    assert instalado.segunda is not None and instalado.segunda.returncode == 0, instalado.segunda and instalado.segunda.stderr


@pytest.mark.aceptacion
@pytest.mark.parametrize("guion", GUIONES)
def test_instalar_copia_los_guiones_de_respaldo(instalado, guion):
    destino = instalado.destino / guion
    assert destino.is_file() and not destino.is_symlink(), f"falta {destino}"
    assert destino.read_bytes() == (DESPLIEGUE / "respaldo" / guion).read_bytes(), f"{guion} no es copia exacta del repo"
    assert os.access(destino, os.X_OK), f"{guion} no es ejecutable"


@pytest.mark.aceptacion
@pytest.mark.parametrize("unidad", UNIDADES)
def test_instalar_copia_las_unidades_de_respaldo(instalado, unidad):
    destino = instalado.unidades / unidad
    assert destino.is_file(), f"falta {destino}"
    assert destino.read_bytes() == (DESPLIEGUE / "respaldo" / unidad).read_bytes()
    assert stat.S_IMODE(destino.stat().st_mode) == 0o644


@pytest.mark.aceptacion
def test_la_unidad_apunta_al_guion_instalado():
    texto = (DESPLIEGUE / "respaldo" / "campusia-respaldo.service").read_text()
    assert "ExecStart=/srv/campusia/plataforma/despliegue/respaldo/respaldar.sh" in texto
    assert "User=campusia" in texto
    temporizador = (DESPLIEGUE / "respaldo" / "campusia-respaldo.timer").read_text()
    assert "OnCalendar=*-*-* 04:30:00" in temporizador


@pytest.mark.aceptacion
def test_instalar_crea_la_carpeta_de_respaldos(instalado):
    carpeta = instalado.raiz / "srv" / "campusia" / "respaldos"
    assert carpeta.is_dir()
    assert stat.S_IMODE(carpeta.stat().st_mode) == 0o700


@pytest.mark.ataque
@pytest.mark.parametrize("guion", GUIONES)
def test_instalar_no_sigue_enlaces_en_el_destino(tmp_modulo, guion):
    origen = preparar_origen(tmp_modulo / f"origen-enlace-{guion}")
    raiz = tmp_modulo / f"raiz-enlace-{guion}"
    r = instalar(raiz, origen)
    assert r.returncode == 0, r.stderr
    ajeno = tmp_modulo / f"ajeno-{guion}"
    ajeno.write_text("no tocar\n")
    destino = raiz / "srv" / "campusia" / "plataforma" / "despliegue" / "respaldo" / guion
    destino.unlink()
    destino.symlink_to(ajeno)
    r = instalar(raiz, origen)
    assert ajeno.read_text() == "no tocar\n", "instalar.sh escribió a través de un enlace"
    if r.returncode == 0:
        assert destino.is_file() and not destino.is_symlink()
        assert destino.read_bytes() == (DESPLIEGUE / "respaldo" / guion).read_bytes()


@pytest.mark.ataque
def test_instalar_no_sigue_un_enlace_en_la_carpeta_de_respaldo(tmp_modulo):
    origen = preparar_origen(tmp_modulo / "origen-carpeta")
    raiz = tmp_modulo / "raiz-carpeta"
    r = instalar(raiz, origen)
    assert r.returncode == 0, r.stderr
    ajena = tmp_modulo / "carpeta-ajena"
    ajena.mkdir()
    carpeta = raiz / "srv" / "campusia" / "plataforma" / "despliegue" / "respaldo"
    correr(["rm", "-rf", str(carpeta)])
    carpeta.symlink_to(ajena)
    instalar(raiz, origen)
    assert list(ajena.iterdir()) == [], "instalar.sh escribió en una carpeta ajena a través de un enlace"


@pytest.mark.ataque
def test_instalar_no_copia_otros_archivos_ejecutables_al_respaldo(instalado):
    presentes = sorted(p.name for p in instalado.destino.iterdir() if p.is_file() and os.access(p, os.X_OK))
    assert presentes == sorted(GUIONES), f"ejecutables inesperados en la carpeta de respaldo: {presentes}"
