import re
import shutil

import pytest
import yaml

from conftest import (
    CLOUDFLARE,
    HANDOFF_PLAN,
    REPO,
    SERVIDOR,
    archivos_del_repo,
    correr,
    esta_ignorado,
    herramienta,
    ips_publicas_en_texto,
)

CSR = """-----BEGIN CERTIFICATE REQUEST-----
MIHSMHoCAQAwGDEWMBQGA1UEAwwNY2FtcHVzaWEudGVjaDBZMBMGByqGSM49AgEG
CCqGSM49AwEHA0IABBJasgTNuk8fbxsarKy3t+nKb41Y3g22gR8MQt1I6KWY+uHY
OlfeWogbZdaClwKrFyONam6SgfkAwqJ6zIH5yuGgADAKBggqhkjOPQQDAgNIADBF
AiEA3lRWy/BW6xj3rCDja6XUnLdrxkh1A/7aC+9iiIeGJ80CIAKZ/bZCTnwGzETS
Vb2LCOvuDcSCGH7owYDQurJ31kjE
-----END CERTIFICATE REQUEST-----"""


def bloque_variable(texto, nombre):
    m = re.search(r'variable\s+"' + re.escape(nombre) + r'"\s*\{', texto)
    assert m, f"no está declarada la variable {nombre}"
    nivel = 0
    for j in range(m.end() - 1, len(texto)):
        if texto[j] == "{":
            nivel += 1
        elif texto[j] == "}":
            nivel -= 1
            if nivel == 0:
                return texto[m.end() - 1:j + 1]
    raise AssertionError(f"bloque de {nombre} sin cerrar")


def textos_tf():
    return "\n".join(p.read_text() for p in sorted(CLOUDFLARE.glob("*.tf")))


@pytest.mark.ataque
def test_sin_ip_publica_real_en_archivos_versionables():
    hallazgos = []
    for relativa in archivos_del_repo():
        if relativa == HANDOFF_PLAN:
            continue
        try:
            texto = (REPO / relativa).read_text()
        except (UnicodeDecodeError, OSError):
            continue
        for numero, ip in ips_publicas_en_texto(texto):
            hallazgos.append(f"{relativa}:{numero}: {ip}")
    assert not hallazgos, "hay IPs públicas que no son de documentación en archivos versionables:\n" + "\n".join(hallazgos)


@pytest.mark.ataque
def test_el_escaner_detecta_ips_publicas_y_deja_pasar_las_permitidas():
    publica = ".".join(["93", "184", "216", "34"])
    otra = ".".join(["45", "33", "32", "156"])
    v6 = ":".join(["2a03", "2880", "f12f", "83", "face", "b00c", "0", "25de"])
    assert ips_publicas_en_texto(f'ip_servidor = "{publica}"')
    assert ips_publicas_en_texto(f"    {otra}:\n")
    assert ips_publicas_en_texto(f"host {publica}/32")
    assert ips_publicas_en_texto(f"AAAA {v6}")
    permitidos = "\n".join([
        "203.0.113.10", "198.51.100.7", "192.0.2.1", "2001:db8::1",
        "127.0.0.1", "10.1.2.3", "172.17.0.1", "192.168.1.1", "0.0.0.0/0", "::/0", "::1",
        "173.245.48.0/20 104.16.0.0/13 2400:cb00::/32 2606:4700::/32",
        "version 1.10.7", "http://127.0.0.1:8080/salud", "12:30:45",
    ])
    assert ips_publicas_en_texto(permitidos) == []


@pytest.mark.aceptacion
def test_ip_servidor_sin_valor_por_defecto_y_con_validacion():
    bloque = bloque_variable((CLOUDFLARE / "variables.tf").read_text(), "ip_servidor")
    assert not re.search(r"(?m)^\s*default\s*=", bloque), "ip_servidor no puede tener valor por defecto"
    assert "validation" in bloque, "ip_servidor tiene que validar que sea una IPv4"


