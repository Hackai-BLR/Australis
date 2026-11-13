import re

import pytest

from conftest import REPO

FLUJOS = REPO / ".github" / "workflows"


def _trabajos(texto):
    return re.split(r"^jobs:\s*$", texto, flags=re.M)[1]


@pytest.mark.aceptacion
def test_escaneo_de_secretos_corre_en_todo_pull_request():
    ci = (FLUJOS / "ci.yml").read_text(encoding="utf-8")
    cabecera = ci.split("jobs:")[0]
    assert "pull_request:" in cabecera
    assert "paths:" not in cabecera
    assert re.search(r"^  secretos:\s*$", _trabajos(ci), flags=re.M)
    assert "test_secretos.py" in ci


@pytest.mark.aceptacion
def test_flujo_campusia_no_hospeda_el_escaneo_filtrado_por_ruta():
    campusia = (FLUJOS / "campusia.yml").read_text(encoding="utf-8")
    assert "test_secretos.py" not in campusia
