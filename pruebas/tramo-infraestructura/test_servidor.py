import hashlib
import ipaddress
import json
import re
import secrets
import socket
import ssl
import time

import pytest

from conftest import SERVIDOR, SUFIJO, correr, levantar_contenedor

CF_V4 = ["173.245.48.0/20", "103.21.244.0/22", "141.101.64.0/18"]
CF_V6 = ["2400:cb00::/32", "2606:4700::/32"]
SWAP_MB = 64
CLAVES_VAULT = {
    "vault_brevo_api_key": "BREVO_API_KEY",
    "vault_claude_code_oauth_token": "CLAUDE_CODE_OAUTH_TOKEN",
    "vault_turnstile_clave_sitio": "TURNSTILE_SITE_KEY",
    "vault_turnstile_clave_secreta": "TURNSTILE_SECRET",
    "vault_secreto_sesion": "SESSION_SECRET",
    "vault_secreto_firma": "SECRETO_FIRMA",
    "vault_secreto_webhook": "SECRETO_WEBHOOK",
}
RESUMEN = re.compile(r"campusia-prueba\s*:\s*ok=(\d+)\s+changed=(\d+)\s+unreachable=(\d+)\s+failed=(\d+)")
ACTUALIZADOR = "/usr/local/sbin/campusia-cloudflare-ips"


class Servidor:
    pass


def resumen(salida):
    m = RESUMEN.findall(salida)
    assert m, f"no se encontró el resumen de Ansible\n{salida[-3000:]}"
    ok, changed, unreachable, failed = map(int, m[-1])
    return {"ok": ok, "changed": changed, "unreachable": unreachable, "failed": failed}


def tareas_cambiadas(salida):
    tareas = []
    actual = None
    for linea in salida.splitlines():
        m = re.match(r"^TASK \[(.*)\]", linea)
        if m:
            actual = m.group(1)
        elif linea.startswith("changed:") and actual:
            tareas.append(actual)
    return tareas


def huella_pem(pem):
    return hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest()


def conecta(ip, puerto, espera=3):
    try:
        with socket.create_connection((ip, puerto), timeout=espera):
            return True
    except OSError:
        return False


def huella_remota(ip, puerto=443, espera=5):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with socket.create_connection((ip, puerto), timeout=espera) as crudo:
        with ctx.wrap_socket(crudo, server_hostname="campusia.tech") as s:
            return hashlib.sha256(s.getpeercert(True)).hexdigest()


def correr_playbook(inventario, secretos_archivo):
    return correr(
        ["ansible-playbook", "-i", str(inventario), "sitio.yml", "-e", f"@{secretos_archivo}"],
        cwd=SERVIDOR,
        env={"ANSIBLE_HOST_KEY_CHECKING": "False", "ANSIBLE_NOCOLOR": "1", "ANSIBLE_RETRY_FILES_ENABLED": "False"},
        timeout=2400,
    )


