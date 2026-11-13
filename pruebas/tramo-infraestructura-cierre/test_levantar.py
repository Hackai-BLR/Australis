import hashlib
import io
import json
import os
import re
import secrets
import shlex
import socket
import sqlite3
import ssl
import subprocess
import tarfile
import time

import pytest

from conftest import (
    DESPLIEGUE,
    LEVANTAR,
    REPO,
    SUFIJO,
    construir_imagen,
    correr,
    leer_llamadas,
    levantar_contenedor,
    preparar_envoltorios,
)

CF_V4 = ["173.245.48.0/20", "103.21.244.0/22", "141.101.64.0/18"]
CF_V6 = ["2400:cb00::/32", "2606:4700::/32"]
CLAVES_VAULT = {
    "vault_brevo_api_key": "BREVO_API_KEY",
    "vault_claude_code_oauth_token": "CLAUDE_CODE_OAUTH_TOKEN",
    "vault_turnstile_clave_sitio": "TURNSTILE_SITE_KEY",
    "vault_turnstile_clave_secreta": "TURNSTILE_SECRET",
    "vault_secreto_sesion": "SESSION_SECRET",
    "vault_secreto_firma": "SECRETO_FIRMA",
    "vault_secreto_webhook": "SECRETO_WEBHOOK",
}
PASOS = [("1", "verificar"), ("2", "ansible"), ("3", "desplegar"), ("4", "restaurar"), ("5", "dns")]
DIR = "/srv/campusia/despliegue"
INSTALADOR = "/usr/local/sbin/campusia-instalar"
DISTROS = {"debian13": ("debian", "13"), "ubuntu2404": ("ubuntu", "24.04")}

COMPILAR = """#!/usr/bin/env bash
set -euo pipefail
mkdir -p compilado/bin interfaz
install -m 0755 /srv/prueba/compilado/campusia-nucleo compilado/bin/campusia-nucleo
rm -rf interfaz/dist
cp -r /srv/prueba/compilado/dist interfaz/dist
mkdir -p plantilla-curso/vendor
rm -f plantilla-curso/vendor/campusia-sdk-*.tgz
cp /srv/prueba/compilado/vendor/campusia-sdk-*.tgz plantilla-curso/vendor/
rm -rf sdk/dist
cp -r /srv/prueba/compilado/sdk-dist sdk/dist
"""


class Servidor:
    pass


def sha256(datos):
    return hashlib.sha256(datos).hexdigest()


def armar_respaldo(carpeta, marca, alterar_manifiesto=False):
    carpeta.mkdir(parents=True)
    contenido = carpeta / "contenido"
    (contenido / "plataforma").mkdir(parents=True)
    base = contenido / "plataforma" / "campusia.db"
    con = sqlite3.connect(base)
    con.execute("CREATE TABLE marca_respaldo (valor TEXT NOT NULL)")
    con.execute("INSERT INTO marca_respaldo (valor) VALUES (?)", (marca,))
    con.commit()
    con.close()
    suma = sha256(base.read_bytes())
    if alterar_manifiesto:
        suma = sha256(b"otra cosa")
    (contenido / "MANIFIESTO.sha256").write_text(f"{suma}  plataforma/campusia.db\n")
    tar = carpeta / "respaldo.tar.gz"
    r = correr(["tar", "-C", str(contenido), "--sort=name", "--owner=0", "--group=0", "--numeric-owner",
                "-czf", str(tar), "MANIFIESTO.sha256", "plataforma"])
    assert r.returncode == 0, r.stderr
    (carpeta / "respaldo.tar.gz.sha256").write_text(f"{sha256(tar.read_bytes())}  respaldo.tar.gz\n")
    r = correr(["rm", "-rf", str(contenido)])
    return carpeta, sha256(tar.read_bytes())


def certificado(d):
    r = correr([
        "openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
        "-keyout", str(d / "origen.key"), "-out", str(d / "origen.pem"), "-days", "30",
        "-subj", "/CN=campusia.tech", "-addext", "subjectAltName=DNS:campusia.tech,DNS:*.campusia.tech",
    ])
    assert r.returncode == 0, r.stderr
    clave = (d / "origen.key").read_text()
    pem = (d / "origen.pem").read_text()
    return clave, pem, sha256(ssl.PEM_cert_to_DER_cert(pem))


def esperar_puerto(ip, puerto, segundos=60):
    limite = time.time() + segundos
    while time.time() < limite:
        try:
            with socket.create_connection((ip, puerto), timeout=2):
                return
        except OSError:
            time.sleep(1)
    raise AssertionError(f"{ip}:{puerto} no respondió")


