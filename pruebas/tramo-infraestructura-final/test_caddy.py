import ipaddress
import json
import re
import time

import pytest

from conftest import ARCHIVOS, CONSERVAR, DESPLIEGUE, SUFIJO, certificado_de_prueba, correr

IMAGEN_CADDY = "caddy:2.8.4"
IMAGEN_NODE = "node:22-alpine"
SUBRED_CF = "173.245.63.0/24"
IP_CADDY_CF = str(ipaddress.ip_network(SUBRED_CF)[2])
IP_CLIENTE_CF = str(ipaddress.ip_network(SUBRED_CF)[10])
IP_CF_FALSA = str(ipaddress.ip_network("173.245.48.0/20")[1])
CF_REAL = "198.51.100.7"

PEDIDOS_CF = [
    {"id": "cf-webhook", "metodo": "POST", "ruta": "/_despliegue/webhook", "cuerpo": "{\"zen\":\"prueba\"}",
     "encabezados": {"content-type": "application/json", "x-github-event": "ping"}},
    {"id": "cf-webhook-get", "metodo": "GET", "ruta": "/_despliegue/webhook"},
    {"id": "cf-salud", "metodo": "GET", "ruta": "/salud", "encabezados": {"cf-connecting-ip": CF_REAL}},
    {"id": "cf-raiz", "metodo": "GET", "ruta": "/"},
    {"id": "cf-api", "metodo": "POST", "ruta": "/api/sesion/codigo", "cuerpo": "{\"email\":\"ana@ejemplo.com\"}",
     "encabezados": {"content-type": "application/json"}},
    {"id": "cf-curso", "metodo": "GET", "ruta": "/", "host": "red-101.campusia.tech", "sni": "red-101.campusia.tech"},
    {"id": "cf-barra", "metodo": "POST", "ruta": "/_despliegue/webhook/", "cuerpo": "{}"},
    {"id": "cf-sufijo", "metodo": "POST", "ruta": "/_despliegue/webhookx", "cuerpo": "{}"},
    {"id": "cf-debajo", "metodo": "POST", "ruta": "/_despliegue/webhook/otra", "cuerpo": "{}"},
    {"id": "cf-otra", "metodo": "POST", "ruta": "/_despliegue/otra", "cuerpo": "{}"},
    {"id": "cf-recorrido", "metodo": "POST", "ruta": "/_despliegue/x/../../_despliegue/otra", "cuerpo": "{}"},
]

PEDIDOS_OTRO = [
    {"id": "otro-webhook", "metodo": "POST", "ruta": "/_despliegue/webhook", "cuerpo": "{}",
     "encabezados": {"x-github-event": "ping"}},
    {"id": "otro-webhook-falso", "metodo": "POST", "ruta": "/_despliegue/webhook", "cuerpo": "{}",
     "encabezados": {"cf-connecting-ip": IP_CF_FALSA, "x-forwarded-for": IP_CF_FALSA, "x-real-ip": IP_CF_FALSA}},
    {"id": "otro-salud", "metodo": "GET", "ruta": "/salud"},
    {"id": "otro-curso-webhook", "metodo": "POST", "ruta": "/_despliegue/webhook", "cuerpo": "{}",
     "host": "red-101.campusia.tech", "sni": "red-101.campusia.tech"},
]


class Escenario:
    pass


def borrar(*nombres):
    if not CONSERVAR:
        for n in nombres:
            correr(["docker", "rm", "-f", n])


def asegurar_imagen(imagen):
    if correr(["docker", "image", "inspect", imagen]).returncode != 0:
        r = correr(["docker", "pull", imagen], timeout=900)
        assert r.returncode == 0, r.stderr


def correr_cliente(red, ip, destino, pedidos):
    cmd = ["docker", "run", "--rm", "--network", red]
    if ip:
        cmd += ["--ip", ip]
    cmd += ["-v", f"{ARCHIVOS / 'cliente.mjs'}:/cliente.mjs:ro", IMAGEN_NODE, "node", "/cliente.mjs", destino, json.dumps(pedidos)]
    r = correr(cmd, timeout=300)
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    return {x["id"]: x for x in json.loads(r.stdout)}


