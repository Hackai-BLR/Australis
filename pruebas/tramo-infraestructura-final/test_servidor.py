import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import shlex
import time
import uuid

import pytest

from conftest import (
    DESPLIEGUE,
    INFRA,
    SUFIJO,
    certificado_de_prueba,
    construir_imagen,
    correr,
    levantar_contenedor,
    preparar_envoltorios,
)

LEVANTAR = INFRA / "levantar.sh"
CF_V4 = ["173.245.48.0/20", "103.21.244.0/22", "141.101.64.0/18"]
CF_V6 = ["2400:cb00::/32", "2606:4700::/32"]
IP_CF_LOCAL = str(ipaddress.ip_network(CF_V4[0])[77])
CLAVES_VAULT = (
    "vault_brevo_api_key",
    "vault_claude_code_oauth_token",
    "vault_turnstile_clave_sitio",
    "vault_turnstile_clave_secreta",
    "vault_secreto_sesion",
    "vault_secreto_firma",
    "vault_secreto_webhook",
)
DISTROS = [d for d in os.environ.get("FINAL_DISTROS", "debian13").split(",") if d]
ZONA = "America/Argentina/Buenos_Aires"
RESPALDO_DIR = "/srv/campusia/plataforma/despliegue/respaldo"
MODULOS = "/etc/modules-load.d/campusia-docker.conf"
RED_CURSOS = "campusia-cursos"

COMPILAR = """#!/usr/bin/env bash
set -euo pipefail
mkdir -p compilado/bin interfaz
install -m 0755 /srv/prueba/compilado/campusia-nucleo compilado/bin/campusia-nucleo
rm -rf interfaz/dist
cp -r /srv/prueba/compilado/dist interfaz/dist
"""


class Servidor:
    pass


def entorno_levantar(s):
    entorno = {k: v for k, v in os.environ.items() if not k.startswith(("CAMPUSIA_", "CLOUDFLARE_", "TOFU_", "ANSIBLE_VAULT", "TF_VAR_"))}
    entorno.update({
        "PATH": f"{s.envoltorios}{os.pathsep}{os.environ['PATH']}",
        "LLAMADAS_REGISTRO": str(s.registro),
        "ANSIBLE_NOCOLOR": "1",
        "CAMPUSIA_IP": s.ip,
        "CAMPUSIA_SSH_USUARIO": "root",
        "CAMPUSIA_SSH_CLAVE": str(s.dir / "clave"),
        "CAMPUSIA_KNOWN_HOSTS": str(s.dir / "known_hosts"),
        "CLOUDFLARE_API_TOKEN": s.token,
        "TOFU_FRASE_ESTADO": s.frase,
        "ANSIBLE_VAULT_CONTRASENA": s.contrasena_vault,
        "CAMPUSIA_VAULT_ARCHIVO": str(s.vault),
        "CAMPUSIA_TFVARS": str(s.tfvars),
        "CAMPUSIA_ANSIBLE_EXTRA": str(s.extra),
    })
    return entorno


def correr_levantar(s):
    return correr(["bash", str(LEVANTAR)], cwd=s.dir, entorno_base=entorno_levantar(s), timeout=4800, combinar=True)


def recap(salida, ip):
    m = re.findall(rf"(?m)^{re.escape(ip)}\s*:\s*ok=(\d+)\s+changed=(\d+)\s+unreachable=(\d+)\s+failed=(\d+)", salida)
    assert m, f"no se encontró el PLAY RECAP de {ip}\n{salida[-4000:]}"
    return [int(x) for x in m[-1]]


def esperar(condicion, segundos=90):
    limite = time.time() + segundos
    while time.time() < limite:
        if condicion():
            return True
        time.sleep(1)
    return False


def sano(s):
    return s.c.ejecutar("curl -fsS --max-time 5 http://127.0.0.1:8080/salud").returncode == 0


def uid_campusia(s):
    return s.c.ok("id -u campusia").strip()