def conecta(ip, puerto, espera=3):
    try:
        with socket.create_connection((ip, puerto), timeout=espera):
            return True
    except OSError:
        return False


def entorno_levantar(s, respaldo):
    entorno = {k: v for k, v in os.environ.items() if not k.startswith(("CAMPUSIA_", "CLOUDFLARE_", "TOFU_", "ANSIBLE_VAULT", "TF_VAR_"))}
    entorno.update({
        "PATH": f"{s.envoltorios}{os.pathsep}{os.environ['PATH']}",
        "LLAMADAS_REGISTRO": str(s.registro),
        "ANSIBLE_NOCOLOR": "1",
        "CAMPUSIA_IP": s.ip,
        "CAMPUSIA_SSH_USUARIO": "root",
        "CAMPUSIA_SSH_CLAVE": str(s.clave_ssh),
        "CAMPUSIA_KNOWN_HOSTS": str(s.dir / "known_hosts"),
        "CLOUDFLARE_API_TOKEN": s.token,
        "TOFU_FRASE_ESTADO": s.frase,
        "ANSIBLE_VAULT_CONTRASENA": s.contrasena_vault,
        "CAMPUSIA_VAULT_ARCHIVO": str(s.vault),
        "CAMPUSIA_TFVARS": str(s.tfvars),
        "CAMPUSIA_ANSIBLE_EXTRA": str(s.extra),
        "CAMPUSIA_RESPALDO": str(respaldo),
    })
    return entorno


def correr_levantar(s, respaldo):
    return correr(["bash", str(LEVANTAR)], cwd=s.dir, entorno_base=entorno_levantar(s, respaldo), timeout=4800, combinar=True)


def lineas_registro(s):
    r = s.c.ejecutar(f"cat {DIR}/registro.log")
    return [json.loads(l) for l in r.stdout.splitlines() if l.strip()] if r.returncode == 0 else []


def previos(s):
    r = s.c.ejecutar("ls -d /srv/campusia/previo-* 2>/dev/null")
    return sorted(r.stdout.split())


def marca_en_base(s):
    r = s.c.ejecutar("sqlite3 /srv/campusia/datos/campusia.db 'SELECT valor FROM marca_respaldo'")
    return r.stdout.strip() if r.returncode == 0 else None


def sano(s):
    return s.c.ejecutar("curl -fsS --max-time 5 http://127.0.0.1:8080/salud").returncode == 0


def esperar_sano(s, segundos=60):
    limite = time.time() + segundos
    while time.time() < limite:
        if sano(s):
            return True
        time.sleep(1)
    return False


def suma_remota(s, ruta):
    return s.c.ok(f"sha256sum {shlex.quote(ruta)}").split()[0]