@pytest.fixture(scope="module")
def escenario(tmp_modulo):
    caddyfile = DESPLIEGUE / "Caddyfile"
    assert caddyfile.is_file(), "falta despliegue/Caddyfile"
    asegurar_imagen(IMAGEN_CADDY)
    asegurar_imagen(IMAGEN_NODE)
    certs = tmp_modulo / "certs"
    certificado_de_prueba(certs)
    e = Escenario()
    e.red_cf = f"campusia-final-cf-{SUFIJO}"
    e.red_otra = f"campusia-final-otra-{SUFIJO}"
    e.caddy = f"campusia-final-caddy-{SUFIJO}"
    e.backend = f"campusia-final-backend-{SUFIJO}"
    try:
        r = correr(["docker", "network", "create", "--subnet", SUBRED_CF, e.red_cf])
        assert r.returncode == 0, r.stderr
        r = correr(["docker", "network", "create", e.red_otra])
        assert r.returncode == 0, r.stderr
        r = correr([
            "docker", "run", "-d", "--name", e.caddy, "--network", e.red_cf, "--ip", IP_CADDY_CF,
            "-v", f"{caddyfile}:/etc/caddy/Caddyfile:ro",
            "-v", f"{certs}:/etc/caddy/certs:ro",
            IMAGEN_CADDY, "caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
        ])
        assert r.returncode == 0, r.stderr
        r = correr(["docker", "network", "connect", e.red_otra, e.caddy])
        assert r.returncode == 0, r.stderr
        r = correr([
            "docker", "run", "-d", "--name", e.backend, "--network", f"container:{e.caddy}",
            "-v", f"{ARCHIVOS / 'backend.mjs'}:/backend.mjs:ro", IMAGEN_NODE, "node", "/backend.mjs",
        ])
        assert r.returncode == 0, r.stderr
        limite = time.time() + 30
        listo = False
        while time.time() < limite:
            estado = correr(["docker", "inspect", "-f", "{{.State.Running}}", e.caddy]).stdout.strip()
            puertos = correr(["docker", "exec", e.caddy, "sh", "-c", "netstat -ltn 2>/dev/null || cat /proc/net/tcp"]).stdout
            if estado == "true" and (":443" in puertos or ":01BB" in puertos) and (":9010" in puertos or ":2332" in puertos):
                listo = True
                break
            time.sleep(0.5)
        e.registro_caddy = correr(["docker", "logs", e.caddy]).stderr
        assert listo, f"Caddy no arrancó con despliegue/Caddyfile\n{e.registro_caddy[-4000:]}"
        e.ip_otra = correr([
            "docker", "inspect", "-f", f"{{{{(index .NetworkSettings.Networks \"{e.red_otra}\").IPAddress}}}}", e.caddy,
        ]).stdout.strip()
        assert e.ip_otra
        e.cf = correr_cliente(e.red_cf, IP_CLIENTE_CF, IP_CADDY_CF, PEDIDOS_CF)
        e.otro = correr_cliente(e.red_otra, None, e.ip_otra, PEDIDOS_OTRO)
        time.sleep(1)
        salida = correr(["docker", "logs", e.backend]).stdout
        e.recibidos = [json.loads(l) for l in salida.splitlines() if l.strip().startswith("{")]
        yield e
    finally:
        borrar(e.backend, e.caddy)
        if not CONSERVAR:
            correr(["docker", "network", "rm", e.red_cf])
            correr(["docker", "network", "rm", e.red_otra])


def servido_por(e, ident):
    r = e.cf.get(ident) or e.otro.get(ident)
    assert r is not None
    assert "error" not in r, f"{ident}: Caddy no respondió ({r.get('error')})"
    assert r["estado"] == 200, f"{ident}: estado {r['estado']} {r['cuerpo'][:300]}"
    return json.loads(r["cuerpo"])


def recibidos(e, ident):
    return [x for x in e.recibidos if x["id"] == ident]


@pytest.mark.aceptacion
def test_caddyfile_tiene_el_handle_del_webhook():
    texto = (DESPLIEGUE / "Caddyfile").read_text()
    bloque = re.search(r"(?ms)^\s*handle /_despliegue/webhook \{\s*\n(.*?)^\s*\}", texto)
    assert bloque, "falta handle /_despliegue/webhook en despliegue/Caddyfile"
    assert re.search(r"(?m)^\s*reverse_proxy 127\.0\.0\.1:9010\b", bloque.group(1)), "el webhook tiene que ir a 127.0.0.1:9010"


