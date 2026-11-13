import hashlib
import hmac
import http.client
import json
import os
import secrets
import socket
import subprocess
import sys
import time
import uuid

import pytest

from conftest import CONTINUO, puerto_libre

RECEPTOR = CONTINUO / "receptor.py"
RUTA = "/_despliegue/webhook"
REPOSITORIO = "ORGANIZACION/campusia"


class Receptor:
    def __init__(self, dir_trabajo, secreto=None, extra=None):
        self.dir = dir_trabajo
        self.dir.mkdir(parents=True, exist_ok=True)
        self.secreto = secreto if secreto is not None else secrets.token_hex(32)
        self.puerto = puerto_libre()
        self.disparos = self.dir / "disparos"
        guion = self.dir / "disparar.sh"
        guion.write_text(f'#!/usr/bin/env bash\necho disparo >> "{self.disparos}"\n')
        guion.chmod(0o755)
        self.env = dict(os.environ)
        self.env.update({
            "SECRETO_WEBHOOK": self.secreto,
            "RECEPTOR_PUERTO": str(self.puerto),
            "RECEPTOR_ENTREGAS": str(self.dir / "entregas-vistas"),
            "DESPLIEGUE_DISPARADOR": f"bash {guion}",
            "DESPLIEGUE_DIR": str(self.dir / "despliegue"),
            "CAMPUSIA_RAIZ": str(self.dir / "raiz"),
        })
        self.env.pop("RECEPTOR_DIRECCION", None)
        self.env.pop("DESPLIEGUE_RAMA", None)
        self.env.pop("DESPLIEGUE_REPOSITORIO", None)
        if extra:
            self.env.update(extra)
        self.proceso = None

    def arrancar(self):
        assert RECEPTOR.is_file(), "falta despliegue/continuo/receptor.py"
        self.proceso = subprocess.Popen(
            [sys.executable, str(RECEPTOR)], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
        )
        limite = time.time() + 15
        while time.time() < limite:
            if self.proceso.poll() is not None:
                raise AssertionError(f"el receptor terminó al arrancar: {self.proceso.stdout.read()}")
            try:
                with socket.create_connection(("127.0.0.1", self.puerto), timeout=0.5):
                    return self
            except OSError:
                time.sleep(0.2)
        raise AssertionError("el receptor no abrió el puerto")

    def detener(self):
        if self.proceso and self.proceso.poll() is None:
            self.proceso.terminate()
            try:
                self.proceso.wait(5)
            except subprocess.TimeoutExpired:
                self.proceso.kill()

    def cantidad_disparos(self, espera=2.0):
        time.sleep(espera)
        if not self.disparos.exists():
            return 0
        return len(self.disparos.read_text().splitlines())

    def enviar(self, cuerpo, evento="push", entrega=None, firma="auto", metodo="POST", ruta=RUTA, encabezados=None):
        if isinstance(cuerpo, (dict, list)):
            cuerpo = json.dumps(cuerpo).encode()
        elif isinstance(cuerpo, str):
            cuerpo = cuerpo.encode()
        h = {"Content-Type": "application/json", "User-Agent": "GitHub-Hookshot/prueba"}
        if evento is not None:
            h["X-GitHub-Event"] = evento
        if entrega != "omitir":
            h["X-GitHub-Delivery"] = entrega or str(uuid.uuid4())
        if firma == "auto":
            h["X-Hub-Signature-256"] = firmar(self.secreto, cuerpo)
        elif firma is not None:
            h["X-Hub-Signature-256"] = firma
        if encabezados:
            h.update(encabezados)
        con = http.client.HTTPConnection("127.0.0.1", self.puerto, timeout=10)
        try:
            con.request(metodo, ruta, body=cuerpo if metodo != "GET" else None, headers=h)
            r = con.getresponse()
            return r.status, r.read()
        finally:
            con.close()


def firmar(secreto, cuerpo):
    return "sha256=" + hmac.new(secreto.encode(), cuerpo, hashlib.sha256).hexdigest()


def push(rama="refs/heads/main", repositorio=REPOSITORIO, despues=None):
    return {
        "ref": rama,
        "before": "0" * 40,
        "after": despues or secrets.token_hex(20),
        "repository": {"full_name": repositorio},
        "pusher": {"name": "prueba"},
    }


@pytest.fixture
def receptor(tmp_path):
    r = Receptor(tmp_path / "receptor").arrancar()
    yield r
    r.detener()


@pytest.mark.aceptacion
def test_push_firmado_a_main_dispara_un_despliegue(receptor):
    estado, cuerpo = receptor.enviar(push())
    assert estado == 202, cuerpo
    assert receptor.cantidad_disparos() == 1