@pytest.fixture(scope="module", params=list(DISTROS))
def servidor(request, tmp_sesion, artefactos_listos, instantanea, origen_git):
    assert LEVANTAR.is_file(), "falta infraestructura/levantar.sh"
    dist = request.param
    s = Servidor()
    s.dist = dist
    s.commit = instantanea.commit
    s.origen = origen_git
    s.dir = tmp_sesion / f"levantar-{dist}"
    s.dir.mkdir()
    imagen = construir_imagen(dist, f"campusia-pruebas-cierre-{dist}")
    c = levantar_contenedor(imagen, f"campusia-cierre-{dist}-{SUFIJO}")
    s.c = c
    try:
        r = correr(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "prueba-cierre", "-f", str(s.dir / "clave")])
        assert r.returncode == 0, r.stderr
        s.clave_ssh = s.dir / "clave"
        publica = (s.dir / "clave.pub").read_text().strip()
        c.ok("install -d -m 700 /root/.ssh && cat > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys", entrada=publica + "\n")
        c.ok("systemctl start ssh || systemctl start ssh.socket")
        s.ip = c.ip()
        esperar_puerto(s.ip, 22)

        c.ok("install -d -m 755 /srv/prueba /srv/prueba/compilado")
        c.copiar(artefactos_listos.binario, "/srv/prueba/compilado/campusia-nucleo")
        c.copiar(artefactos_listos.interfaz, "/srv/prueba/compilado/dist")
        c.copiar(artefactos_listos.fuentes / "plantilla-curso" / "vendor", "/srv/prueba/compilado/vendor")
        c.copiar(artefactos_listos.fuentes / "sdk" / "dist", "/srv/prueba/compilado/sdk-dist")
        c.ok("cat > /srv/prueba/compilar.sh", entrada=COMPILAR)
        c.ok("cat > /srv/prueba/espacio.sh", entrada=f'#!/usr/bin/env bash\necho "$COMMIT" >> {DIR}/espacio-construido\n')
        c.ok("chown -R root:root /srv/prueba && chmod -R a+rX /srv/prueba && chmod 755 /srv/prueba/compilar.sh /srv/prueba/espacio.sh /srv/prueba/compilado/campusia-nucleo")
        s.suma_binario = sha256(artefactos_listos.binario.read_bytes())
        s.suma_index = sha256((artefactos_listos.interfaz / "index.html").read_bytes())

        s.clave_origen, s.pem_origen, s.huella_origen = certificado(s.dir)
        s.valores_vault = {k: f"prueba-{k.replace('_', '-')}-{secrets.token_hex(16)}" for k in CLAVES_VAULT}
        datos_vault = dict(s.valores_vault)
        datos_vault["vault_origen_clave"] = s.clave_origen
        datos_vault["vault_origen_certificado"] = s.pem_origen
        plano = s.dir / "secretos.plano.yml"
        plano.write_text(json.dumps(datos_vault))
        s.contrasena_vault = "vault-" + secrets.token_hex(20)
        archivo_contrasena = s.dir / "vault-pass"
        archivo_contrasena.write_text(s.contrasena_vault + "\n")
        s.vault = s.dir / "secretos.vault.yml"
        r = correr(["ansible-vault", "encrypt", "--vault-password-file", str(archivo_contrasena),
                    "--output", str(s.vault), str(plano)])
        assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
        plano.unlink()
        archivo_contrasena.unlink()

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
                "DESPLIEGUE_ESPACIO": "bash /srv/prueba/espacio.sh",
                "DESPLIEGUE_SALUD_ESPERA": "90",
            },
        }))
        s.marca = "marca-" + secrets.token_hex(8)
        s.respaldo, s.suma_respaldo = armar_respaldo(s.dir / "respaldo", s.marca)
        s.envoltorios = preparar_envoltorios(s.dir / "bin")
        s.registro = s.dir / "llamadas.jsonl"
        s.secretos = [s.token, s.frase, s.contrasena_vault] + list(s.valores_vault.values())
        s.secretos += [l for l in s.clave_origen.splitlines() if l and not l.startswith("-----")]

        s.estado_repo_antes = correr(["git", "status", "--porcelain", "--untracked-files=all"], cwd=REPO).stdout
        s.primera = correr_levantar(s, s.respaldo)
        s.segunda = None
        s.tercera = None
        if s.primera.returncode == 0:
            s.registro_tras_primera = len(lineas_registro(s))
            s.previos_tras_primera = previos(s)
            s.segunda = correr_levantar(s, s.respaldo)
            s.registro_tras_segunda = len(lineas_registro(s))
            s.previos_tras_segunda = previos(s)
            if s.segunda.returncode == 0:
                s.respaldo_alterado, _ = armar_respaldo(s.dir / "respaldo-alterado", "marca-alterada", alterar_manifiesto=True)
                s.marca_antes_tercera = marca_en_base(s)
                s.tercera = correr_levantar(s, s.respaldo_alterado)
                s.previos_tras_tercera = previos(s)
        s.estado_repo_despues = correr(["git", "status", "--porcelain", "--untracked-files=all"], cwd=REPO).stdout
        s.salidas = [x.stdout for x in (s.primera, s.segunda, s.tercera) if x is not None]
        yield s
    finally:
        c.borrar()


@pytest.fixture(scope="module")
def levantado(servidor):
    r = servidor.primera
    assert r.returncode == 0, f"levantar.sh falló en {servidor.dist}\n{r.stdout[-8000:]}"
    return servidor


@pytest.fixture(scope="module")
def dos_veces(levantado):
    r = levantado.segunda
    assert r is not None and r.returncode == 0, f"la segunda corrida de levantar.sh falló\n{(r.stdout if r else '')[-8000:]}"
    return levantado


def pasos(salida):
    return re.findall(r"(?m)^==> \[(\d)/5\] (\S+)\s*$", salida)


def recap_changed(salida, ip):
    m = re.findall(rf"(?m)^{re.escape(ip)}\s*:\s*ok=(\d+)\s+changed=(\d+)\s+unreachable=(\d+)\s+failed=(\d+)", salida)
    assert m, f"no se encontró el PLAY RECAP de {ip}\n{salida[-4000:]}"
    return [int(x) for x in m[-1]]


def entorno_archivo(texto):
    valores = {}
    for linea in texto.splitlines():
        linea = linea.strip()
        if not linea or linea.startswith("#") or "=" not in linea:
            continue
        k, v = linea.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        valores[k.strip()] = v
    return valores