@pytest.fixture(scope="module")
def servidor(imagen_debian, tmp_sesion):
    assert (SERVIDOR / "sitio.yml").is_file(), "falta infraestructura/servidor/sitio.yml"
    s = Servidor()
    d = tmp_sesion / "servidor"
    d.mkdir()
    s.dir = d
    c = levantar_contenedor(imagen_debian, f"campusia-servidor-{SUFIJO}")
    s.c = c
    try:
        r = correr(
            ["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
             "-keyout", str(d / "origen.key"), "-out", str(d / "origen.pem"), "-days", "30",
             "-subj", "/CN=campusia.tech", "-addext", "subjectAltName=DNS:campusia.tech,DNS:*.campusia.tech"]
        )
        assert r.returncode == 0, r.stderr
        c.ok("mkdir -p /etc/caddy/certs")
        c.copiar(d / "origen.key", "/etc/caddy/certs/origen.key")
        c.copiar(d / "origen.pem", "/etc/caddy/certs/origen.pem")
        c.ok("chown root:root /etc/caddy/certs/origen.*; chmod 600 /etc/caddy/certs/origen.key")
        s.sumas_cert = c.ok("sha256sum /etc/caddy/certs/origen.key /etc/caddy/certs/origen.pem")
        s.huella = huella_pem((d / "origen.pem").read_text())

        r = correr(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "prueba-campusia", "-f", str(d / "clave")])
        assert r.returncode == 0, r.stderr
        s.clave = d / "clave"
        publica = (d / "clave.pub").read_text().strip()

        s.secretos = {k: f"prueba-{k.replace('_', '-')}-{secrets.token_hex(12)}" for k in CLAVES_VAULT}
        secretos_archivo = d / "secretos.yml"
        secretos_archivo.write_text(json.dumps(s.secretos))

        inventario = d / "inventario.yml"
        inventario.write_text(json.dumps({
            "servidores": {
                "hosts": {
                    "campusia-prueba": {
                        "ansible_connection": "community.docker.docker",
                        "ansible_host": c.nombre,
                        "ansible_user": "root",
                        "ansible_python_interpreter": "/usr/bin/python3",
                        "servidor_contenedor_de_prueba": True,
                        "swap_tamano_mb": SWAP_MB,
                        "firewall_cloudflare_ipv4": CF_V4,
                        "firewall_cloudflare_ipv6": CF_V6,
                        "ssh_claves_root": [publica],
                    }
                }
            }
        }))
        s.primera = correr_playbook(inventario, secretos_archivo)
        s.segunda = correr_playbook(inventario, secretos_archivo) if s.primera.returncode == 0 else None
        s.ip = c.ip()
        s.puerta = c.puerta_de_enlace()
        yield s
    finally:
        c.borrar()


@pytest.fixture(scope="module")
def aplicado(servidor):
    r = servidor.primera
    assert r.returncode == 0, f"la primera corrida de Ansible falló\n{r.stdout[-6000:]}\n{r.stderr[-2000:]}"
    return servidor


def ruleset(s):
    return json.loads(s.c.ok("nft -j list ruleset"))["nftables"]


def elementos_del_conjunto(s, nombre):
    datos = json.loads(s.c.ok(f"nft -j list set inet filtro {nombre}"))["nftables"]
    conjunto = next(x["set"] for x in datos if "set" in x)
    redes = []
    for e in conjunto.get("elem", []):
        if isinstance(e, dict) and "elem" in e:
            e = e["elem"]["val"]
        if isinstance(e, str):
            redes.append(ipaddress.ip_network(e))
        elif "prefix" in e:
            redes.append(ipaddress.ip_network(f"{e['prefix']['addr']}/{e['prefix']['len']}"))
        elif "range" in e:
            a, b = e["range"]
            redes.extend(ipaddress.summarize_address_range(ipaddress.ip_address(a), ipaddress.ip_address(b)))
    return sorted(ipaddress.collapse_addresses(redes))


def normalizar(lista):
    return sorted(ipaddress.collapse_addresses(ipaddress.ip_network(x) for x in lista))


def servir_listas(s, v4, v6):
    s.c.ok("mkdir -p /tmp/cfips; pkill -f 'http[.]server 8099' || true")
    s.c.ok("cat > /tmp/cfips/v4", entrada=v4)
    s.c.ok("cat > /tmp/cfips/v6", entrada=v6)
    s.c.ok("nohup python3 -m http.server 8099 --bind 127.0.0.1 --directory /tmp/cfips >/dev/null 2>&1 &")
    for _ in range(30):
        if s.c.ejecutar("curl -fsS http://127.0.0.1:8099/v4 >/dev/null").returncode == 0:
            return
        time.sleep(0.5)
    raise AssertionError("no arrancó el servidor de listas de prueba")


