import os
import pathlib
import secrets

import pytest

from conftest import INFRA, LEVANTAR, REPO, correr, leer_llamadas, preparar_envoltorios

OBLIGATORIAS = ["CAMPUSIA_IP", "CLOUDFLARE_API_TOKEN", "TOFU_FRASE_ESTADO", "ANSIBLE_VAULT_CONTRASENA"]


@pytest.fixture
def base(tmp_path):
    envoltorios = preparar_envoltorios(tmp_path / "bin")
    vault = tmp_path / "secretos.vault.yml"
    vault.write_text("$ANSIBLE_VAULT;1.1;AES256\n" + "6162" * 40 + "\n")
    tfvars = tmp_path / "produccion.tfvars"
    tfvars.write_text('correo_destino_reenvio = "destino@ejemplo.com"\n')
    clave = tmp_path / "clave"
    clave.write_text("no es una clave real\n")
    clave.chmod(0o600)
    registro = tmp_path / "llamadas.jsonl"
    marca = tmp_path / "inyectado"
    env = {
        "PATH": f"{envoltorios}{os.pathsep}{os.environ['PATH']}",
        "HOME": str(tmp_path / "home"),
        "LLAMADAS_REGISTRO": str(registro),
        "LLAMADAS_FALLAR": "1",
        "CAMPUSIA_IP": "203.0.113.10",
        "CAMPUSIA_SSH_USUARIO": "root",
        "CAMPUSIA_SSH_CLAVE": str(clave),
        "CAMPUSIA_KNOWN_HOSTS": str(tmp_path / "known_hosts"),
        "CLOUDFLARE_API_TOKEN": "token-" + secrets.token_hex(16),
        "TOFU_FRASE_ESTADO": "frase-" + secrets.token_hex(16),
        "ANSIBLE_VAULT_CONTRASENA": "vault-" + secrets.token_hex(16),
        "CAMPUSIA_VAULT_ARCHIVO": str(vault),
        "CAMPUSIA_TFVARS": str(tfvars),
    }
    (tmp_path / "home").mkdir()
    return {"env": env, "registro": registro, "marca": marca, "dir": tmp_path}


def levantar(base, cambios=None, quitar=()):
    entorno = {k: v for k, v in os.environ.items() if not k.startswith(("CAMPUSIA_", "CLOUDFLARE_", "TOFU_", "ANSIBLE_VAULT", "TF_VAR_"))}
    entorno.update(base["env"])
    for k in quitar:
        entorno.pop(k, None)
    entorno.update(cambios or {})
    return correr(["bash", str(LEVANTAR)], cwd=base["dir"], entorno_base=entorno, timeout=120, combinar=True)


def sin_acciones_remotas(base):
    llamadas = leer_llamadas(base["registro"])
    assert llamadas == [], f"levantar.sh ejecutó programas antes de validar: {[l['programa'] for l in llamadas]}"


@pytest.mark.aceptacion
def test_levantar_existe_es_ejecutable_y_es_bash_valido():
    assert LEVANTAR.is_file(), "falta infraestructura/levantar.sh"
    assert os.access(LEVANTAR, os.X_OK), "levantar.sh tiene que ser ejecutable"
    r = correr(["bash", "-n", str(LEVANTAR)])
    assert r.returncode == 0, r.stderr


@pytest.mark.aceptacion
def test_readme_documenta_levantar():
    texto = (INFRA / "README.md").read_text()
    assert "levantar.sh" in texto
    for variable in OBLIGATORIAS + ["CAMPUSIA_SSH_USUARIO", "CAMPUSIA_RESPALDO", "CAMPUSIA_VAULT_ARCHIVO", "CAMPUSIA_TFVARS"]:
        assert variable in texto, f"el README no documenta {variable}"
    assert "187.77" not in texto


@pytest.mark.ataque
@pytest.mark.parametrize("variable", OBLIGATORIAS)
def test_falta_una_variable_obligatoria(base, variable):
    r = levantar(base, quitar=[variable])
    assert r.returncode != 0
    assert variable in r.stdout, f"el mensaje tiene que nombrar {variable}\n{r.stdout}"
    sin_acciones_remotas(base)


@pytest.mark.ataque
@pytest.mark.parametrize("variable", OBLIGATORIAS)
def test_variable_obligatoria_vacia(base, variable):
    r = levantar(base, cambios={variable: ""})
    assert r.returncode != 0
    assert variable in r.stdout
    sin_acciones_remotas(base)


@pytest.mark.ataque
@pytest.mark.parametrize("ip", [
    "999.1.1.1",
    "203.0.113",
    "203.0.113.10.5",
    "campusia.tech",
    "-oProxyCommand=touch {marca}",
    "203.0.113.10;touch {marca}",
    "$(touch {marca})",
    "203.0.113.10 -oProxyCommand=touch",
    "2001:db8::1",
    "",
])
def test_ip_invalida_o_con_inyeccion(base, ip):
    ip = ip.replace("{marca}", str(base["marca"]))
    r = levantar(base, cambios={"CAMPUSIA_IP": ip})
    assert r.returncode != 0, r.stdout
    assert "CAMPUSIA_IP" in r.stdout
    assert not base["marca"].exists()
    sin_acciones_remotas(base)