@pytest.mark.aceptacion
def test_levantar_corre_los_pasos_en_orden(levantado):
    salida = levantado.primera.stdout
    assert pasos(salida) == PASOS, salida[-4000:]
    assert [l for l in salida.splitlines() if l.strip()][-1].strip() == "levantar: listo"
    assert "PLAY RECAP" in salida
    assert re.search(rf"(?m)^desplegar: {levantado.commit}\s*$", salida), "desplegar tiene que informar el commit desplegado"
    assert re.search(rf"(?m)^dns: {re.escape(levantado.ip)}\s*$", salida)


@pytest.mark.aceptacion
def test_distribucion_esperada(levantado):
    datos = entorno_archivo(levantado.c.ok("cat /etc/os-release"))
    ident, version = DISTROS[levantado.dist]
    assert datos["ID"] == ident and datos["VERSION_ID"] == version


@pytest.mark.aceptacion
def test_nucleo_e_interfaz_desplegados_y_sanos(levantado):
    s = levantado
    assert esperar_sano(s), "el núcleo no responde /salud"
    assert s.c.ok("systemctl is-active campusia-nucleo.service").strip() == "active"
    assert s.c.ok("systemctl is-enabled campusia-nucleo.service").strip() == "enabled"
    assert suma_remota(s, "/usr/local/bin/campusia-nucleo") == s.suma_binario
    assert suma_remota(s, "/srv/campusia/interfaz/index.html") == s.suma_index
    assert s.c.ok(f"cat {DIR}/actual").strip() == s.commit
    usuario = s.c.ok("systemctl show -p User --value campusia-nucleo.service").strip()
    assert usuario == "campusia"


@pytest.mark.aceptacion
def test_plantilla_sdk_y_espacio_desplegados(levantado):
    s = levantado
    plataforma = "/srv/campusia/plataforma"
    s.c.ok(f"compgen -G '{plataforma}/plantilla-curso/vendor/campusia-sdk-*.tgz' >/dev/null")
    s.c.ok(f"test -f {plataforma}/sdk/dist/index.js && test -f {plataforma}/espacio-trabajo/Containerfile")
    assert s.c.ok(f"stat -c '%U %G' {plataforma}/plantilla-curso").split() == ["root", "campusia"]
    assert s.c.ok(f"cat {DIR}/espacio-construido").split() == [s.commit], "el primer despliegue tiene que construir la imagen del espacio"


@pytest.mark.aceptacion
def test_registro_del_primer_despliegue(levantado):
    registro = lineas_registro(levantado)
    assert registro, "registro.log vacío"
    assert registro[-1]["commit"] == levantado.commit
    assert registro[-1]["resultado"] == "exito"


@pytest.mark.aceptacion
def test_unidad_y_caddyfile_de_main_tal_cual(levantado):
    s = levantado
    assert s.c.ok("cat /etc/systemd/system/campusia-nucleo.service") == (DESPLIEGUE / "campusia-nucleo.service").read_text()
    assert s.c.ok("cat /etc/caddy/Caddyfile") == (DESPLIEGUE / "Caddyfile").read_text()
    s.c.ok("caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile")
    assert s.c.ok("systemctl is-active caddy").strip() == "active"


@pytest.mark.aceptacion
def test_caddy_del_repositorio_oficial(levantado):
    s = levantado
    version = s.c.ok("caddy version").strip()
    m = re.match(r"v2\.(\d+)\.", version)
    assert m and int(m.group(1)) >= 8, f"Caddy tiene que ser 2.8 o posterior (repositorio oficial), no {version}"
    fuentes = s.c.ok("grep -rl 'dl.cloudsmith.io/public/caddy/stable' /etc/apt/sources.list.d/ || true").split()
    assert fuentes, "falta la fuente del repositorio oficial de Caddy"
    for f in fuentes:
        texto = s.c.ok(f"cat {shlex.quote(f)}")
        assert re.search(r"(?i)signed-by", texto), f"{f} tiene que usar signed-by"
    assert "dl.cloudsmith.io" in s.c.ok("apt-cache policy caddy")


@pytest.mark.aceptacion
def test_certificado_de_origen_del_vault_servido_por_caddy(levantado):
    s = levantado
    assert s.c.ok("stat -c '%U %G %a' /etc/caddy/certs/origen.key").split() == ["root", "caddy", "640"]
    assert s.c.ok("stat -c '%U %G %a' /etc/caddy/certs/origen.pem").split() == ["root", "caddy", "644"]
    huella = s.c.ok(
        "openssl s_client -connect 127.0.0.1:443 -servername campusia.tech </dev/null 2>/dev/null "
        "| openssl x509 -outform DER | sha256sum"
    ).split()[0]
    assert huella == s.huella_origen