def actualizar_ips(s):
    return s.c.ejecutar(
        ACTUALIZADOR,
        env={"CLOUDFLARE_IPS_V4_URL": "http://127.0.0.1:8099/v4", "CLOUDFLARE_IPS_V6_URL": "http://127.0.0.1:8099/v6"},
        timeout=120,
    )


def puertos(derecha):
    if isinstance(derecha, int):
        return {derecha}
    if isinstance(derecha, str) and derecha.isdigit():
        return {int(derecha)}
    if isinstance(derecha, dict) and "set" in derecha:
        r = set()
        for x in derecha["set"]:
            r |= puertos(x)
        return r
    if isinstance(derecha, dict) and "range" in derecha:
        a, b = derecha["range"]
        return set(range(int(a), int(b) + 1))
    if isinstance(derecha, list):
        r = set()
        for x in derecha:
            r |= puertos(x)
        return r
    return set()


ICMP = {"icmp", "ipv6-icmp", "icmpv6", "1", "58"}


def es_icmp(derecha):
    valores = derecha["set"] if isinstance(derecha, dict) and "set" in derecha else [derecha]
    return bool(valores) and all(str(v) in ICMP for v in valores)


def analizar_regla(regla):
    acepta = any("accept" in e for e in regla["expr"])
    limitada = False
    origen = False
    destino = set()
    for e in regla["expr"]:
        m = e.get("match")
        if not m:
            continue
        izq, der = m["left"], m["right"]
        if "ct" in izq:
            limitada = True
        elif "meta" in izq and izq["meta"].get("key") in ("iif", "iifname"):
            if der == "lo":
                limitada = True
        elif "meta" in izq and izq["meta"].get("key") == "l4proto":
            if es_icmp(der):
                limitada = True
        elif "payload" in izq:
            campo = izq["payload"].get("field")
            proto = izq["payload"].get("protocol")
            if campo == "dport":
                destino |= puertos(der)
            elif campo == "saddr":
                if isinstance(der, str) and der.startswith("@"):
                    origen = True
                elif isinstance(der, dict) and "prefix" in der:
                    origen = int(der["prefix"]["len"]) > 0
                elif isinstance(der, str):
                    origen = ipaddress.ip_network(der, strict=False).prefixlen > 0
                elif isinstance(der, dict) and "set" in der:
                    origen = True
            elif proto in ("ip", "ip6") and campo in ("protocol", "nexthdr"):
                if es_icmp(der):
                    limitada = True
    return acepta, limitada, origen, destino


@pytest.mark.aceptacion
def test_ansible_lint():
    assert (SERVIDOR / "sitio.yml").is_file(), "falta infraestructura/servidor/sitio.yml"
    r = correr(["ansible-lint", "--offline", "--profile", "moderate", "--nocolor"], cwd=SERVIDOR, timeout=900)
    assert r.returncode == 0, f"ansible-lint encontró problemas\n{r.stdout[-5000:]}\n{r.stderr[-3000:]}"


@pytest.mark.aceptacion
def test_estructura_del_proyecto_ansible():
    for archivo in ["ansible.cfg", "sitio.yml", "inventario.ejemplo.yml", "requirements.yml", "secretos.ejemplo.yml"]:
        assert (SERVIDOR / archivo).is_file(), f"falta infraestructura/servidor/{archivo}"
    for rol in ["base", "usuario", "ssh", "firewall", "swap", "caddy", "docker", "campusia"]:
        assert (SERVIDOR / "roles" / rol / "tasks" / "main.yml").is_file(), f"falta el rol {rol}"
    sitio = (SERVIDOR / "sitio.yml").read_text()
    assert re.search(r"hosts:\s*servidores", sitio), "sitio.yml tiene que apuntar al grupo servidores"
    r = correr(["ansible-playbook", "--syntax-check", "-i", "inventario.ejemplo.yml", "sitio.yml"], cwd=SERVIDOR)
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"