def como_campusia(s, comando, timeout=120):
    u = uid_campusia(s)
    return s.c.ejecutar(
        f"cd / && runuser -u campusia -- env XDG_RUNTIME_DIR=/run/user/{u} DOCKER_HOST=unix:///run/user/{u}/docker.sock {comando}",
        timeout=timeout,
    )


def red_cursos(s):
    r = como_campusia(s, f"docker network inspect {RED_CURSOS}")
    if r.returncode != 0:
        return None
    return json.loads(r.stdout)[0]


def https_por_caddy(s, ruta, origen, metodo="GET", cuerpo=None, encabezados=None, host="campusia.tech"):
    partes = [
        "curl", "-sk", "--max-time", "10", "--interface", origen,
        "--resolve", f"{host}:443:{origen}", "-o", "/tmp/respuesta-final", "-w", "%{http_code}",
        "-X", metodo,
    ]
    for k, v in (encabezados or {}).items():
        partes += ["-H", f"{k}: {v}"]
    if cuerpo is not None:
        partes += ["--data-binary", "@-"]
    partes.append(f"https://{host}{ruta}")
    comando = "rm -f /tmp/respuesta-final; " + " ".join(shlex.quote(p) for p in partes) + "; echo; cat /tmp/respuesta-final 2>/dev/null"
    r = s.c.ejecutar(comando, entrada=cuerpo)
    lineas = r.stdout.split("\n", 1)
    codigo = lineas[0].strip()
    return codigo, (lineas[1] if len(lineas) > 1 else "")


def firmar(secreto, cuerpo):
    return "sha256=" + hmac.new(secreto.encode(), cuerpo.encode(), hashlib.sha256).hexdigest()


def ping(s, secreto, origen=IP_CF_LOCAL, ruta="/_despliegue/webhook", encabezados_extra=None):
    cuerpo = json.dumps({"zen": "prueba", "hook_id": 1})
    encabezados = {
        "Content-Type": "application/json",
        "X-GitHub-Event": "ping",
        "X-GitHub-Delivery": str(uuid.uuid4()),
        "X-Hub-Signature-256": firmar(secreto, cuerpo),
    }
    encabezados.update(encabezados_extra or {})
    return https_por_caddy(s, ruta, origen, metodo="POST", cuerpo=cuerpo, encabezados=encabezados)