@pytest.mark.aceptacion
def test_docker_sin_root_y_sin_podman(levantado):
    s = levantado
    for paquete in ("podman", "podman-docker", "docker.io"):
        r = s.c.ejecutar(f"dpkg-query -W -f='${{Status}}' {paquete}")
        assert "install ok installed" not in r.stdout, f"{paquete} tiene que quedar desinstalado"
    s.c.ok("dpkg -s docker-ce docker-ce-cli containerd.io docker-ce-rootless-extras uidmap dbus-user-session slirp4netns >/dev/null")
    for unidad in ("docker.service", "docker.socket"):
        assert s.c.ejecutar(f"systemctl is-enabled {unidad}").stdout.strip() != "enabled"
        assert s.c.ejecutar(f"systemctl is-active {unidad}").stdout.strip() != "active"
    assert "docker" not in s.c.ok("id -nG campusia").split()
    assert "Delegate=cpu cpuset io memory pids" in s.c.ok("cat /etc/systemd/system/user@.service.d/delegate.conf")
    uid = s.c.ok("id -u campusia").strip()
    drop = s.c.ok("cat /etc/systemd/system/campusia-nucleo.service.d/docker.conf")
    assert f"DOCKER_HOST=unix:///run/user/{uid}/docker.sock" in drop
    assert f"XDG_RUNTIME_DIR=/run/user/{uid}" in drop
    assert f"user@{uid}.service" in drop


@pytest.mark.aceptacion
def test_campusia_env_completo_con_los_nombres_del_nucleo(levantado):
    s = levantado
    assert s.c.ok("stat -c '%U %G %a' /srv/campusia/config/campusia.env").split() == ["campusia", "campusia", "600"]
    assert s.c.ok("stat -c '%U %G %a' /srv/campusia/config").split() == ["campusia", "campusia", "750"]
    valores = entorno_archivo(s.c.ok("cat /srv/campusia/config/campusia.env"))
    ejemplo = entorno_archivo((DESPLIEGUE / "campusia.env.ejemplo").read_text())
    for clave in ejemplo:
        assert clave in valores, f"falta {clave} en campusia.env"
    for clave_vault, variable in CLAVES_VAULT.items():
        assert valores.get(variable) == s.valores_vault[clave_vault], f"{variable} no sale del Vault"
    assert "completar" not in valores.values()
    assert valores["ENTORNO"] == "produccion"
    assert valores["DOMINIO_BASE"] == "campusia.tech"
    assert valores["PROVEEDOR_EMAIL"] == "brevo"


@pytest.mark.aceptacion
def test_despliegue_continuo_instalado(levantado):
    s = levantado
    s.c.ok(f"test -x {DIR}/bin/desplegar.sh && test -x {DIR}/bin/limpiar.sh && test -f {DIR}/bin/receptor.py")
    s.c.ok("test -L /srv/campusia/.config/systemd/user/timers.target.wants/campusia-despliegue.timer")
    assert s.c.ok("stat -c '%U %G %a' /srv/campusia/config/continuo.env").split() == ["campusia", "campusia", "600"]
    valores = entorno_archivo(s.c.ok("cat /srv/campusia/config/continuo.env"))
    assert valores.get("DESPLIEGUE_ORIGEN") == s.origen
    assert valores.get("DESPLIEGUE_COMPILAR") == "bash /srv/prueba/compilar.sh"


@pytest.mark.aceptacion
def test_instalador_con_privilegios_instalado(levantado):
    s = levantado
    assert s.c.ok(f"stat -c '%U %G %a' {INSTALADOR}").split() == ["root", "root", "755"]
    assert s.c.ok("stat -c '%U %G %a' /etc/sudoers.d/campusia-instalar").split() == ["root", "root", "440"]
    s.c.ok("visudo -c")
    assert s.c.ok("stat -c '%U %G %a' /etc/campusia/instalar.env").split() == ["root", "root", "644"]
    valores = entorno_archivo(s.c.ok("cat /etc/campusia/instalar.env"))
    assert valores.get("INSTALAR_ORIGEN") == s.origen
    assert valores.get("INSTALAR_RAMA") == "main"
    assert s.c.ok("stat -c '%U %a' /var/lib/campusia-instalar").split() == ["root", "700"]


