import json
import re
import shutil

import pytest

from conftest import AQUI, CLOUDFLARE, REPO, bloques_hcl, correr, esta_ignorado

FRASE = "frase-de-prueba-para-el-estado-0001"
TESTIGO = "valor-testigo-campusia-7f3a"


def textos_tf():
    archivos = sorted(CLOUDFLARE.glob("*.tf"))
    assert archivos, "no hay archivos .tf en infraestructura/cloudflare"
    return {a.name: a.read_text() for a in archivos}


def copia_config(destino):
    shutil.copytree(
        CLOUDFLARE,
        destino,
        ignore=shutil.ignore_patterns(".terraform", "estado", "*.tfstate", "*.tfstate.*", "*.tfplan"),
    )
    (destino / "estado").mkdir(exist_ok=True)
    return destino


@pytest.fixture(scope="module")
def config_iniciada(tmp_sesion, tofu):
    assert CLOUDFLARE.is_dir(), "falta infraestructura/cloudflare"
    destino = copia_config(tmp_sesion / "cloudflare")
    r = correr([tofu, "init", "-backend=false", "-input=false", "-no-color"], cwd=destino, timeout=600)
    assert r.returncode == 0, f"tofu init -backend=false falló\n{r.stdout}\n{r.stderr}"
    return destino


def estado_aislado(tmp_sesion, tofu, nombre):
    estado_tf = CLOUDFLARE / "estado.tf"
    assert estado_tf.is_file(), "falta infraestructura/cloudflare/estado.tf"
    d = tmp_sesion / nombre
    if d.exists():
        shutil.rmtree(d)
    d.mkdir()
    shutil.copy(estado_tf, d / "estado.tf")
    (d / "testigo.tf").write_text(
        'resource "terraform_data" "testigo" {\n  input = "' + TESTIGO + '"\n}\n'
    )
    r = correr([tofu, "init", "-input=false", "-no-color"], cwd=d, env={"TF_VAR_frase_estado": FRASE})
    assert r.returncode == 0, f"tofu init con estado.tf solo falló\n{r.stdout}\n{r.stderr}"
    return d


@pytest.mark.aceptacion
def test_formato(tofu):
    assert CLOUDFLARE.is_dir(), "falta infraestructura/cloudflare"
    r = correr([tofu, "fmt", "-check", "-recursive", "-no-color"], cwd=CLOUDFLARE)
    assert r.returncode == 0, f"tofu fmt -check encontró archivos sin formato\n{r.stdout}\n{r.stderr}"


@pytest.mark.aceptacion
def test_validate(config_iniciada, tofu):
    r = correr([tofu, "validate", "-no-color"], cwd=config_iniciada)
    assert r.returncode == 0, f"tofu validate falló\n{r.stdout}\n{r.stderr}"


@pytest.mark.aceptacion
def test_proveedor_y_lock():
    assert (CLOUDFLARE / ".terraform.lock.hcl").is_file(), "falta .terraform.lock.hcl versionado"
    lock = (CLOUDFLARE / ".terraform.lock.hcl").read_text()
    assert "cloudflare/cloudflare" in lock
    m = re.search(r'provider "registry\.opentofu\.org/cloudflare/cloudflare" \{\s*version\s*=\s*"(\d+)\.', lock)
    assert m and m.group(1) == "5", "el proveedor de Cloudflare tiene que ser 5.x"


@pytest.mark.aceptacion
def test_plan_con_proveedor_simulado_muestra_el_estado_real(config_iniciada, tofu):
    pruebas = config_iniciada / "tests"
    pruebas.mkdir(exist_ok=True)
    shutil.copy(AQUI / "tofu" / "estado_real.tftest.hcl", pruebas / "estado_real.tftest.hcl")
    r = correr([tofu, "test", "-no-color", "-filter=tests/estado_real.tftest.hcl"], cwd=config_iniciada, timeout=600)
    assert r.returncode == 0, f"tofu test con proveedor simulado falló\n{r.stdout}\n{r.stderr}"
    assert "2 passed, 0 failed" in r.stdout, r.stdout