@pytest.fixture(scope="module", params=DISTROS)
def servidor(request, tmp_sesion, artefactos_listos, instantanea, origen_git):
    assert LEVANTAR.is_file(), "falta infraestructura/levantar.sh"
    dist = request.param
    s = Servidor()
    s.dist = dist
    s.commit = instantanea.commit
    s.dir = tmp_sesion / f"final-{dist}"
    s.dir.mkdir()
    imagen = construir_imagen(dist, f"campusia-pruebas-cierre-{dist}")
    c = levantar_contenedor(imagen, f"campusia-final-{dist}-{SUFIJO}")
    s.c = c
    try:
        r = correr(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "prueba-final", "-f", str(s.dir / "clave")])
        assert r.returncode == 0, r.stderr
        publica = (s.dir / "clave.pub").read_text().strip()
        c.ok("install -d -m 700 /root/.ssh && cat > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys", entrada=publica + "\n")
        c.ok("systemctl start ssh || systemctl start ssh.socket")
        s.ip = c.ip()
        c.ok("install -d -m 755 /srv/prueba /srv/prueba/compilado")
        c.copiar(artefactos_listos.binario, "/srv/prueba/compilado/campusia-nucleo")
        c.copiar(artefactos_listos.interfaz, "/srv/prueba/compilado/dist")
        c.ok("cat > /srv/prueba/compilar.sh", entrada=COMPILAR)
        c.ok("chown -R root:root /srv/prueba && chmod -R a+rX /srv/prueba && chmod 755 /srv/prueba/compilar.sh /srv/prueba/compilado/campusia-nucleo")

        clave, pem = certificado_de_prueba(s.dir / "certs")
        s.valores_vault = {k: f"prueba-{k.replace('_', '-')}-{secrets.token_hex(16)}" for k in CLAVES_VAULT}
        datos = dict(s.valores_vault)
        datos["vault_origen_clave"] = clave.read_text()
        datos["vault_origen_certificado"] = pem.read_text()
        plano = s.dir / "secretos.plano.yml"
        plano.write_text(json.dumps(datos))
        s.contrasena_vault = "vault-" + secrets.token_hex(20)
        archivo = s.dir / "vault-pass"
        archivo.write_text(s.contrasena_vault + "\n")
        s.vault = s.dir / "secretos.vault.yml"
        r = correr(["ansible-vault", "encrypt", "--vault-password-file", str(archivo), "--output", str(s.vault), str(plano)])
        assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
        plano.unlink()
        archivo.unlink()
        for f in (clave, pem):
            f.unlink()

        s.token = "cf-token-" + secrets.token_hex(20)
        s.frase = "frase-estado-" + secrets.token_hex(16)
        s.tfvars = s.dir / "produccion.tfvars"
        s.tfvars.write_text('correo_destino_reenvio = "destino@ejemplo.com"\n')
        s.extra = s.dir / "extra.json"
        s.extra.write_text(json.dumps({
            "servidor_contenedor_de_prueba": True,
            "servidor_docker_sin_root_en_prueba": True,
            "swap_tamano_mb": 64,
            "firewall_cloudflare_ipv4": CF_V4,
            "firewall_cloudflare_ipv6": CF_V6,
            "ssh_claves_root": [publica],
            "despliegue_origen": origen_git,
            "despliegue_rama": "main",
            "despliegue_continuo_env": {
                "DESPLIEGUE_PRUEBAS": "true",
                "DESPLIEGUE_COMPILAR": "bash /srv/prueba/compilar.sh",
                "DESPLIEGUE_SALUD_ESPERA": "90",
            },
        }))
        s.envoltorios = preparar_envoltorios(s.dir / "bin")
        s.registro = s.dir / "llamadas.jsonl"
        s.secreto_webhook = s.valores_vault["vault_secreto_webhook"]

        s.primera = correr_levantar(s)
        s.segunda = correr_levantar(s) if s.primera.returncode == 0 else None
        if s.primera.returncode == 0:
            c.ejecutar(f"ip addr add {IP_CF_LOCAL}/32 dev lo")
        yield s
    finally:
        c.borrar()


@pytest.fixture(scope="module")
def levantado(servidor):
    r = servidor.primera
    assert r.returncode == 0, f"levantar.sh falló en {servidor.dist}\n{r.stdout[-8000:]}"
    return servidor


@pytest.fixture(scope="module")
def con_respaldo(levantado):
    s = levantado
    s.c.ejecutar("rm -rf /srv/campusia/respaldos/2*")
    s.respaldo = s.c.ejecutar("systemctl start campusia-respaldo.service", timeout=600)
    s.respaldos = s.c.ejecutar(
        "find /srv/campusia/respaldos -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9]{8}-[0-9]{6}'"
    ).stdout.split()
    return s


@pytest.mark.aceptacion
def test_levantar_termina_bien(levantado):
    salida = levantado.primera.stdout
    assert [l for l in salida.splitlines() if l.strip()][-1].strip() == "levantar: listo"


@pytest.mark.aceptacion
def test_segunda_corrida_sin_cambios(levantado):
    r = levantado.segunda
    assert r is not None and r.returncode == 0, f"la segunda corrida falló\n{(r.stdout if r else '')[-6000:]}"
    ok, changed, unreachable, failed = recap(r.stdout, levantado.ip)
    assert changed == 0 and failed == 0 and unreachable == 0, f"la segunda corrida de Ansible tuvo cambios: changed={changed}"


