import os
import secrets
import subprocess
import time

import pytest

from conftest import CONTINUO, IMAGEN, SUFIJO, correr

MIB = 1024 * 1024
DIA = 86400


def preparar(tmp_path, cantidad_cache=10, viejo=True):
    desp = tmp_path / "despliegue"
    cache = desp / "cache"
    (cache / "cargo" / "registry").mkdir(parents=True)
    (cache / "pnpm" / "store").mkdir(parents=True)
    ahora = time.time()
    archivos = []
    for i in range(cantidad_cache):
        sub = cache / ("cargo/registry" if i % 2 else "pnpm/store")
        p = sub / f"pieza-{i:02d}.bin"
        p.write_bytes(os.urandom(MIB))
        t = ahora - (cantidad_cache - i) * 3600
        os.utime(p, (t, t))
        archivos.append(p)
    antiguo = None
    if viejo:
        antiguo = cache / "pnpm" / "antiguo.bin"
        antiguo.write_bytes(b"x" * 1000)
        os.utime(antiguo, (ahora - 40 * DIA, ahora - 40 * DIA))
    fuentes = desp / "fuentes"
    commits = [secrets.token_hex(20) for _ in range(5)]
    for i, c in enumerate(commits):
        d = fuentes / c
        d.mkdir(parents=True)
        (d / "archivo").write_text(c)
        t = ahora - (5 - i) * 600
        os.utime(d, (t, t))
    (desp / "actual").write_text(commits[1] + "\n")
    return desp, cache, archivos, antiguo, commits


def limpiar(desp, extra=None, timeout=300):
    assert (CONTINUO / "limpiar.sh").is_file(), "falta despliegue/continuo/limpiar.sh"
    env = {
        "DESPLIEGUE_DIR": str(desp),
        "CAMPUSIA_RAIZ": str(desp.parent),
        "CACHE_MAX": "5M",
        "CACHE_MAX_DIAS": "30",
        "DESPLIEGUE_CONSERVAR": "3",
        "DESPLIEGUE_IMAGEN": f"campusia-prueba-limpieza-{SUFIJO}",
    }
    if extra:
        env.update(extra)
    return correr(["bash", str(CONTINUO / "limpiar.sh")], env=env, timeout=timeout)


def tamano_total(d):
    return sum(p.stat().st_size for p in d.rglob("*") if p.is_file())


@pytest.mark.aceptacion
def test_cache_queda_debajo_del_maximo(tmp_path):
    desp, cache, archivos, antiguo, _ = preparar(tmp_path)
    r = limpiar(desp)
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    assert tamano_total(cache) <= 5 * MIB
    assert not antiguo.exists(), "los archivos de más de CACHE_MAX_DIAS días tienen que borrarse"
    quedan = [p for p in archivos if p.exists()]
    assert len(quedan) == 5
    assert quedan == archivos[-5:], "se tienen que borrar primero los más viejos"


@pytest.mark.aceptacion
def test_cache_por_defecto_de_4g_no_borra_lo_reciente(tmp_path):
    desp, cache, archivos, antiguo, _ = preparar(tmp_path, cantidad_cache=3)
    env_sin = dict(os.environ)
    env_sin.update({"DESPLIEGUE_DIR": str(desp), "CAMPUSIA_RAIZ": str(desp.parent), "DESPLIEGUE_IMAGEN": f"campusia-prueba-limpieza-{SUFIJO}"})
    env_sin.pop("CACHE_MAX", None)
    r = subprocess.run(["bash", str(CONTINUO / "limpiar.sh")], env=env_sin, capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, r.stderr
    assert all(p.exists() for p in archivos)
    assert not antiguo.exists()


@pytest.mark.aceptacion
def test_conserva_las_ultimas_tres_versiones_y_la_actual(tmp_path):
    desp, _, _, _, commits = preparar(tmp_path)
    r = limpiar(desp)
    assert r.returncode == 0, r.stderr
    quedan = {p.name for p in (desp / "fuentes").iterdir()}
    assert quedan == {commits[1], commits[4], commits[3]}


@pytest.mark.aceptacion
def test_borra_imagenes_viejas_y_conserva_las_ultimas(tmp_path, imagen_debian):
    desp, _, _, _, commits = preparar(tmp_path)
    repo = f"campusia-prueba-limpieza-{SUFIJO}"
    otra = f"campusia-prueba-otra-{SUFIJO}:{commits[0]}"
    try:
        for c in commits:
            assert correr(["docker", "tag", imagen_debian, f"{repo}:{c}"]).returncode == 0
        assert correr(["docker", "tag", imagen_debian, otra]).returncode == 0
        r = limpiar(desp)
        assert r.returncode == 0, r.stderr
        etiquetas = set(correr(["docker", "image", "ls", repo, "--format", "{{.Tag}}"]).stdout.split())
        assert etiquetas == {commits[1], commits[3], commits[4]}
        assert correr(["docker", "image", "inspect", otra]).returncode == 0, "no se pueden tocar otras imágenes"
        assert correr(["docker", "image", "inspect", imagen_debian]).returncode == 0
    finally:
        for c in commits:
            correr(["docker", "rmi", f"{repo}:{c}"])
        correr(["docker", "rmi", otra])


@pytest.mark.ataque
def test_no_limpia_durante_un_despliegue(tmp_path):
    desp, cache, archivos, antiguo, commits = preparar(tmp_path)
    cerrojo = desp / "despliegue.lock"
    cerrojo.touch()
    tenedor = subprocess.Popen(["flock", "-n", str(cerrojo), "sleep", "20"])
    try:
        time.sleep(1)
        r = limpiar(desp)
        assert r.returncode == 75, f"limpiar.sh no respetó el cerrojo: {r.returncode}"
        assert all(p.exists() for p in archivos) and antiguo.exists()
        assert len(list((desp / "fuentes").iterdir())) == 5
    finally:
        tenedor.kill()
        tenedor.wait()


@pytest.mark.ataque
def test_sufijos_de_tamano_y_valores_invalidos(tmp_path):
    desp, cache, archivos, _, _ = preparar(tmp_path, viejo=False)
    r = limpiar(desp, extra={"CACHE_MAX": str(3 * MIB)})
    assert r.returncode == 0, r.stderr
    assert tamano_total(cache) <= 3 * MIB
    desp2, cache2, archivos2, _, _ = preparar(tmp_path / "b", viejo=False)
    r = limpiar(desp2, extra={"CACHE_MAX": "2048K"})
    assert r.returncode == 0, r.stderr
    assert tamano_total(cache2) <= 2 * MIB


@pytest.mark.ataque
def test_no_borra_fuera_de_la_cache(tmp_path):
    desp, cache, _, _, _ = preparar(tmp_path)
    afuera = tmp_path / "afuera.bin"
    afuera.write_bytes(os.urandom(MIB))
    viejo = time.time() - 90 * DIA
    os.utime(afuera, (viejo, viejo))
    (cache / "enlace").symlink_to(afuera)
    (cache / "dir-enlace").symlink_to(tmp_path)
    r = limpiar(desp, extra={"CACHE_MAX": "1K"})
    assert r.returncode == 0, r.stderr
    assert afuera.exists(), "la limpieza siguió un enlace simbólico fuera de la caché"
    assert (desp / "actual").exists()