@pytest.mark.aceptacion
def test_bloques_import_para_todos_los_recursos():
    textos = textos_tf()
    todo = "\n".join(textos.values())
    recursos = set(re.findall(r'^\s*resource\s+"([a-z0-9_]+)"\s+"([a-z0-9_]+)"', todo, re.M))
    recursos = {r for r in recursos if r[0].startswith("cloudflare_")}
    esperados = {
        ("cloudflare_dns_record", "registros"),
        ("cloudflare_email_routing_dns", "reenvio"),
        ("cloudflare_email_routing_address", "destino"),
        ("cloudflare_email_routing_rule", "hola"),
        ("cloudflare_zone_setting", "ssl"),
        ("cloudflare_zone_setting", "always_use_https"),
        ("cloudflare_zone_setting", "tls_minimo"),
        ("cloudflare_turnstile_widget", "login"),
        ("cloudflare_origin_ca_certificate", "origen"),
    }
    assert esperados <= recursos, f"faltan recursos de Cloudflare: {sorted(esperados - recursos)}"
    destinos = set()
    for _, cuerpo in bloques_hcl(todo, r'(?m)^\s*import\s*\{'):
        for m in re.finditer(r'\bto\s*=\s*([a-z0-9_]+)\.([a-z0-9_]+)', cuerpo):
            destinos.add((m.group(1), m.group(2)))
            assert "ids_existentes" in cuerpo, "cada bloque import tiene que depender de var.ids_existentes"
    faltan = sorted(f"{t}.{n}" for t, n in recursos - destinos)
    assert not faltan, f"recursos sin bloque import: {faltan}"


@pytest.mark.aceptacion
def test_certificado_de_origen_no_se_recrea():
    todo = "\n".join(textos_tf().values())
    bloques = bloques_hcl(todo, r'resource\s+"cloudflare_origin_ca_certificate"\s+"origen"\s*\{')
    assert bloques, "falta cloudflare_origin_ca_certificate.origen"
    cuerpo = bloques[0][1]
    assert re.search(r"prevent_destroy\s*=\s*true", cuerpo), "el certificado de origen necesita prevent_destroy"
    m = re.search(r"ignore_changes\s*=\s*\[([^\]]*)\]", cuerpo)
    assert m and "csr" in m.group(1), "el certificado de origen tiene que ignorar cambios del csr"


@pytest.mark.aceptacion
def test_gitignore_y_ejemplos():
    assert (CLOUDFLARE / "variables.ejemplo.tfvars").is_file(), "falta variables.ejemplo.tfvars"
    assert (CLOUDFLARE / "estado" / ".gitkeep").is_file(), "falta estado/.gitkeep"
    assert (CLOUDFLARE / "tofu.sh").is_file(), "falta tofu.sh"
    base = "infraestructura/cloudflare"
    for ignorado in [".terraform/proveedores", "plan.tfplan", "terraform.tfvars", "produccion.tfvars", "estado/terraform.tfstate.backup"]:
        assert esta_ignorado(f"{base}/{ignorado}"), f"{base}/{ignorado} tiene que estar ignorado"
    for versionado in ["estado/terraform.tfstate", "variables.ejemplo.tfvars", ".terraform.lock.hcl"]:
        assert not esta_ignorado(f"{base}/{versionado}"), f"{base}/{versionado} tiene que versionarse"


@pytest.mark.aceptacion
def test_estado_cifrado_se_lee_con_la_frase(tmp_sesion, tofu):
    d = estado_aislado(tmp_sesion, tofu, "estado-ok")
    env = {"TF_VAR_frase_estado": FRASE}
    r = correr([tofu, "apply", "-auto-approve", "-input=false", "-no-color"], cwd=d, env=env)
    assert r.returncode == 0, f"apply con estado cifrado falló\n{r.stdout}\n{r.stderr}"
    archivo = d / "estado" / "terraform.tfstate"
    assert archivo.is_file(), "el backend local tiene que escribir estado/terraform.tfstate"
    r = correr([tofu, "show", "-json", "-no-color"], cwd=d, env=env)
    assert r.returncode == 0, r.stderr
    assert TESTIGO in r.stdout