@pytest.mark.aceptacion
def test_restauracion_del_respaldo(levantado):
    s = levantado
    assert re.search(r"(?m)^restaurar: ", s.primera.stdout)
    assert marca_en_base(s) == s.marca, "la base restaurada no tiene la marca del respaldo"
    assert len(s.previos_tras_primera) == 1, f"tenía que quedar una carpeta previo-*: {s.previos_tras_primera}"
    assert s.c.ok("cat /srv/campusia/config/restaurado").strip() == s.suma_respaldo
    assert s.c.ok("stat -c '%U %a' /srv/campusia/config/restaurado").split() == ["root", "600"]
    assert s.c.ok("stat -c '%U %G' /srv/campusia/datos/campusia.db").split() == ["campusia", "campusia"]
    assert esperar_sano(s)


@pytest.mark.aceptacion
def test_dns_con_opentofu_hacia_la_ip_nueva(levantado):
    s = levantado
    llamadas = [l for l in leer_llamadas(s.registro) if l["programa"] == "tofu"]
    assert llamadas, "levantar.sh no llamó a tofu"
    indices_init = [i for i, l in enumerate(llamadas) if "init" in l["argv"]]
    indices_apply = [i for i, l in enumerate(llamadas) if "apply" in l["argv"]]
    assert indices_init and indices_apply and indices_init[0] < indices_apply[0], "tiene que correr tofu init antes de tofu apply"
    aplicar = llamadas[indices_apply[0]]
    texto = " ".join(aplicar["argv"])
    assert "-auto-approve" in aplicar["argv"]
    assert "-input=false" in aplicar["argv"]
    assert f"ip_servidor={s.ip}" in texto
    assert 'cloudflare_dns_record.registros["apex"]' in texto
    assert 'cloudflare_dns_record.registros["comodin"]' in texto
    assert str(s.tfvars) in texto
    carpeta = [a for a in aplicar["argv"] if a.startswith("-chdir=")]
    destino = carpeta[0].split("=", 1)[1] if carpeta else aplicar["cwd"]
    destino = os.path.join(aplicar["cwd"], destino)
    assert os.path.realpath(destino) == str((REPO / "infraestructura" / "cloudflare").resolve())
    assert aplicar["entorno"].get("TF_VAR_cloudflare_api_token") == s.token
    assert aplicar["entorno"].get("TF_VAR_frase_estado") == s.frase


@pytest.mark.aceptacion
def test_segunda_corrida_idempotente(dos_veces):
    s = dos_veces
    salida = s.segunda.stdout
    assert pasos(salida) == PASOS
    ok, changed, unreachable, failed = recap_changed(salida, s.ip)
    assert changed == 0 and failed == 0 and unreachable == 0, f"la segunda corrida de Ansible tuvo cambios: changed={changed}"
    assert s.registro_tras_segunda == s.registro_tras_primera, "la segunda corrida no tenía que desplegar de nuevo"
    assert re.search(r"(?m)^restaurar: ya restaurado\s*$", salida)
    assert s.previos_tras_segunda == s.previos_tras_primera, "la segunda corrida no tenía que restaurar de nuevo"
    assert marca_en_base(s) == s.marca
    assert esperar_sano(s)


@pytest.mark.ataque
def test_secretos_fuera_de_la_salida(levantado):
    for salida in levantado.salidas:
        for secreto in levantado.secretos:
            assert secreto not in salida, "un secreto apareció en la salida de levantar.sh"


@pytest.mark.ataque
def test_secretos_fuera_de_los_argumentos(levantado):
    llamadas = leer_llamadas(levantado.registro)
    assert any(l["programa"] == "ansible-playbook" for l in llamadas)
    assert any(l["programa"] == "ssh" for l in llamadas)
    for l in llamadas:
        texto = "\0".join(l["argv"])
        for secreto in levantado.secretos:
            assert secreto not in texto, f"un secreto apareció en los argumentos de {l['programa']}"


@pytest.mark.ataque
def test_puertos_web_y_internos_cerrados_desde_afuera(levantado):
    for puerto in (80, 443, 8080, 9010):
        assert not conecta(levantado.ip, puerto), f"el puerto {puerto} acepta conexiones de un origen que no es Cloudflare"


@pytest.mark.ataque
def test_caddy_corta_origenes_que_no_son_cloudflare(levantado):
    r = levantado.c.ejecutar(
        "curl -sk --max-time 5 -o /dev/null -w '%{http_code}' --resolve campusia.tech:443:127.0.0.1 https://campusia.tech/salud"
    )
    assert r.returncode != 0 or r.stdout.strip() in ("000", ""), f"Caddy respondió {r.stdout} a un origen que no es Cloudflare"


