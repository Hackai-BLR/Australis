import shutil

import pytest
import yaml

from conftest import DESPLIEGUE, REPO, SERVIDOR, correr

IMAGEN = "python:3.12-slim-bookworm"
NOMBRES = [
    "Verificar que existe el ejemplo de australis.env",
    "Armar las variables de australis.env",
    "Verificar las variables de australis.env",
]

PLAYBOOK_ENCABEZADO = """
- hosts: localhost
  connection: local
  gather_facts: false
  vars:
    playbook_dir_real: /repo/infraestructura/servidor
    campusia_australis_env_ejemplo: /repo/despliegue/australis.env.ejemplo
    campusia_australis_env_extra: {EXTRA}
    servidor_raiz: /tmp/salida
  tasks:
"""

GUION = r'''
set -e
pip install -q --root-user-action=ignore "ansible-core>=2.18,<2.19" >/dev/null 2>&1
ansible-galaxy collection install "community.general:>=9.0.0,<12.0.0" >/dev/null 2>&1
mkdir -p /tmp/salida/config
cd /tmp
ansible-playbook -i localhost, bien.yml > bien.log 2>&1 && echo RENDER_OK || { cat bien.log; echo RENDER_FALLO; }
cat /tmp/salida/config/australis.env
echo ---FIN_ENV
ansible-playbook -i localhost, mal.yml > mal.log 2>&1 && echo MAL_PASO || echo MAL_RECHAZADO
'''


def tareas():
    todas = yaml.safe_load((SERVIDOR / "roles" / "campusia" / "tasks" / "main.yml").read_text())
    elegidas = [t for t in todas if t.get("name") in NOMBRES]
    assert len(elegidas) == len(NOMBRES)
    plantilla = next(t for t in todas if t.get("name") == "Generar australis.env")
    plantilla = dict(plantilla)
    plantilla["ansible.builtin.template"] = dict(plantilla["ansible.builtin.template"], owner=None, group=None, mode="0600")
    del plantilla["ansible.builtin.template"]["owner"], plantilla["ansible.builtin.template"]["group"]
    plantilla["ansible.builtin.template"]["src"] = "/repo/infraestructura/servidor/roles/campusia/templates/australis.env.j2"
    return elegidas + [plantilla]


def playbook(extra):
    cuerpo = yaml.safe_dump(tareas(), default_flow_style=False)
    sangrado = "\n".join("    " + l for l in cuerpo.splitlines())
    return PLAYBOOK_ENCABEZADO.replace("{EXTRA}", extra) + sangrado + "\n"


@pytest.mark.aceptacion
@pytest.mark.skipif(shutil.which("docker") is None, reason="hace falta docker")
def test_ansible_genera_australis_env_desde_el_ejemplo_y_rechaza_valores_invalidos():
    bien = playbook("{ SESSION_SECRET: 'un secreto con espacios y $dolar' }")
    mal = playbook("{ DATABASE_URL: 'sqlite://otra.db' }")
    script = (
        f"cat > /tmp/bien.yml <<'FIN'\n{bien}FIN\ncat > /tmp/mal.yml <<'FIN'\n{mal}FIN\n{GUION}"
    )
    r = correr(
        ["docker", "run", "--rm", "-i",
         "-v", f"{DESPLIEGUE}:/repo/despliegue:ro",
         "-v", f"{REPO / 'infraestructura'}:/repo/infraestructura:ro",
         IMAGEN, "bash", "-c", script],
        timeout=900,
    )
    salida = r.stdout
    assert "RENDER_OK" in salida, f"{salida}\n{r.stderr}"
    env = salida.split("RENDER_OK", 1)[1].split("---FIN_ENV")[0]
    assert "AI_PROVIDER=placeholder" in env
    assert "COOKIE_SECURE=true" in env
    assert 'SESSION_SECRET="un secreto con espacios y \\$dolar"' in env
    assert "MAL_RECHAZADO" in salida, "Ansible aceptó un australis.env que fija DATABASE_URL"
