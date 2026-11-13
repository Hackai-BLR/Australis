import json

import pytest

from conftest import DESPLIEGUE, SUFIJO, construir_imagen, levantar_contenedor

GUION = DESPLIEGUE / "docker" / "preparar-docker.sh"
MODULOS = "/etc/modules-load.d/campusia-docker.conf"


class Preparado:
    pass


def como_campusia(c, comando, timeout=300):
    uid = c.ok("id -u campusia").strip()
    return c.ejecutar(
        f"runuser -u campusia -- env XDG_RUNTIME_DIR=/run/user/{uid} DOCKER_HOST=unix:///run/user/{uid}/docker.sock {comando}",
        timeout=timeout,
    )


@pytest.fixture(scope="module")
def preparado():
    assert GUION.is_file(), "falta despliegue/docker/preparar-docker.sh"
    imagen = construir_imagen("debian13", "campusia-pruebas-cierre-debian13")
    c = levantar_contenedor(imagen, f"campusia-final-docker-{SUFIJO}")
    p = Preparado()
    p.c = c
    try:
        c.ok("apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates >/dev/null", timeout=900)
        c.ok("groupadd --system campusia && useradd --system --gid campusia --home-dir /srv/campusia --create-home --shell /usr/sbin/nologin campusia")
        c.ok("usermod --add-subuids 300000-365535 --add-subgids 300000-365535 campusia")
        c.copiar(GUION, "/root/preparar-docker.sh")
        p.r = c.ejecutar("bash /root/preparar-docker.sh", timeout=1800)
        yield p
    finally:
        c.borrar()


@pytest.fixture(scope="module")
def listo(preparado):
    assert preparado.r.returncode == 0, f"preparar-docker.sh falló\n{preparado.r.stdout[-4000:]}\n{preparado.r.stderr[-4000:]}"
    return preparado


@pytest.mark.aceptacion
def test_preparar_docker_carga_br_netfilter(listo):
    listo.c.ok("test -d /sys/module/br_netfilter")
    listo.c.ok("command -v modprobe")


@pytest.mark.aceptacion
def test_preparar_docker_persiste_br_netfilter(listo):
    assert listo.c.ok(f"cat {MODULOS}") == "br_netfilter\n"
    assert listo.c.ok(f"stat -c '%U %G %a' {MODULOS}").split() == ["root", "root", "644"]


@pytest.mark.aceptacion
def test_preparar_docker_deja_docker_sin_root_que_crea_redes_internas(listo):
    nombre = f"prueba-{SUFIJO}"
    r = como_campusia(listo.c, f"docker network create --internal -o com.docker.network.bridge.enable_icc=false {nombre}")
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    r = como_campusia(listo.c, f"docker network inspect {nombre}")
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout)[0]["Internal"] is True
    r = como_campusia(listo.c, "docker info -f '{{json .SecurityOptions}}'")
    assert r.returncode == 0 and "rootless" in r.stdout


@pytest.mark.ataque
def test_preparar_docker_no_deja_el_docker_del_sistema(listo):
    for unidad in ("docker.service", "docker.socket"):
        assert listo.c.ejecutar(f"systemctl is-active {unidad}").stdout.strip() != "active"
    assert "docker" not in listo.c.ok("id -nG campusia").split()
    assert listo.c.ejecutar("runuser -u nobody -- docker -H unix:///var/run/docker.sock ps").returncode != 0


@pytest.mark.ataque
def test_el_archivo_de_modulos_no_lo_puede_cambiar_campusia(listo):
    assert listo.c.ejecutar(f"runuser -u campusia -- test -w {MODULOS}").returncode != 0
