import configparser
import re

import pytest
import yaml

from conftest import DESPLIEGUE, SERVIDOR


def unidad(nombre):
    c = configparser.ConfigParser(strict=False, interpolation=None)
    c.optionxform = str
    c.read(DESPLIEGUE / nombre)
    return c


def entornos_de_archivo(nombre):
    valores = {}
    for linea in (DESPLIEGUE / nombre).read_text().splitlines():
        m = re.match(r"^Environment=([A-Z_]+)=(.*)$", linea)
        if m:
            valores[m.group(1)] = m.group(2)
    return valores


def leer_entorno(ruta):
    return dict(
        linea.split("=", 1) for linea in ruta.read_text().splitlines() if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", linea)
    )


def tareas_del_rol():
    return yaml.safe_load((SERVIDOR / "roles" / "campusia" / "tasks" / "main.yml").read_text())


@pytest.mark.aceptacion
def test_la_unidad_corre_el_binario_de_australis_como_campusia():
    s = unidad("campusia-australis.service")["Service"]
    assert s["ExecStart"] == "/usr/local/bin/australis-server"
    assert s["User"] == "campusia" and s["Group"] == "campusia"
    assert s["Restart"] == "on-failure"


@pytest.mark.aceptacion
def test_la_unidad_escucha_en_su_propio_puerto_local():
    bind = entornos_de_archivo("campusia-australis.service")["BIND_ADDR"]
    assert bind.startswith("127.0.0.1:"), "Australis solo escucha en la interfaz local"
    puerto = bind.split(":")[1]
    nucleo = (DESPLIEGUE / "campusia.env.ejemplo").read_text()
    usados = {"8080", "9010"} | set(re.findall(r"^PUERTO[A-Z_]*=(\d+)$", nucleo, re.M))
    assert puerto not in usados, f"el puerto {puerto} ya lo usa el núcleo o el despliegue"
    assert puerto == "8090"


@pytest.mark.aceptacion
def test_la_unidad_guarda_base_y_subidas_bajo_srv_campusia():
    c = unidad("campusia-australis.service")
    e = entornos_de_archivo("campusia-australis.service")
    assert e["DATABASE_URL"] == "sqlite:///srv/campusia/australis/datos/australis.db"
    assert e["UPLOAD_DIR"] == "/srv/campusia/australis/archivos"
    assert c.get("Service", "ReadWritePaths") == "/srv/campusia/australis"


@pytest.mark.aceptacion
def test_la_unidad_esta_endurecida_como_la_del_nucleo():
    s = unidad("campusia-australis.service")["Service"]
    assert s["ProtectSystem"] == "strict"
    assert s["NoNewPrivileges"] == "true"
    assert s["PrivateTmp"] == "true"
    assert s["EnvironmentFile"] == "/srv/campusia/config/australis.env"
    assert s["MemoryMax"]


@pytest.mark.ataque
def test_el_archivo_de_entorno_no_pisa_lo_que_fija_la_unidad():
    ejemplo = leer_entorno(DESPLIEGUE / "australis.env.ejemplo")
    for variable in ("DATABASE_URL", "BIND_ADDR", "UPLOAD_DIR"):
        assert variable not in ejemplo, f"{variable} lo fija la unidad: en el archivo de entorno la pisaría"


@pytest.mark.ataque
def test_el_ejemplo_de_entorno_no_tiene_secretos_ni_proveedores_reales():
    ejemplo = leer_entorno(DESPLIEGUE / "australis.env.ejemplo")
    assert ejemplo["AI_PROVIDER"] == "placeholder"
    assert ejemplo["ZOOM_PROVIDER"] == "placeholder"
    assert ejemplo["COOKIE_SECURE"] == "true"
    for variable in ejemplo:
        assert not re.search(r"KEY|SECRET|PASSWORD|TOKEN", variable), variable
    assert "completar" not in ejemplo.values()


@pytest.mark.aceptacion
def test_litestream_replica_las_dos_bases():
    cfg = yaml.safe_load((DESPLIEGUE / "respaldo" / "litestream.yml").read_text())
    rutas = {d["path"]: d for d in cfg["dbs"]}
    assert "/srv/campusia/datos/campusia.db" in rutas
    assert rutas["/srv/campusia/australis/datos/australis.db"]["replicas"][0]["type"] == "s3"
    destinos = {d["replicas"][0]["path"] for d in cfg["dbs"]}
    assert len(destinos) == len(cfg["dbs"]), "cada base replica a su propio prefijo del bucket"


@pytest.mark.aceptacion
def test_la_unidad_de_respaldo_puede_escribir_en_australis():
    c = unidad("respaldo/campusia-respaldo.service")
    assert "/srv/campusia/australis" in c.get("Service", "ReadWritePaths").split()


@pytest.mark.aceptacion
def test_ansible_genera_australis_env_con_dueno_y_modo_del_servicio():
    tareas = tareas_del_rol()
    generar = [t for t in tareas if t.get("name") == "Generar australis.env"]
    assert len(generar) == 1
    plantilla = generar[0]["ansible.builtin.template"]
    assert plantilla["dest"] == "{{ servidor_raiz }}/config/australis.env"
    assert plantilla["owner"] == "{{ servidor_usuario }}"
    assert plantilla["mode"] == "0600"
    assert (SERVIDOR / "roles" / "campusia" / "templates" / plantilla["src"]).is_file()
    comprobar = [t for t in tareas if t.get("name") == "Verificar los archivos de configuración"][0]
    assert any("results[4]" in str(x) for x in comprobar["ansible.builtin.assert"]["that"])


