import re

import pytest

from conftest import AQUI, INFRA, REPO, SERVIDOR, archivos_del_repo, esta_ignorado

CLAVES_VAULT = [
    "vault_brevo_api_key",
    "vault_claude_code_oauth_token",
    "vault_turnstile_clave_sitio",
    "vault_turnstile_clave_secreta",
    "vault_secreto_sesion",
    "vault_secreto_firma",
    "vault_secreto_webhook",
]

CABECERA_PRIVADA = "-----BEGIN " + r"(?:[A-Z]+ )*" + "PRIVATE KEY-----"
PATRONES = {
    "clave privada": re.compile(CABECERA_PRIVADA),
    "clave de Brevo": re.compile(r"xkeysib-[0-9a-f]{32,}"),
    "token de Anthropic": re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}"),
    "token de Cloudflare asignado": re.compile(r"(?i)(cloudflare_api_token|CLOUDFLARE_API_TOKEN|api_token)\s*[=:]\s*[\"']?[A-Za-z0-9_-]{40}[\"']?\s*$", re.M),
    "token de GitHub": re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}"),
    "clave de AWS o R2": re.compile(r"(?i)aws_secret_access_key\s*[=:]\s*[\"']?[A-Za-z0-9/+]{40}"),
}
EXCEPCIONES_CONTENIDO = {
    "pruebas/tramo-infraestructura/test_secretos.py",
    "pruebas/tramo-experimento-intermediario/ataque/01-credenciales.test.mjs",
    "pruebas/tramo-experimento-intermediario/ataque/02-rutas-y-arranque.test.mjs",
}


def relativo(p):
    return p.relative_to(REPO).as_posix()


@pytest.mark.aceptacion
def test_secretos_de_ejemplo_completos():
    archivo = SERVIDOR / "secretos.ejemplo.yml"
    assert archivo.is_file(), "falta infraestructura/servidor/secretos.ejemplo.yml"
    texto = archivo.read_text()
    for clave in CLAVES_VAULT:
        assert re.search(rf"(?m)^{clave}\s*:", texto), f"falta {clave} en secretos.ejemplo.yml"
    assert not texto.startswith("$ANSIBLE_VAULT"), "el ejemplo va en claro con valores ficticios"


@pytest.mark.aceptacion
def test_readme_de_infraestructura():
    archivo = INFRA / "README.md"
    assert archivo.is_file(), "falta infraestructura/README.md"
    texto = archivo.read_text()
    for frase in ("tofu", "import", "ansible-playbook", "ansible-vault", "~/.config/campusia", "ids_existentes", "preparar-continuo.sh", "deploy key"):
        assert frase in texto, f"el README no menciona {frase}"


@pytest.mark.ataque
def test_nada_secreto_versionado():
    assert (INFRA / "cloudflare").is_dir() and SERVIDOR.is_dir() and (REPO / "despliegue" / "continuo").is_dir(), "faltan las carpetas del tramo"
    hallazgos = []
    for p in archivos_del_repo():
        rel = relativo(p)
        if rel in EXCEPCIONES_CONTENIDO:
            continue
        try:
            texto = p.read_text(errors="ignore")
        except OSError:
            continue
        for nombre, patron in PATRONES.items():
            if patron.search(texto):
                hallazgos.append(f"{rel}: {nombre}")
    assert not hallazgos, f"secretos en archivos versionados: {hallazgos}"


@pytest.mark.ataque
def test_archivos_prohibidos_no_se_versionan():
    prohibidos = []
    for p in archivos_del_repo():
        rel = relativo(p)
        nombre = p.name
        if nombre == "campusia.env" or nombre.endswith(".env") and not nombre.endswith("ejemplo.env"):
            prohibidos.append(rel)
        if nombre.endswith(".tfvars") and nombre != "variables.ejemplo.tfvars":
            prohibidos.append(rel)
        if nombre.endswith(".tfplan") or nombre.endswith(".tfstate.backup"):
            prohibidos.append(rel)
        if re.search(r"(?i)vault[-_.]?pass|\.vault_password|tofu-frase|cloudflare-token|brevo-key|claude-oauth-token", nombre):
            prohibidos.append(rel)
        if nombre in ("id_ed25519", "id_rsa", "campusia_deploy") or nombre.endswith((".key", ".pem")) and "PRIVATE KEY" in p.read_text(errors="ignore"):
            prohibidos.append(rel)
    assert not prohibidos, f"archivos que no se pueden versionar: {prohibidos}"


@pytest.mark.ataque
def test_vault_cifrado_y_sin_secretos_en_claro():
    assert SERVIDOR.is_dir(), "falta infraestructura/servidor"
    for p in archivos_del_repo():
        rel = relativo(p)
        if not rel.startswith("infraestructura/"):
            continue
        if p.name.endswith((".yml", ".yaml")) and "vault" in p.name and "ejemplo" not in p.name:
            assert p.read_text().startswith("$ANSIBLE_VAULT;"), f"{rel} tiene que estar cifrado con Ansible Vault"
        if p.suffix in (".yml", ".yaml") and "ejemplo" not in p.name and "vault" not in p.name:
            texto = p.read_text(errors="ignore")
            for clave in CLAVES_VAULT:
                m = re.search(rf"(?m)^\s*{clave}\s*:\s*(\S.*)$", texto)
                assert not m, f"{rel} asigna {clave} en claro"
    assert not esta_ignorado("infraestructura/servidor/secretos.vault.yml"), "secretos.vault.yml cifrado se versiona"


@pytest.mark.ataque
def test_contrasena_del_vault_y_frase_fuera_del_repo():
    cfg = SERVIDOR / "ansible.cfg"
    assert cfg.is_file(), "falta infraestructura/servidor/ansible.cfg"
    m = re.search(r"(?m)^\s*vault_password_file\s*=\s*(\S+)", cfg.read_text())
    if m:
        assert m.group(1).startswith("~/.config/campusia/"), "la contraseña del Vault tiene que vivir en ~/.config/campusia/"
    envoltorio = INFRA / "cloudflare" / "tofu.sh"
    assert envoltorio.is_file(), "falta infraestructura/cloudflare/tofu.sh"
    texto = envoltorio.read_text()
    assert ".config/campusia" in texto
    assert "TF_VAR_frase_estado" in texto and "TF_VAR_cloudflare_api_token" in texto


@pytest.mark.ataque
def test_ejemplos_con_valores_ficticios():
    for p in [SERVIDOR / "secretos.ejemplo.yml", REPO / "despliegue" / "continuo" / "continuo.env.ejemplo", INFRA / "cloudflare" / "variables.ejemplo.tfvars"]:
        assert p.is_file(), f"falta {relativo(p)}"
        texto = p.read_text()
        for nombre, patron in PATRONES.items():
            assert not patron.search(texto), f"{relativo(p)} parece tener un {nombre} real"
    tfvars = (INFRA / "cloudflare" / "variables.ejemplo.tfvars").read_text()
    assert not re.search(r"(?m)^\s*(cloudflare_api_token|frase_estado)\s*=", tfvars), "el ejemplo no lleva token ni frase"


@pytest.mark.ataque
def test_herramientas_de_prueba_ignoradas():
    assert esta_ignorado("pruebas/tramo-infraestructura/.herramientas/bin/tofu")
    assert (AQUI / ".gitignore").is_file()