@pytest.mark.aceptacion
def test_primera_corrida_sin_fallas(servidor):
    r = servidor.primera
    assert r.returncode == 0, f"la primera corrida de Ansible falló\n{r.stdout[-6000:]}\n{r.stderr[-2000:]}"
    res = resumen(r.stdout)
    assert res["failed"] == 0 and res["unreachable"] == 0


@pytest.mark.aceptacion
def test_segunda_corrida_sin_cambios(aplicado):
    r = aplicado.segunda
    assert r is not None and r.returncode == 0, f"la segunda corrida falló\n{r.stdout[-6000:] if r else ''}"
    res = resumen(r.stdout)
    assert res["failed"] == 0
    assert res["changed"] == 0, f"la segunda corrida informó {res['changed']} cambios (no es idempotente): {tareas_cambiadas(r.stdout)}"


@pytest.mark.aceptacion
def test_usuario_campusia(aplicado):
    c = aplicado.c
    nombre, _, uid, gid, _, home, shell = c.ok("getent passwd campusia").strip().split(":")
    assert int(uid) < 1000, "campusia tiene que ser usuario de sistema"
    assert home == "/srv/campusia"
    assert shell == "/bin/bash"
    assert c.ok("stat -c %U /srv/campusia").strip() == "campusia"
    assert re.search(r"(?m)^campusia:200000:65536$", c.ok("cat /etc/subuid"))
    assert re.search(r"(?m)^campusia:200000:65536$", c.ok("cat /etc/subgid"))
    c.ok("test -e /var/lib/systemd/linger/campusia")


@pytest.mark.aceptacion
def test_ssh_solo_con_clave_y_la_clave_funciona(aplicado):
    c = aplicado.c
    c.ok("ls /etc/ssh/sshd_config.d/*.conf | grep -q campusia")
    t = c.ok("sshd -T").lower()
    assert re.search(r"(?m)^passwordauthentication no$", t)
    assert re.search(r"(?m)^kbdinteractiveauthentication no$", t)
    assert re.search(r"(?m)^pubkeyauthentication yes$", t)
    assert re.search(r"(?m)^permitrootlogin (without-password|prohibit-password)$", t)
    assert c.ok("systemctl is-active ssh").strip() == "active"
    r = correr([
        "ssh", "-F", "/dev/null", "-i", str(aplicado.clave), "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
        f"root@{aplicado.ip}", "true",
    ], timeout=30)
    assert r.returncode == 0, f"root no pudo entrar con su clave\n{r.stderr}"


@pytest.mark.aceptacion
def test_nftables_con_listas_de_cloudflare(aplicado):
    c = aplicado.c
    assert c.ok("systemctl is-enabled nftables").strip() == "enabled"
    assert c.ok("systemctl is-active nftables").strip() == "active"
    cadenas = [x["chain"] for x in ruleset(aplicado) if "chain" in x]
    entrada = [ch for ch in cadenas if ch["family"] == "inet" and ch["table"] == "filtro" and ch["name"] == "entrada"]
    assert entrada, "falta la cadena inet filtro entrada"
    assert entrada[0].get("hook") == "input" and entrada[0].get("policy") == "drop"
    assert elementos_del_conjunto(aplicado, "cloudflare_v4") == normalizar(CF_V4)
    assert elementos_del_conjunto(aplicado, "cloudflare_v6") == normalizar(CF_V6)
    r = c.ejecutar("systemctl restart nftables && nft list set inet filtro cloudflare_v4")
    assert r.returncode == 0
    assert elementos_del_conjunto(aplicado, "cloudflare_v4") == normalizar(CF_V4)


@pytest.mark.aceptacion
def test_ssh_abierto_desde_cualquier_origen(aplicado):
    assert conecta(aplicado.ip, 22), "el puerto 22 tiene que estar abierto"