@pytest.mark.ataque
@pytest.mark.parametrize("usuario", ["root;id", "-oProxyCommand=id", "Root", "a b", "$(id)", "x" * 40])
def test_usuario_ssh_invalido(base, usuario):
    r = levantar(base, cambios={"CAMPUSIA_SSH_USUARIO": usuario})
    assert r.returncode != 0
    assert "CAMPUSIA_SSH_USUARIO" in r.stdout
    sin_acciones_remotas(base)


@pytest.mark.ataque
@pytest.mark.parametrize("puerto", ["0", "65536", "22;id", "abc"])
def test_puerto_ssh_invalido(base, puerto):
    r = levantar(base, cambios={"CAMPUSIA_SSH_PUERTO": puerto})
    assert r.returncode != 0
    assert "CAMPUSIA_SSH_PUERTO" in r.stdout
    sin_acciones_remotas(base)


@pytest.mark.ataque
def test_frase_del_estado_corta(base):
    r = levantar(base, cambios={"TOFU_FRASE_ESTADO": "corta"})
    assert r.returncode != 0
    assert "TOFU_FRASE_ESTADO" in r.stdout
    sin_acciones_remotas(base)


@pytest.mark.ataque
def test_vault_sin_cifrar(base):
    plano = base["dir"] / "plano.yml"
    plano.write_text("vault_brevo_api_key: xkeysib-no-real\n")
    r = levantar(base, cambios={"CAMPUSIA_VAULT_ARCHIVO": str(plano)})
    assert r.returncode != 0
    assert "CAMPUSIA_VAULT_ARCHIVO" in r.stdout
    assert "xkeysib-no-real" not in r.stdout
    sin_acciones_remotas(base)


@pytest.mark.ataque
def test_vault_inexistente(base):
    r = levantar(base, cambios={"CAMPUSIA_VAULT_ARCHIVO": str(base["dir"] / "no-existe.yml")})
    assert r.returncode != 0
    assert "CAMPUSIA_VAULT_ARCHIVO" in r.stdout
    sin_acciones_remotas(base)


@pytest.mark.ataque
def test_tfvars_inexistente(base):
    r = levantar(base, cambios={"CAMPUSIA_TFVARS": str(base["dir"] / "no-existe.tfvars")})
    assert r.returncode != 0
    assert "CAMPUSIA_TFVARS" in r.stdout
    sin_acciones_remotas(base)


@pytest.mark.ataque
def test_respaldo_inexistente(base):
    r = levantar(base, cambios={"CAMPUSIA_RESPALDO": str(base["dir"] / "no-existe")})
    assert r.returncode != 0
    assert "CAMPUSIA_RESPALDO" in r.stdout
    sin_acciones_remotas(base)


@pytest.mark.ataque
def test_clave_ssh_inexistente(base):
    r = levantar(base, cambios={"CAMPUSIA_SSH_CLAVE": str(base["dir"] / "no-existe")})
    assert r.returncode != 0
    assert "CAMPUSIA_SSH_CLAVE" in r.stdout
    sin_acciones_remotas(base)


@pytest.mark.ataque
def test_los_errores_de_validacion_no_muestran_secretos(base):
    r = levantar(base, cambios={"CAMPUSIA_IP": "no-es-ip"})
    assert r.returncode != 0
    for variable in ("CLOUDFLARE_API_TOKEN", "TOFU_FRASE_ESTADO", "ANSIBLE_VAULT_CONTRASENA"):
        assert base["env"][variable] not in r.stdout


@pytest.mark.ataque
def test_falla_de_conexion_no_sigue_con_los_pasos(base):
    r = levantar(base)
    assert r.returncode != 0
    assert "==> [1/5] verificar" in r.stdout, r.stdout
    assert "levantar: falló el paso verificar" in r.stdout, r.stdout
    programas = {l["programa"] for l in leer_llamadas(base["registro"])}
    assert "ssh" in programas, "verificar tiene que probar la conexión SSH"
    assert programas <= {"ssh"}, f"después de fallar la conexión no tiene que correr nada más: {programas}"
    assert "==> [2/5]" not in r.stdout
    for variable in ("CLOUDFLARE_API_TOKEN", "TOFU_FRASE_ESTADO", "ANSIBLE_VAULT_CONTRASENA"):
        assert base["env"][variable] not in r.stdout


@pytest.mark.ataque
def test_levantar_no_escribe_en_el_repo(base):
    antes = correr(["git", "status", "--porcelain", "--untracked-files=all"], cwd=REPO).stdout
    levantar(base)
    despues = correr(["git", "status", "--porcelain", "--untracked-files=all"], cwd=REPO).stdout
    assert antes == despues, "levantar.sh dejó archivos o cambios en el repo"
