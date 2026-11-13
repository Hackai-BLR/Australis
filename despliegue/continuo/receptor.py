#!/usr/bin/env python3
import hashlib
import hmac
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RUTA = "/_despliegue/webhook"
MAXIMO_CUERPO = 1024 * 1024
CONSERVAR_ENTREGAS = 1000
FIRMA = re.compile(r"sha256=([0-9a-f]{64})")
ENTREGA = re.compile(r"[A-Za-z0-9._:-]{1,200}")


def configuracion():
    raiz = os.environ.get("CAMPUSIA_RAIZ") or "/srv/campusia"
    despliegue = os.environ.get("DESPLIEGUE_DIR") or os.path.join(raiz, "despliegue")
    return {
        "secreto": os.environ.get("SECRETO_WEBHOOK", ""),
        "direccion": os.environ.get("RECEPTOR_DIRECCION") or "127.0.0.1",
        "puerto": int(os.environ.get("RECEPTOR_PUERTO") or "9010"),
        "entregas": os.environ.get("RECEPTOR_ENTREGAS") or os.path.join(despliegue, "entregas-vistas"),
        "rama": os.environ.get("DESPLIEGUE_RAMA") or "main",
        "repositorio": os.environ.get("DESPLIEGUE_REPOSITORIO") or "ORGANIZACION/campusia",
        "disparador": os.environ.get("DESPLIEGUE_DISPARADOR") or "systemctl --user start --no-block campusia-despliegue.service",
    }


class Vistas:
    def __init__(self, ruta):
        self.ruta = ruta
        self.candado = threading.Lock()
        self.entradas = OrderedDict()
        self.lineas = 0
        directorio = os.path.dirname(os.path.abspath(ruta))
        os.makedirs(directorio, exist_ok=True)
        try:
            with open(ruta, "r", encoding="utf-8") as f:
                for linea in f:
                    linea = linea.strip()
                    if linea:
                        self._agregar_en_memoria(linea)
                        self.lineas += 1
        except FileNotFoundError:
            pass

    def _agregar_en_memoria(self, clave):
        self.entradas.pop(clave, None)
        self.entradas[clave] = True
        while len(self.entradas) > CONSERVAR_ENTREGAS * 2:
            self.entradas.popitem(last=False)

    def _compactar(self):
        temporal = self.ruta + ".tmp"
        with open(temporal, "w", encoding="utf-8") as f:
            for clave in self.entradas:
                f.write(clave + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporal, self.ruta)
        self.lineas = len(self.entradas)

    def registrar_si_nueva(self, entrega, resumen):
        claves = ["d " + entrega, "c " + resumen]
        with self.candado:
            if any(c in self.entradas for c in claves):
                return False
            with open(self.ruta, "a", encoding="utf-8") as f:
                for c in claves:
                    f.write(c + "\n")
                f.flush()
                os.fsync(f.fileno())
            for c in claves:
                self._agregar_en_memoria(c)
            self.lineas += len(claves)
            if self.lineas > CONSERVAR_ENTREGAS * 4:
                self._compactar()
            return True


def disparar(comando):
    entorno = {k: v for k, v in os.environ.items() if k != "SECRETO_WEBHOOK"}
    proceso = subprocess.Popen(
        comando,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        start_new_session=True,
        env=entorno,
    )
    threading.Thread(target=proceso.wait, daemon=True).start()


class Manejador(BaseHTTPRequestHandler):
    server_version = "receptor"
    sys_version = ""
    timeout = 15

    def log_message(self, formato, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), formato % args))

    def responder(self, codigo, texto):
        cuerpo = json.dumps({"resultado": texto}).encode()
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(cuerpo)
        self.close_connection = True

    def otro_metodo(self):
        if self.path == RUTA:
            self.responder(405, "metodo no permitido")
        else:
            self.responder(404, "no encontrado")

    do_GET = otro_metodo
    do_HEAD = otro_metodo
    do_PUT = otro_metodo
    do_DELETE = otro_metodo
    do_PATCH = otro_metodo
    do_OPTIONS = otro_metodo

    def leer_cuerpo(self):
        if self.headers.get("Transfer-Encoding"):
            return None, (400, "solicitud invalida")
        largo = self.headers.get("Content-Length")
        if largo is None:
            return b"", None
        if not largo.isdigit():
            return None, (400, "solicitud invalida")
        largo = int(largo)
        if largo > MAXIMO_CUERPO:
            return None, (413, "cuerpo demasiado grande")
        cuerpo = self.rfile.read(largo)
        if len(cuerpo) > MAXIMO_CUERPO:
            return None, (413, "cuerpo demasiado grande")
        if len(cuerpo) != largo:
            return None, (400, "solicitud invalida")
        return cuerpo, None

    def do_POST(self):
        cfg = self.server.cfg
        if self.path != RUTA:
            self.responder(404, "no encontrado")
            return
        try:
            cuerpo, error = self.leer_cuerpo()
        except (OSError, ValueError):
            self.close_connection = True
            return
        if error:
            self.responder(*error)
            return
        firma = self.headers.get("X-Hub-Signature-256") or ""
        m = FIRMA.fullmatch(firma)
        esperada = hmac.new(cfg["secreto"].encode(), cuerpo, hashlib.sha256).hexdigest()
        if not m or not hmac.compare_digest(m.group(1), esperada):
            self.responder(401, "firma invalida")
            return
        entrega = self.headers.get("X-GitHub-Delivery")
        evento = self.headers.get("X-GitHub-Event")
        if not entrega or not evento or not ENTREGA.fullmatch(entrega):
            self.responder(400, "faltan encabezados")
            return
        resumen = hashlib.sha256(cuerpo).hexdigest()
        try:
            nueva = self.server.vistas.registrar_si_nueva(entrega, resumen)
        except OSError:
            self.responder(500, "error interno")
            return
        if not nueva:
            self.responder(409, "entrega repetida")
            return
        if evento == "ping":
            self.responder(200, "pong")
            return
        if evento != "push":
            self.responder(400, "evento ignorado")
            return
        try:
            datos = json.loads(cuerpo.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            self.responder(400, "cuerpo invalido")
            return
        if not isinstance(datos, dict):
            self.responder(400, "cuerpo invalido")
            return
        if datos.get("ref") != "refs/heads/" + cfg["rama"]:
            self.responder(400, "rama ignorada")
            return
        repositorio = datos.get("repository")
        if not isinstance(repositorio, dict) or repositorio.get("full_name") != cfg["repositorio"]:
            self.responder(400, "repositorio ignorado")
            return
        try:
            disparar(self.server.comando)
        except OSError:
            self.responder(500, "error interno")
            return
        self.responder(202, "despliegue disparado")


class Servidor(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    cfg = configuracion()
    if not cfg["secreto"]:
        sys.stderr.write("falta SECRETO_WEBHOOK\n")
        return 2
    comando = shlex.split(cfg["disparador"])
    if not comando:
        sys.stderr.write("DESPLIEGUE_DISPARADOR vacio\n")
        return 2
    if ":" in cfg["direccion"]:
        Servidor.address_family = socket.AF_INET6
    servidor = Servidor((cfg["direccion"], cfg["puerto"]), Manejador)
    servidor.cfg = cfg
    servidor.comando = comando
    servidor.vistas = Vistas(cfg["entregas"])
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        servidor.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