@pytest.mark.ataque
def test_ssh_no_acepta_contrasenas(levantado):
    s = levantado
    config = s.c.ok("sshd -T")
    assert re.search(r"(?m)^passwordauthentication no$", config)
    assert re.search(r"(?m)^kbdinteractiveauthentication no$", config)
    assert re.search(r"(?m)^permitrootlogin (without-password|prohibit-password)$", config)
    r = correr(["ssh", "-o", "BatchMode=yes", "-o", "PubkeyAuthentication=no", "-o", "PreferredAuthentications=password,keyboard-interactive",
                "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=5",
                f"root@{s.ip}", "true"], timeout=30)
    assert r.returncode != 0


@pytest.mark.ataque
def test_campusia_solo_puede_usar_sudo_para_el_instalador(levantado):
    s = levantado
    assert s.c.ejecutar("sudo -n true", usuario="campusia").returncode != 0
    assert s.c.ejecutar("sudo -n /bin/bash -c id", usuario="campusia").returncode != 0
    assert s.c.ejecutar("sudo -n -u root /usr/bin/env id", usuario="campusia").returncode != 0
    listado = s.c.ok("sudo -l -U campusia")
    comandos = [l.strip() for l in listado.splitlines() if re.match(r"^\s+\(", l)]
    assert comandos, listado
    for linea in comandos:
        assert linea.endswith(INSTALADOR), f"campusia tiene una regla de sudo de más: {linea}"


@pytest.mark.ataque
@pytest.mark.parametrize("argumentos", [
    "",
    "../../../etc",
    "'$(touch /tmp/campusia-inyectado)'",
    "'a; touch /tmp/campusia-inyectado'",
    "a" * 40,
    "0" * 41,
    "--help",
    "COMMIT_MAYUSCULAS",
    "COMMIT otro",
])
def test_instalador_rechaza_argumentos_invalidos(levantado, argumentos):
    s = levantado
    argumentos = argumentos.replace("COMMIT_MAYUSCULAS", s.commit.upper()).replace("COMMIT", s.commit)
    antes = suma_remota(s, "/usr/local/bin/campusia-nucleo")
    r = s.c.ejecutar(f"sudo -n {INSTALADOR} {argumentos}", usuario="campusia", timeout=300)
    assert r.returncode != 0, f"el instalador aceptó: {argumentos}\n{r.stdout}\n{r.stderr}"
    assert s.c.ejecutar("test -e /tmp/campusia-inyectado").returncode != 0
    assert suma_remota(s, "/usr/local/bin/campusia-nucleo") == antes


@pytest.mark.ataque
def test_instalador_rechaza_un_commit_no_publicado(levantado):
    s = levantado
    antes = suma_remota(s, "/usr/local/bin/campusia-nucleo")
    guion = f"""
set -euo pipefail
t=$(mktemp -d)
git clone -q {DIR}/repo.git "$t/w"
cd "$t/w"
printf '#!/bin/bash\\ntouch /root/atacado\\nexit 0\\n' > despliegue/instalar.sh
git -c user.email=a@ejemplo.com -c user.name=a commit -qam ataque
sha=$(git rev-parse HEAD)
git push -q -f origin HEAD:refs/heads/main
mkdir -p {DIR}/fuentes/$sha
cp -a {DIR}/fuentes/{s.commit}/. {DIR}/fuentes/$sha/
cp despliegue/instalar.sh {DIR}/fuentes/$sha/despliegue/instalar.sh
echo $sha
"""
    sha = s.c.ok(guion, usuario="campusia").strip().splitlines()[-1]
    try:
        r = s.c.ejecutar(f"sudo -n {INSTALADOR} {sha}", usuario="campusia", timeout=600)
        assert r.returncode != 0, f"el instalador instaló un commit que no está publicado\n{r.stdout}\n{r.stderr}"
        assert s.c.ejecutar("test -e /root/atacado").returncode != 0, "se ejecutó como root código que no está publicado"
        assert suma_remota(s, "/usr/local/bin/campusia-nucleo") == antes
    finally:
        s.c.ejecutar(f"git --git-dir={DIR}/repo.git fetch -q --prune origin; rm -rf {DIR}/fuentes/{sha}", usuario="campusia")
    assert esperar_sano(s)