@pytest.mark.aceptacion
def test_swap_configurado(aplicado):
    c = aplicado.c
    assert c.ok("stat -c '%U %a %s' /swapfile").split() == ["root", "600", str(SWAP_MB * 1024 * 1024)]
    assert c.ok("dd if=/swapfile bs=1 skip=4086 count=10 status=none") == "SWAPSPACE2"
    assert re.search(r"(?m)^/swapfile\s+none\s+swap\s+sw\s+0\s+0\s*$", c.ok("cat /etc/fstab"))
    assert re.search(r"(?m)^\s*vm\.swappiness\s*=\s*20\s*$", c.ok("cat /etc/sysctl.d/90-campusia.conf"))


@pytest.mark.aceptacion
def test_caddy_sirve_con_el_certificado_de_origen(aplicado):
    c = aplicado.c
    assert c.ok("systemctl is-enabled caddy").strip() == "enabled"
    assert c.ok("systemctl is-active caddy").strip() == "active"
    assert "auto_https disable_certs" in c.ok("cat /etc/caddy/Caddyfile")
    c.ok("caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile")
    assert c.ok("stat -c '%U %G %a' /etc/caddy/certs/origen.key").split() == ["root", "caddy", "640"]
    assert c.ok("stat -c '%U %G' /etc/caddy/certs/origen.pem").split() == ["root", "caddy"]
    script = (
        "import ssl,socket,hashlib\n"
        "ctx=ssl.create_default_context();ctx.check_hostname=False;ctx.verify_mode=ssl.CERT_NONE\n"
        "s=ctx.wrap_socket(socket.create_connection(('127.0.0.1',443),timeout=5),server_hostname='campusia.tech')\n"
        "print(hashlib.sha256(s.getpeercert(True)).hexdigest())\n"
    )
    huella = c.ok("python3 -", entrada=script).strip()
    assert huella == aplicado.huella, "Caddy no sirve el certificado de origen existente"
    r = c.ejecutar("curl -sk --max-time 5 -o /dev/null -w '%{http_code}' --resolve campusia.tech:443:127.0.0.1 https://campusia.tech/")
    assert r.returncode != 0 or r.stdout.strip() in ("000", ""), f"Caddy respondió {r.stdout} a un origen que no es Cloudflare"


@pytest.mark.aceptacion
def test_actualizaciones_automaticas(aplicado):
    c = aplicado.c
    assert "install ok installed" in c.ok("dpkg-query -W -f='${Status}' unattended-upgrades")
    dump = c.ok("apt-config dump")
    assert 'APT::Periodic::Unattended-Upgrade "1";' in dump
    assert 'APT::Periodic::Update-Package-Lists "1";' in dump


@pytest.mark.aceptacion
def test_docker_sin_root_y_sin_podman(aplicado):
    c = aplicado.c
    for paquete in ["docker-ce", "docker-ce-rootless-extras", "uidmap"]:
        assert "install ok installed" in c.ok(f"dpkg-query -W -f='${{Status}}' {paquete}"), f"falta {paquete}"
    r = c.ejecutar("dpkg-query -W -f='${Status}' podman")
    assert "install ok installed" not in r.stdout, "podman tiene que desinstalarse"
    for unidad in ["docker.service", "docker.socket"]:
        assert c.ejecutar(f"systemctl is-enabled {unidad}").stdout.strip() != "enabled", f"{unidad} del sistema tiene que quedar deshabilitado"
        assert c.ejecutar(f"systemctl is-active {unidad}").stdout.strip() != "active", f"{unidad} del sistema no tiene que correr"