@pytest.mark.aceptacion
def test_ansible_toma_el_ejemplo_de_australis_del_repo():
    defaults = yaml.safe_load((SERVIDOR / "roles" / "campusia" / "defaults" / "main.yml").read_text())
    assert defaults["campusia_australis_env_ejemplo"].endswith("/../../despliegue/australis.env.ejemplo")
    assert defaults["campusia_australis_env_extra"] == {}


@pytest.mark.ataque
def test_el_rol_de_ansible_rechaza_que_australis_env_pise_la_unidad():
    t = [x for x in tareas_del_rol() if x.get("name") == "Verificar las variables de australis.env"][0]
    texto = " ".join(t["ansible.builtin.assert"]["that"])
    assert "DATABASE_URL" in texto and "BIND_ADDR" in texto and "UPLOAD_DIR" in texto


@pytest.mark.aceptacion
def test_el_despliegue_continuo_construye_prueba_y_comprueba_australis():
    texto = (DESPLIEGUE / "continuo" / "desplegar.sh").read_text()
    for pieza in (
        "cargo test --offline --locked --manifest-path backend/Cargo.toml",
        "cargo build --offline --locked --release --manifest-path backend/Cargo.toml --bin australis-server",
        "npm ci",
        "npm run lint",
        "npm test",
        "compilado/bin/australis-server",
        "frontend/dist/index.html",
        "/api/health",
    ):
        assert pieza in texto, f"desplegar.sh no tiene: {pieza}"


def sitio_local_de_australis():
    texto = (DESPLIEGUE / "Caddyfile").read_text()
    bloque = re.search(r"(?ms)^:8091 \{\n(.*?)^\}", texto)
    assert bloque, "falta el sitio :8091 de Australis en despliegue/Caddyfile"
    return bloque.group(1)


@pytest.mark.aceptacion
def test_el_nucleo_reenvia_australis_al_sitio_que_sirve_la_interfaz_y_la_api():
    nucleo = leer_entorno(DESPLIEGUE / "campusia.env.ejemplo")
    assert nucleo["AUSTRALIS_URL"] == "http://127.0.0.1:8091"
    cuerpo = sitio_local_de_australis()
    assert re.search(r"(?ms)handle /api/\* \{\s*reverse_proxy 127\.0\.0\.1:8090\s*\}", cuerpo)
    assert "root * /srv/campusia/australis/frontend" in cuerpo
    assert "try_files {path} /index.html" in cuerpo


@pytest.mark.ataque
def test_el_sitio_de_australis_solo_escucha_en_la_interfaz_local():
    assert re.search(r"(?m)^\s*bind 127\.0\.0\.1$", sitio_local_de_australis())


@pytest.mark.aceptacion
def test_australis_en_produccion_confia_solo_en_la_identidad_del_nucleo():
    ejemplo = leer_entorno(DESPLIEGUE / "australis.env.ejemplo")
    assert ejemplo["AUTH_MODE"] == "header"
    assert ejemplo["APP_BASE_URL"] == "https://campus.campusia.tech"
    assert "IDENTITY_PUBLIC_KEY" not in ejemplo


@pytest.mark.aceptacion
def test_la_clave_de_identidad_sale_del_vault_y_ansible_deriva_la_publica():
    defaults = yaml.safe_load((SERVIDOR / "roles" / "campusia" / "defaults" / "main.yml").read_text())
    assert defaults["campusia_secretos"]["IDENTIDAD_CLAVE_PRIVADA"] == "vault_identidad_clave_privada"
    assert leer_entorno(DESPLIEGUE / "campusia.env.ejemplo")["IDENTIDAD_CLAVE_PRIVADA"] == "completar"
    tareas = tareas_del_rol()
    nombres = [t.get("name") for t in tareas]
    assert nombres.index("Calcular la clave pública de la identidad del núcleo") < nombres.index(
        "Armar las variables de australis.env"
    )
    armar = [t for t in tareas if t.get("name") == "Armar las variables de australis.env"][0]
    assert "IDENTITY_PUBLIC_KEY" in armar["ansible.builtin.set_fact"]["campusia_australis_env_valores"]


@pytest.mark.aceptacion
def test_la_clave_publica_derivada_es_la_de_ed25519():
    pytest.importorskip("cryptography")
    import subprocess
    import sys

    tarea = [t for t in tareas_del_rol() if t.get("name") == "Calcular la clave pública de la identidad del núcleo"][0]
    argv = tarea["ansible.builtin.command"]["argv"]
    r = subprocess.run(
        [sys.executable, *argv[1:]], input="A" * 43, capture_output=True, text=True, check=True
    )
    assert r.stdout.strip() == "O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik"


@pytest.mark.ataque
def test_ansible_no_reemplaza_una_clave_de_identidad_ya_guardada():
    nombres = [t.get("name") for t in tareas_del_rol()]
    assert nombres.index("Verificar que el Vault no cambia la clave de identidad del núcleo") < nombres.index(
        "Generar campusia.env"
    )