@pytest.mark.aceptacion
def test_dos_pushes_distintos_disparan_dos_veces(receptor):
    assert receptor.enviar(push())[0] == 202
    assert receptor.enviar(push())[0] == 202
    assert receptor.cantidad_disparos() == 2


@pytest.mark.aceptacion
def test_ping_responde_sin_disparar(receptor):
    estado, _ = receptor.enviar({"zen": "prueba", "hook_id": 1}, evento="ping")
    assert estado == 200
    assert receptor.cantidad_disparos() == 0


@pytest.mark.ataque
def test_sin_firma_se_rechaza(receptor):
    assert receptor.enviar(push(), firma=None)[0] == 401
    assert receptor.cantidad_disparos() == 0


@pytest.mark.ataque
def test_firma_con_otro_secreto_se_rechaza(receptor):
    cuerpo = json.dumps(push()).encode()
    assert receptor.enviar(cuerpo, firma=firmar("otro-secreto", cuerpo))[0] == 401
    assert receptor.cantidad_disparos() == 0


@pytest.mark.ataque
def test_firma_de_otro_cuerpo_se_rechaza(receptor):
    original = json.dumps(push(rama="refs/heads/otra")).encode()
    alterado = json.dumps(push()).encode()
    assert receptor.enviar(alterado, firma=firmar(receptor.secreto, original))[0] == 401
    assert receptor.cantidad_disparos() == 0


@pytest.mark.ataque
@pytest.mark.parametrize("firma", ["sha1=abc", "sha256=", "sha256=zz", "sha256=" + "0" * 64, "basura", "SHA256=" + "a" * 64])
def test_firmas_mal_formadas_se_rechazan(receptor, firma):
    assert receptor.enviar(push(), firma=firma)[0] == 401
    assert receptor.cantidad_disparos(espera=0.5) == 0


@pytest.mark.ataque
def test_firma_valida_con_mayusculas_en_otro_secreto_no_pasa(receptor):
    cuerpo = json.dumps(push()).encode()
    assert receptor.enviar(cuerpo, firma=firmar(receptor.secreto.upper(), cuerpo))[0] == 401
    assert receptor.cantidad_disparos() == 0


@pytest.mark.ataque
@pytest.mark.parametrize("rama", ["refs/heads/otra", "refs/heads/main2", "refs/tags/main", "refs/heads/prueba/main", "main"])
def test_otras_ramas_y_etiquetas_no_disparan(receptor, rama):
    assert receptor.enviar(push(rama=rama))[0] == 400
    assert receptor.cantidad_disparos(espera=0.5) == 0


@pytest.mark.ataque
def test_otro_repositorio_no_dispara(receptor):
    assert receptor.enviar(push(repositorio="intruso/campusia"))[0] == 400
    assert receptor.cantidad_disparos() == 0


@pytest.mark.ataque
@pytest.mark.parametrize("evento", ["release", "pull_request", "workflow_run", ""])
def test_otros_eventos_no_disparan(receptor, evento):
    assert receptor.enviar(push(), evento=evento)[0] == 400
    assert receptor.cantidad_disparos(espera=0.5) == 0


@pytest.mark.ataque
def test_falta_evento_o_entrega(receptor):
    assert receptor.enviar(push(), evento=None)[0] == 400
    assert receptor.enviar(push(), entrega="omitir")[0] == 400
    assert receptor.cantidad_disparos() == 0


@pytest.mark.ataque
def test_cuerpo_que_no_es_json(receptor):
    assert receptor.enviar("esto no es json")[0] == 400
    assert receptor.cantidad_disparos() == 0


@pytest.mark.ataque
def test_entrega_repetida_se_rechaza(receptor):
    cuerpo = json.dumps(push()).encode()
    entrega = str(uuid.uuid4())
    assert receptor.enviar(cuerpo, entrega=entrega)[0] == 202
    assert receptor.enviar(cuerpo, entrega=entrega)[0] == 409
    assert receptor.cantidad_disparos() == 1


@pytest.mark.ataque
def test_mismo_cuerpo_con_otro_id_de_entrega_se_rechaza(receptor):
    cuerpo = json.dumps(push()).encode()
    assert receptor.enviar(cuerpo)[0] == 202
    assert receptor.enviar(cuerpo)[0] == 409
    assert receptor.cantidad_disparos() == 1