@pytest.mark.aceptacion
def test_campusia_env(aplicado):
    c = aplicado.c
    assert c.ok("stat -c '%U %G %a' /srv/campusia/config").split()[0] == "campusia"
    assert c.ok("stat -c '%a' /srv/campusia/config").strip() == "750"
    assert c.ok("stat -c '%U %G %a' /srv/campusia/config/campusia.env").split() == ["campusia", "campusia", "600"]
    contenido = c.ok("cat /srv/campusia/config/campusia.env")
    for clave_vault, variable in CLAVES_VAULT.items():
        valor = re.escape(aplicado.secretos[clave_vault])
        assert re.search(rf"(?m)^{variable}=[\"']?{valor}[\"']?$", contenido), f"falta {variable} en campusia.env"
    assert re.search(r"(?m)^DOMINIO_BASE=[\"']?campusia\.tech[\"']?$", contenido)
    assert re.search(r"(?m)^PROVEEDOR_EMAIL=[\"']?brevo[\"']?$", contenido)


@pytest.mark.aceptacion
def test_temporizador_de_ips_y_despliegue_continuo(aplicado):
    c = aplicado.c
    c.ok(f"test -x {ACTUALIZADOR}")
    assert c.ok("systemctl is-enabled campusia-cloudflare-ips.timer").strip() == "enabled"
    c.ok("test -f /srv/campusia/.config/systemd/user/campusia-despliegue.timer")
    c.ok("test -f /srv/campusia/.config/systemd/user/campusia-receptor.service")


@pytest.mark.aceptacion
def test_actualizador_de_ips_acepta_listas_validas(aplicado):
    c = aplicado.c
    nuevas_v4 = ["104.16.0.0/13", f"{aplicado.puerta}/32"]
    nuevas_v6 = ["2a06:98c0::/29"]
    try:
        servir_listas(aplicado, "\n".join(nuevas_v4) + "\n", "\n".join(nuevas_v6) + "\n")
        r = actualizar_ips(aplicado)
        assert r.returncode == 0, f"el actualizador rechazó listas válidas\n{r.stdout}\n{r.stderr}"
        assert elementos_del_conjunto(aplicado, "cloudflare_v4") == normalizar(nuevas_v4)
        assert elementos_del_conjunto(aplicado, "cloudflare_v6") == normalizar(nuevas_v6)
        assert huella_remota(aplicado.ip) == aplicado.huella, "con el origen permitido, 443 tiene que responder"
        c.ok("systemctl restart nftables")
        assert elementos_del_conjunto(aplicado, "cloudflare_v4") == normalizar(nuevas_v4), "las listas tienen que sobrevivir a un reinicio"
    finally:
        servir_listas(aplicado, "\n".join(CF_V4) + "\n", "\n".join(CF_V6) + "\n")
        r = actualizar_ips(aplicado)
    assert r.returncode == 0
    assert elementos_del_conjunto(aplicado, "cloudflare_v4") == normalizar(CF_V4)


@pytest.mark.ataque
def test_80_y_443_cerrados_para_origenes_que_no_son_cloudflare(aplicado):
    escucha = aplicado.c.ok("ss -Hltn")
    assert re.search(r":443\s", escucha), "Caddy tiene que estar escuchando en 443 para que la prueba tenga sentido"
    assert not conecta(aplicado.ip, 443), "443 aceptó una conexión desde un origen que no es Cloudflare"
    assert not conecta(aplicado.ip, 80), "80 aceptó una conexión desde un origen que no es Cloudflare"


@pytest.mark.ataque
def test_ninguna_regla_abre_puertos_a_todo_internet(aplicado):
    datos = ruleset(aplicado)
    cadenas_entrada = {
        (x["chain"]["family"], x["chain"]["table"], x["chain"]["name"])
        for x in datos
        if "chain" in x and x["chain"].get("hook") == "input"
    }
    assert ("inet", "filtro", "entrada") in cadenas_entrada
    reglas = [x["rule"] for x in datos if "rule" in x and (x["rule"]["family"], x["rule"]["table"], x["rule"]["chain"]) in cadenas_entrada]
    assert reglas, "la cadena de entrada no tiene reglas"
    problemas = []
    for regla in reglas:
        acepta, limitada, origen, destino = analizar_regla(regla)
        if not acepta:
            continue
        if destino & {80, 443} and not origen:
            problemas.append(regla)
        elif not (limitada or origen or (destino and destino <= {22})):
            problemas.append(regla)
    assert not problemas, f"reglas que aceptan tráfico de cualquier origen: {json.dumps(problemas)[:3000]}"
    texto = aplicado.c.ok("nft list ruleset")
    assert "0.0.0.0/0" not in texto and "::/0" not in texto