@pytest.mark.ataque
def test_estado_escrito_no_contiene_nada_en_claro(tmp_sesion, tofu):
    d = estado_aislado(tmp_sesion, tofu, "estado-claro")
    r = correr([tofu, "apply", "-auto-approve", "-input=false", "-no-color"], cwd=d, env={"TF_VAR_frase_estado": FRASE})
    assert r.returncode == 0, r.stderr
    contenido = (d / "estado" / "terraform.tfstate").read_text()
    assert TESTIGO not in contenido
    datos = json.loads(contenido)
    assert "encrypted_data" in datos and "resources" not in datos


@pytest.mark.ataque
def test_frase_equivocada_o_ausente_no_lee(tmp_sesion, tofu):
    d = estado_aislado(tmp_sesion, tofu, "estado-frase")
    r = correr([tofu, "apply", "-auto-approve", "-input=false", "-no-color"], cwd=d, env={"TF_VAR_frase_estado": FRASE})
    assert r.returncode == 0, r.stderr
    for env in ({"TF_VAR_frase_estado": "otra-frase-equivocada-123456"}, {"TF_VAR_frase_estado": ""}):
        r = correr([tofu, "show", "-json", "-no-color"], cwd=d, env=env)
        assert r.returncode != 0, "el estado no se tiene que poder leer con otra frase"
        assert TESTIGO not in r.stdout + r.stderr
    r = correr(f"env -u TF_VAR_frase_estado {tofu} show -json -no-color", cwd=d)
    assert r.returncode != 0
    assert TESTIGO not in r.stdout + r.stderr


@pytest.mark.ataque
def test_estado_sin_cifrar_se_rechaza(tmp_sesion, tofu):
    d = estado_aislado(tmp_sesion, tofu, "estado-plano")
    plano = {
        "version": 4,
        "terraform_version": "1.10.7",
        "serial": 1,
        "lineage": "00000000-0000-0000-0000-000000000000",
        "outputs": {},
        "resources": [],
        "check_results": None,
    }
    (d / "estado").mkdir(exist_ok=True)
    (d / "estado" / "terraform.tfstate").write_text(json.dumps(plano))
    r = correr([tofu, "plan", "-input=false", "-no-color"], cwd=d, env={"TF_VAR_frase_estado": FRASE})
    assert r.returncode != 0, "un estado sin cifrar tiene que rechazarse"


@pytest.mark.ataque
def test_estado_versionado_esta_cifrado():
    assert (CLOUDFLARE / "estado").is_dir(), "falta infraestructura/cloudflare/estado/"
    estados = [p for p in REPO.rglob("*.tfstate*") if ".terraform" not in p.parts and ".herramientas" not in p.parts]
    for p in estados:
        rel = p.relative_to(REPO).as_posix()
        if esta_ignorado(rel):
            continue
        datos = json.loads(p.read_text())
        assert "encrypted_data" in datos, f"{rel} no está cifrado"
        assert "resources" not in datos, f"{rel} tiene recursos en claro"


@pytest.mark.ataque
def test_token_sin_defecto_y_sensible():
    todo = "\n".join(textos_tf().values())
    for nombre in ("cloudflare_api_token", "frase_estado"):
        bloques = bloques_hcl(todo, r'variable\s+"' + nombre + r'"\s*\{')
        assert bloques, f"falta la variable {nombre}"
        cuerpo = bloques[0][1]
        assert re.search(r"sensitive\s*=\s*true", cuerpo), f"{nombre} tiene que ser sensitive"
        assert not re.search(r"(?m)^\s*default\s*=", cuerpo), f"{nombre} no puede tener valor por defecto"
    assert not re.search(r'api_token\s*=\s*"', todo), "el token no puede escribirse literal"


@pytest.mark.ataque
def test_estado_tf_exige_cifrado_sin_respaldo():
    texto = (CLOUDFLARE / "estado.tf").read_text()
    assert re.search(r"\bencryption\s*\{", texto)
    for bloque in ("state", "plan"):
        cuerpos = bloques_hcl(texto, r"(?m)^\s*" + bloque + r"\s*\{")
        assert cuerpos, f"falta el bloque {bloque} en encryption"
        assert re.search(r"enforced\s*=\s*true", cuerpos[0][1]), f"{bloque} tiene que tener enforced = true"
        assert "fallback" not in cuerpos[0][1], f"{bloque} no puede tener fallback"
    assert "unencrypted" not in texto