@pytest.mark.aceptacion
def test_br_netfilter_cargado_y_persistido(levantado):
    s = levantado
    s.c.ok("test -d /sys/module/br_netfilter")
    s.c.ok("command -v modprobe")
    assert s.c.ok(f"cat {MODULOS}") == "br_netfilter\n"
    assert s.c.ok(f"stat -c '%U %G %a' {MODULOS}").split() == ["root", "root", "644"]


@pytest.mark.aceptacion
def test_docker_sin_root_activo_para_campusia(levantado):
    s = levantado
    r = s.c.ejecutar(f"runuser -u campusia -- env XDG_RUNTIME_DIR=/run/user/{uid_campusia(s)} systemctl --user is-active docker.service")
    assert r.stdout.strip() == "active", f"Docker sin root de campusia no está activo: {r.stdout} {r.stderr}"
    r = como_campusia(s, "docker info -f '{{json .SecurityOptions}}'")
    assert r.returncode == 0 and "rootless" in r.stdout, r.stderr


@pytest.mark.aceptacion
def test_nucleo_arranca_y_crea_la_red_de_cursos(levantado):
    s = levantado
    assert esperar(lambda: sano(s)), "el núcleo no responde /salud"
    assert s.c.ok("systemctl is-active campusia-nucleo.service").strip() == "active"
    red = red_cursos(s)
    assert red is not None, f"el núcleo no creó la red {RED_CURSOS} en el Docker sin root de campusia"
    assert red["Internal"] is True
    assert red.get("Options", {}).get("com.docker.network.bridge.enable_icc") == "false"
    assert red.get("Labels", {}).get("campusia.prefijo") == "campusia"


@pytest.mark.aceptacion
def test_nucleo_vuelve_a_crear_la_red_al_reiniciar(levantado):
    s = levantado
    s.c.ok("systemctl stop campusia-nucleo.service")
    como_campusia(s, f"docker network rm {RED_CURSOS}")
    assert red_cursos(s) is None
    s.c.ok("systemctl start campusia-nucleo.service")
    assert esperar(lambda: sano(s)), "el núcleo no volvió a responder /salud"
    assert esperar(lambda: red_cursos(s) is not None, 30), "el núcleo no volvió a crear la red de cursos"


@pytest.mark.aceptacion
def test_zona_horaria_de_buenos_aires(levantado):
    s = levantado
    assert s.c.ok("readlink -f /etc/localtime").strip().endswith(f"/zoneinfo/{ZONA}")
    assert s.c.ok("date +%z").strip() == "-0300"
    r = s.c.ejecutar("cat /etc/timezone")
    if r.returncode == 0:
        assert r.stdout.strip() == ZONA


@pytest.mark.aceptacion
def test_guiones_de_respaldo_instalados(levantado):
    s = levantado
    for guion in ("respaldar.sh", "restaurar.sh"):
        ruta = f"{RESPALDO_DIR}/{guion}"
        s.c.ok(f"test -f {ruta} && test ! -L {ruta}")
        dueno, grupo, modo = s.c.ok(f"stat -c '%U %G %a' {ruta}").split()
        assert dueno == "root", f"{guion} tiene que ser de root"
        assert int(modo, 8) & 0o022 == 0, f"{guion} no puede ser escribible por el grupo ni por otros"
        assert s.c.ok(f"sha256sum {ruta}").split()[0] == hashlib.sha256((DESPLIEGUE / "respaldo" / guion).read_bytes()).hexdigest()
    s.c.ok(f"runuser -u campusia -- test -x {RESPALDO_DIR}/respaldar.sh")


@pytest.mark.aceptacion
def test_unidades_de_respaldo_y_temporizador_habilitado(levantado):
    s = levantado
    for unidad in ("campusia-respaldo.service", "campusia-respaldo.timer"):
        ruta = f"/etc/systemd/system/{unidad}"
        assert s.c.ok(f"stat -c '%U %G %a' {ruta}").split() == ["root", "root", "644"]
        assert s.c.ok(f"cat {ruta}") == (DESPLIEGUE / "respaldo" / unidad).read_text()
    assert s.c.ok("systemctl is-enabled campusia-respaldo.timer").strip() == "enabled"
    assert s.c.ok("systemctl is-active campusia-respaldo.timer").strip() == "active"


