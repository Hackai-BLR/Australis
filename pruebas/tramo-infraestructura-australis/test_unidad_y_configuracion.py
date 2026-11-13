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