@pytest.mark.ataque
def test_repeticion_despues_de_reiniciar_el_receptor(tmp_path):
    secreto = secrets.token_hex(32)
    r = Receptor(tmp_path / "r", secreto=secreto).arrancar()
    cuerpo = json.dumps(push()).encode()
    entrega = str(uuid.uuid4())
    try:
        assert r.enviar(cuerpo, entrega=entrega)[0] == 202
    finally:
        r.detener()
    r2 = Receptor(tmp_path / "r", secreto=secreto)
    r2.puerto = r.puerto
    r2.env["RECEPTOR_PUERTO"] = str(r.puerto)
    r2.arrancar()
    try:
        assert r2.enviar(cuerpo, entrega=entrega)[0] == 409
        assert r2.enviar(cuerpo)[0] == 409
        assert r2.cantidad_disparos() == 1
    finally:
        r2.detener()


@pytest.mark.ataque
def test_firma_invalida_no_marca_la_entrega_como_vista(receptor):
    cuerpo = json.dumps(push()).encode()
    entrega = str(uuid.uuid4())
    assert receptor.enviar(cuerpo, entrega=entrega, firma=firmar("otro", cuerpo))[0] == 401
    assert receptor.enviar(cuerpo, entrega=entrega)[0] == 202
    assert receptor.cantidad_disparos() == 1


@pytest.mark.ataque
def test_cuerpo_enorme_se_rechaza(receptor):
    datos = push()
    datos["relleno"] = "x" * (1024 * 1024 + 10)
    cuerpo = json.dumps(datos).encode()
    try:
        estado, _ = receptor.enviar(cuerpo)
    except (ConnectionError, http.client.HTTPException, OSError):
        estado = 413
    assert estado == 413
    assert receptor.cantidad_disparos() == 0


@pytest.mark.ataque
def test_metodo_y_ruta_incorrectos(receptor):
    assert receptor.enviar(push(), metodo="GET")[0] == 405
    assert receptor.enviar(push(), metodo="PUT")[0] == 405
    assert receptor.enviar(push(), ruta="/otra")[0] == 404
    assert receptor.enviar(push(), ruta="/_despliegue/webhook/../otra")[0] in (400, 404)
    assert receptor.cantidad_disparos() == 0


@pytest.mark.ataque
def test_respuestas_no_filtran_el_secreto(receptor):
    for estado, cuerpo in (receptor.enviar(push(), firma="sha256=" + "1" * 64), receptor.enviar("{", firma="auto")):
        assert receptor.secreto.encode() not in cuerpo


@pytest.mark.ataque
def test_el_disparador_no_recibe_datos_del_cuerpo(tmp_path):
    marca = tmp_path / "inyectado"
    r = Receptor(tmp_path / "r")
    guion = r.dir / "disparar.sh"
    guion.write_text(f'#!/usr/bin/env bash\necho "$@" >> "{r.disparos}"\n')
    r.arrancar()
    try:
        datos = push(despues=f"$(touch {marca})")
        datos["head_commit"] = {"message": f"; touch {marca}"}
        assert r.enviar(datos)[0] in (202, 400)
        time.sleep(2)
        assert not marca.exists(), "el contenido del webhook llegó a ejecutarse"
        if r.disparos.exists():
            assert str(marca) not in r.disparos.read_text()
    finally:
        r.detener()


@pytest.mark.ataque
@pytest.mark.parametrize("secreto", ["", None])
def test_sin_secreto_no_arranca(tmp_path, secreto):
    r = Receptor(tmp_path / "r", secreto="x")
    if secreto is None:
        r.env.pop("SECRETO_WEBHOOK")
    else:
        r.env["SECRETO_WEBHOOK"] = secreto
    assert RECEPTOR.is_file(), "falta despliegue/continuo/receptor.py"
    p = subprocess.Popen([sys.executable, str(RECEPTOR)], env=r.env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        codigo = p.wait(10)
    except subprocess.TimeoutExpired:
        p.kill()
        raise AssertionError("el receptor arrancó sin secreto")
    assert codigo != 0


@pytest.mark.ataque
def test_solo_escucha_en_loopback(receptor):
    direcciones = set()
    for familia, _, _, _, dir_ in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
        if not dir_[0].startswith("127."):
            direcciones.add(dir_[0])
    salida = subprocess.run(["hostname", "-I"], capture_output=True, text=True).stdout.split()
    direcciones |= {d for d in salida if ":" not in d and not d.startswith("127.")}
    assert direcciones, "no hay direcciones fuera de loopback para probar"
    for d in direcciones:
        with pytest.raises(OSError):
            socket.create_connection((d, receptor.puerto), timeout=2).close()