@pytest.mark.aceptacion
def test_el_respaldo_corre_a_las_cuatro_y_media_hora_local(levantado):
    s = levantado
    proximo = s.c.ok("systemctl show -p NextElapseUSecRealtime --value campusia-respaldo.timer").strip()
    assert re.search(r"\b04:30:00 -03\b", proximo), f"el próximo respaldo no es a las 04:30 de Buenos Aires: {proximo}"


@pytest.mark.aceptacion
def test_carpeta_de_respaldos(levantado):
    assert levantado.c.ok("stat -c '%U %G %a' /srv/campusia/respaldos").split() == ["campusia", "campusia", "700"]


@pytest.mark.aceptacion
def test_el_servicio_de_respaldo_genera_un_respaldo_valido(con_respaldo):
    s = con_respaldo
    assert s.respaldo.returncode == 0, f"campusia-respaldo.service falló\n{s.respaldo.stdout}\n{s.respaldo.stderr}\n" + s.c.ejecutar(
        "journalctl -u campusia-respaldo.service --no-pager -n 50").stdout
    assert len(s.respaldos) == 1, f"tenía que quedar un respaldo: {s.respaldos}"
    carpeta = s.respaldos[0]
    s.c.ok(f"cd {carpeta} && sha256sum -c respaldo.tar.gz.sha256")
    contenido = s.c.ok(f"tar -tzf {carpeta}/respaldo.tar.gz").split()
    assert "MANIFIESTO.sha256" in contenido
    assert any(x.rstrip("/") == "plataforma/campusia.db" for x in contenido)


@pytest.mark.aceptacion
def test_el_receptor_esta_activo(levantado):
    s = levantado
    assert esperar(lambda: s.c.ejecutar(
        "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9010/_despliegue/webhook").stdout.strip() == "405", 60), \
        "el receptor del webhook no responde en 127.0.0.1:9010"


@pytest.mark.aceptacion
def test_webhook_firmado_desde_cloudflare_llega_al_receptor(levantado):
    codigo, cuerpo = ping(levantado, levantado.secreto_webhook)
    assert codigo == "200", f"el webhook por Caddy respondió {codigo}: {cuerpo[:300]}"
    assert json.loads(cuerpo) == {"resultado": "pong"}


@pytest.mark.aceptacion
def test_caddy_sigue_sirviendo_el_nucleo_desde_cloudflare(levantado):
    codigo, cuerpo = https_por_caddy(levantado, "/salud", IP_CF_LOCAL)
    assert codigo == "200", f"/salud por Caddy respondió {codigo}"
    codigo, cuerpo = https_por_caddy(levantado, "/", IP_CF_LOCAL)
    assert codigo == "200" and "<html" in cuerpo.lower(), "la interfaz no se sirve por Caddy"


@pytest.mark.ataque
def test_webhook_con_firma_falsa_se_rechaza(levantado):
    codigo, cuerpo = ping(levantado, "otro-secreto-" + secrets.token_hex(8))
    assert codigo == "401", f"un webhook con firma falsa respondió {codigo}"


@pytest.mark.ataque
def test_webhook_sin_firma_se_rechaza(levantado):
    codigo, _ = https_por_caddy(levantado, "/_despliegue/webhook", IP_CF_LOCAL, metodo="POST", cuerpo="{}",
                                encabezados={"X-GitHub-Event": "ping", "X-GitHub-Delivery": str(uuid.uuid4())})
    assert codigo == "401"


@pytest.mark.ataque
def test_webhook_desde_un_origen_que_no_es_cloudflare_se_corta(levantado):
    codigo, _ = ping(levantado, levantado.secreto_webhook, origen="127.0.0.1")
    assert codigo in ("000", ""), f"Caddy respondió {codigo} a un webhook desde un origen que no es Cloudflare"