@pytest.mark.aceptacion
def test_caddyfile_valido_y_formateado(tmp_modulo):
    asegurar_imagen(IMAGEN_CADDY)
    caddyfile = DESPLIEGUE / "Caddyfile"
    r = correr(["docker", "run", "--rm", "-v", f"{caddyfile}:/etc/caddy/Caddyfile:ro", IMAGEN_CADDY,
                "caddy", "adapt", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"])
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    r = correr(["docker", "run", "--rm", "-v", f"{caddyfile}:/etc/caddy/Caddyfile:ro", IMAGEN_CADDY,
                "caddy", "fmt", "/etc/caddy/Caddyfile"])
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == caddyfile.read_text().strip(), "despliegue/Caddyfile no está en el formato de caddy fmt"


@pytest.mark.aceptacion
def test_webhook_desde_cloudflare_llega_al_receptor(escenario):
    d = servido_por(escenario, "cf-webhook")
    assert d["servicio"] == "receptor", f"el webhook llegó a {d['servicio']} en lugar del receptor"
    assert d["metodo"] == "POST" and d["ruta"] == "/_despliegue/webhook"
    assert d["bytes"] == len("{\"zen\":\"prueba\"}"), "el cuerpo del webhook no llegó entero"
    assert d["cf"] == IP_CLIENTE_CF


@pytest.mark.aceptacion
def test_webhook_con_otro_metodo_tambien_va_al_receptor(escenario):
    d = servido_por(escenario, "cf-webhook-get")
    assert d["servicio"] == "receptor", "el receptor es el que decide qué métodos acepta"


@pytest.mark.aceptacion
def test_el_resto_de_las_rutas_sigue_yendo_al_nucleo(escenario):
    for ident in ("cf-salud", "cf-raiz", "cf-api", "cf-curso"):
        d = servido_por(escenario, ident)
        assert d["servicio"] == "nucleo", f"{ident} tenía que ir al núcleo"
    assert servido_por(escenario, "cf-api")["ruta"] == "/api/sesion/codigo"
    assert servido_por(escenario, "cf-curso")["host"] == "red-101.campusia.tech"


@pytest.mark.aceptacion
def test_el_nucleo_sigue_recibiendo_la_ip_real_de_cloudflare(escenario):
    d = servido_por(escenario, "cf-salud")
    assert d["cf"] == CF_REAL
    assert d["xff"].split(",")[0].strip() == CF_REAL


@pytest.mark.ataque
@pytest.mark.parametrize("ident", ["cf-barra", "cf-sufijo", "cf-debajo", "cf-otra", "cf-recorrido"])
def test_rutas_parecidas_no_llegan_al_receptor(escenario, ident):
    d = servido_por(escenario, ident)
    assert d["servicio"] == "nucleo", f"{ident} ({d['ruta']}) llegó al receptor"


@pytest.mark.ataque
@pytest.mark.parametrize("ident", ["otro-webhook", "otro-webhook-falso", "otro-salud", "otro-curso-webhook"])
def test_origenes_que_no_son_cloudflare_se_cortan(escenario, ident):
    r = escenario.otro[ident]
    assert "error" in r, f"{ident}: Caddy respondió {r.get('estado')} a un origen que no es Cloudflare"
    assert not recibidos(escenario, ident), f"{ident}: la petición llegó a un servicio interno"


@pytest.mark.ataque
def test_el_webhook_no_confia_en_encabezados_de_ip_falsos(escenario):
    assert not [x for x in escenario.recibidos if x["servicio"] == "receptor" and x["id"].startswith("otro-")]
    assert not [x for x in escenario.recibidos if x["cf"] == IP_CF_FALSA]


@pytest.mark.ataque
def test_cada_peticion_llega_una_sola_vez_y_a_un_solo_servicio(escenario):
    for p in PEDIDOS_CF:
        assert len(recibidos(escenario, p["id"])) == 1, f"{p['id']} llegó {len(recibidos(escenario, p['id']))} veces"