@pytest.mark.ataque
def test_instalador_no_ejecuta_archivos_alterados_en_las_fuentes(levantado):
    s = levantado
    fuentes = f"{DIR}/fuentes/{s.commit}"
    s.c.ok(
        f"cp {fuentes}/despliegue/instalar.sh /tmp/instalar.orig && cp {fuentes}/despliegue/Caddyfile /tmp/Caddyfile.orig "
        f"&& printf '#!/bin/bash\\ntouch /root/atacado2\\nexit 0\\n' > {fuentes}/despliegue/instalar.sh "
        f"&& printf ':80 {{\\n\\treverse_proxy 127.0.0.1:8080\\n}}\\n' > {fuentes}/despliegue/Caddyfile",
        usuario="campusia",
    )
    try:
        s.c.ejecutar(f"sudo -n {INSTALADOR} {s.commit}", usuario="campusia", timeout=600)
        assert s.c.ejecutar("test -e /root/atacado2").returncode != 0, "el instalador ejecutó como root un archivo de campusia"
        assert s.c.ok("cat /etc/caddy/Caddyfile") == (DESPLIEGUE / "Caddyfile").read_text()
    finally:
        s.c.ejecutar(f"cp /tmp/instalar.orig {fuentes}/despliegue/instalar.sh; cp /tmp/Caddyfile.orig {fuentes}/despliegue/Caddyfile", usuario="campusia")
    assert esperar_sano(s)


@pytest.mark.ataque
@pytest.mark.parametrize("caso", ["enlace_en_interfaz", "binario_enlace", "interfaz_fuera"])
def test_instalador_rechaza_enlaces_en_los_artefactos(levantado, caso):
    s = levantado
    fuentes = f"{DIR}/fuentes/{s.commit}"
    preparar = {
        "enlace_en_interfaz": f"ln -s /etc/shadow {fuentes}/interfaz/dist/robado",
        "binario_enlace": f"mv {fuentes}/compilado/bin/campusia-nucleo /tmp/nucleo.bak && ln -s /bin/bash {fuentes}/compilado/bin/campusia-nucleo",
        "interfaz_fuera": f"mv {fuentes}/interfaz/dist /tmp/dist.bak && mkdir -p /tmp/falsa && cp -r /tmp/dist.bak/. /tmp/falsa/ && ln -s /tmp/falsa {fuentes}/interfaz/dist",
    }[caso]
    deshacer = {
        "enlace_en_interfaz": f"rm -f {fuentes}/interfaz/dist/robado",
        "binario_enlace": f"rm -f {fuentes}/compilado/bin/campusia-nucleo && mv /tmp/nucleo.bak {fuentes}/compilado/bin/campusia-nucleo",
        "interfaz_fuera": f"rm -f {fuentes}/interfaz/dist && mv /tmp/dist.bak {fuentes}/interfaz/dist && rm -rf /tmp/falsa",
    }[caso]
    antes = suma_remota(s, "/usr/local/bin/campusia-nucleo")
    s.c.ok(preparar, usuario="campusia")
    try:
        r = s.c.ejecutar(f"sudo -n {INSTALADOR} {s.commit}", usuario="campusia", timeout=600)
        assert r.returncode != 0, f"el instalador aceptó artefactos con enlaces ({caso})\n{r.stdout}\n{r.stderr}"
        assert s.c.ejecutar("test -e /srv/campusia/interfaz/robado || test -L /srv/campusia/interfaz/robado").returncode != 0
        assert suma_remota(s, "/usr/local/bin/campusia-nucleo") == antes
    finally:
        s.c.ejecutar(deshacer, usuario="campusia")
    assert esperar_sano(s)


@pytest.mark.ataque
def test_respaldo_alterado_no_se_restaura(dos_veces):
    s = dos_veces
    r = s.tercera
    assert r is not None
    assert r.returncode != 0, "levantar.sh aceptó un respaldo alterado"
    assert "levantar: falló el paso restaurar" in r.stdout, r.stdout[-4000:]
    assert "==> [5/5]" not in r.stdout
    assert marca_en_base(s) == s.marca_antes_tercera == s.marca, "un respaldo alterado cambió los datos"
    assert s.previos_tras_tercera == s.previos_tras_segunda
    assert esperar_sano(s)


@pytest.mark.ataque
def test_levantar_no_deja_archivos_en_el_repo(levantado):
    assert levantado.estado_repo_antes == levantado.estado_repo_despues, "levantar.sh dejó archivos o cambios en el repo"
    for relativa in correr(["git", "ls-files", "--others", "--exclude-standard"], cwd=REPO).stdout.split():
        ruta = REPO / relativa
        if ruta.is_file():
            try:
                assert levantado.ip not in ruta.read_text(), f"{relativa} tiene la IP del servidor"
            except UnicodeDecodeError:
                pass