@pytest.mark.ataque
def test_webhook_con_ip_de_cloudflare_falsificada_se_corta(levantado):
    codigo, _ = ping(levantado, levantado.secreto_webhook, origen="127.0.0.1",
                     encabezados_extra={"CF-Connecting-IP": IP_CF_LOCAL, "X-Forwarded-For": IP_CF_LOCAL})
    assert codigo in ("000", "")


@pytest.mark.ataque
@pytest.mark.parametrize("ruta", ["/_despliegue/webhook/", "/_despliegue/webhookx", "/_despliegue/webhook/otra"])
def test_rutas_parecidas_no_llegan_al_receptor(levantado, ruta):
    codigo, cuerpo = ping(levantado, levantado.secreto_webhook, ruta=ruta)
    assert '"resultado"' not in cuerpo, f"{ruta} llegó al receptor"


@pytest.mark.ataque
def test_campusia_no_puede_cambiar_los_guiones_ni_las_unidades_de_respaldo(levantado):
    s = levantado
    rutas = [
        f"{RESPALDO_DIR}/respaldar.sh",
        f"{RESPALDO_DIR}/restaurar.sh",
        RESPALDO_DIR,
        "/etc/systemd/system/campusia-respaldo.service",
        "/etc/systemd/system/campusia-respaldo.timer",
        MODULOS,
        "/etc/localtime",
    ]
    for ruta in rutas:
        assert s.c.ejecutar(f"runuser -u campusia -- test -w {ruta}").returncode != 0, f"campusia puede escribir {ruta}"


@pytest.mark.ataque
def test_el_respaldo_corre_como_campusia_y_nadie_mas_lo_lee(con_respaldo):
    s = con_respaldo
    assert s.respaldos, "no hay respaldo para revisar"
    carpeta = s.respaldos[0]
    assert s.c.ok(f"stat -c '%U %a' {carpeta}").split() == ["campusia", "700"]
    for archivo in ("respaldo.tar.gz", "respaldo.tar.gz.sha256"):
        assert s.c.ok(f"stat -c '%U %a' {carpeta}/{archivo}").split() == ["campusia", "600"]
    assert s.c.ejecutar("runuser -u nobody -- ls /srv/campusia/respaldos").returncode != 0
    assert s.c.ejecutar(f"runuser -u nobody -- cat {carpeta}/respaldo.tar.gz").returncode != 0


@pytest.mark.ataque
def test_el_docker_de_campusia_no_lo_usa_otro_usuario(levantado):
    s = levantado
    u = uid_campusia(s)
    r = s.c.ejecutar(f"runuser -u nobody -- docker -H unix:///run/user/{u}/docker.sock ps")
    assert r.returncode != 0, "otro usuario pudo usar el Docker sin root de campusia"
    r = s.c.ejecutar("runuser -u nobody -- docker -H unix:///var/run/docker.sock ps")
    assert r.returncode != 0, "hay un Docker del sistema accesible"


@pytest.mark.ataque
def test_la_red_de_cursos_no_tiene_salida(levantado):
    s = levantado
    red = red_cursos(s)
    assert red is not None
    assert red["Internal"] is True, "la red de cursos tiene salida a internet"
    assert red.get("Options", {}).get("com.docker.network.bridge.enable_icc") == "false", "los cursos se pueden ver entre sí"


@pytest.mark.ataque
def test_receptor_y_nucleo_solo_en_loopback(levantado):
    s = levantado
    escuchas = s.c.ok("ss -Hltn").split("\n")
    for puerto in ("8080", "9010"):
        locales = [l.split()[3] for l in escuchas if l.strip() and l.split()[3].rsplit(":", 1)[-1] == puerto]
        assert locales, f"nada escucha en {puerto}"
        for local in locales:
            assert local.rsplit(":", 1)[0] in ("127.0.0.1", "[::1]"), f"{puerto} escucha en {local}"