@pytest.mark.ataque
def test_ssh_no_ofrece_contrasena(aplicado):
    for usuario in ("root", "campusia"):
        r = correr([
            "ssh", "-F", "/dev/null", "-v", "-o", "BatchMode=yes", "-o", "PubkeyAuthentication=no",
            "-o", "PreferredAuthentications=password,keyboard-interactive",
            "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=5",
            f"{usuario}@{aplicado.ip}", "true",
        ], timeout=30)
        assert r.returncode != 0
        metodos = re.findall(r"Authentications that can continue: (\S+)", r.stderr)
        assert metodos, f"no se llegó a negociar la autenticación\n{r.stderr[-2000:]}"
        for lista in metodos:
            assert set(lista.split(",")) == {"publickey"}, f"SSH ofrece {lista} a {usuario}"


@pytest.mark.ataque
def test_secretos_fuera_de_la_salida_de_ansible(aplicado):
    salidas = aplicado.primera.stdout + aplicado.primera.stderr
    if aplicado.segunda:
        salidas += aplicado.segunda.stdout + aplicado.segunda.stderr
    for clave, valor in aplicado.secretos.items():
        assert valor not in salidas, f"el valor de {clave} apareció en la salida de Ansible"


@pytest.mark.ataque
def test_certificado_de_origen_existente_no_se_recrea(aplicado):
    assert aplicado.c.ok("sha256sum /etc/caddy/certs/origen.key /etc/caddy/certs/origen.pem") == aplicado.sumas_cert


@pytest.mark.ataque
def test_campusia_env_no_se_lee_desde_otro_usuario(aplicado):
    c = aplicado.c
    c.ok("id prueba-intrusa >/dev/null 2>&1 || useradd -M -s /bin/bash prueba-intrusa")
    r = c.ejecutar("cat /srv/campusia/config/campusia.env", usuario="prueba-intrusa")
    assert r.returncode != 0
    for valor in aplicado.secretos.values():
        assert valor not in r.stdout
    r = c.ejecutar("cat /etc/caddy/certs/origen.key", usuario="prueba-intrusa")
    assert r.returncode != 0 and "PRIVATE" not in r.stdout


@pytest.mark.ataque
@pytest.mark.parametrize(
    "v4,v6",
    [
        ("0.0.0.0/0\n", "2400:cb00::/32\n"),
        ("173.245.48.0/20\n", "::/0\n"),
        ("", "2400:cb00::/32\n"),
        ("173.245.48.0/20\n", ""),
        ("10.0.0.0/4\n", "2400:cb00::/32\n"),
        ("173.245.48.0/20\n<html>error</html>\n", "2400:cb00::/32\n"),
        ("173.245.48.0/20\n", "2400:cb00::/32\n2000::/3\n"),
        ("2400:cb00::/32\n", "173.245.48.0/20\n"),
        ("173.245.48.0/20; flush ruleset\n", "2400:cb00::/32\n"),
    ],
)
def test_actualizador_rechaza_listas_peligrosas(aplicado, v4, v6):
    c = aplicado.c
    antes = c.ok("nft -s list ruleset")
    servir_listas(aplicado, v4, v6)
    r = actualizar_ips(aplicado)
    assert r.returncode != 0, f"el actualizador aceptó una lista peligrosa: {v4!r} {v6!r}"
    assert c.ok("nft -s list ruleset") == antes, "una lista rechazada no puede cambiar el firewall"
    assert elementos_del_conjunto(aplicado, "cloudflare_v4") == normalizar(CF_V4)