@pytest.mark.aceptacion
def test_variables_de_ejemplo_con_ip_de_documentacion():
    texto = (CLOUDFLARE / "variables.ejemplo.tfvars").read_text()
    m = re.search(r'(?m)^\s*ip_servidor\s*=\s*"([^"]+)"', texto)
    assert m and m.group(1) == "203.0.113.10"


@pytest.mark.aceptacion
def test_inventario_de_ejemplo_con_ip_de_documentacion():
    datos = yaml.safe_load((SERVIDOR / "inventario.ejemplo.yml").read_text())
    hosts = datos["servidores"]["hosts"]
    assert list(hosts) == ["203.0.113.10"], f"el inventario de ejemplo tiene que usar 203.0.113.10, no {list(hosts)}"
    assert hosts["203.0.113.10"]["ansible_user"] == "root"


@pytest.mark.aceptacion
@pytest.mark.parametrize("ruta", [
    "infraestructura/servidor/inventario.yml",
    "infraestructura/servidor/secretos.yml",
    "infraestructura/cloudflare/produccion.tfvars",
    "infraestructura/cloudflare/otro.tfvars",
])
def test_archivos_con_datos_reales_ignorados(ruta):
    assert esta_ignorado(ruta), f"{ruta} tiene que estar ignorado por git"


@pytest.mark.aceptacion
@pytest.mark.parametrize("ruta", [
    "infraestructura/servidor/secretos.vault.yml",
    "infraestructura/cloudflare/variables.ejemplo.tfvars",
    "infraestructura/servidor/inventario.ejemplo.yml",
    "infraestructura/levantar.sh",
])
def test_archivos_de_ejemplo_y_vault_versionables(ruta):
    assert not esta_ignorado(ruta), f"{ruta} no tiene que estar ignorado"


@pytest.mark.ataque
def test_opentofu_rechaza_ips_invalidas(tmp_sesion):
    tofu = herramienta("tofu")
    destino = tmp_sesion / "cloudflare-ip"
    if destino.exists():
        shutil.rmtree(destino)
    shutil.copytree(CLOUDFLARE, destino, ignore=shutil.ignore_patterns(".terraform", "estado", "*.tfstate", "*.tfstate.*", "*.tfplan", "*.tfvars"))
    (destino / "estado").mkdir(exist_ok=True)
    r = correr([tofu, "init", "-backend=false", "-input=false", "-no-color"], cwd=destino, timeout=600)
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    (destino / "tests").mkdir()
    invalidas = ["999.1.1.1", "203.0.113.10; rm -rf /", "campusia.tech", "203.0.113", "2001:db8::1"]
    corridas = []
    for i, ip in enumerate(invalidas):
        corridas.append(
            f'run "invalida_{i}" {{\n  command = plan\n  variables {{\n    ip_servidor = {json_hcl(ip)}\n  }}\n'
            f"  expect_failures = [var.ip_servidor]\n}}\n"
        )
    corridas.append('run "valida" {\n  command = plan\n  variables {\n    ip_servidor = "203.0.113.10"\n  }\n}\n')
    cabecera = (
        'mock_provider "cloudflare" {}\n\nvariables {\n'
        '  cloudflare_api_token   = "token-de-prueba-00000000000000000000000000"\n'
        '  frase_estado           = "frase-de-prueba-para-el-estado-0001"\n'
        '  correo_destino_reenvio = "destino@ejemplo.com"\n'
        f"  csr_origen             = <<-EOT\n{CSR}\n  EOT\n}}\n\n"
    )
    (destino / "tests" / "ip.tftest.hcl").write_text(cabecera + "\n".join(corridas))
    r = correr([tofu, "test", "-no-color", "-filter=tests/ip.tftest.hcl"], cwd=destino, timeout=900)
    assert r.returncode == 0, f"tofu test falló\n{r.stdout}\n{r.stderr}"
    assert f"{len(corridas)} passed, 0 failed" in r.stdout, r.stdout


def json_hcl(valor):
    return '"' + valor.replace("\\", "\\\\").replace('"', '\\"') + '"'
