import pytest

from conftest import CONTINUO, SUFIJO, levantar_contenedor

ORIGEN = "/srv/origen/campusia.git"
TRABAJO = "/srv/origen/trabajo"
DIR = "/srv/campusia/despliegue"
INSTALADOR = "/usr/local/sbin/campusia-instalar"
RECIBIDO = "/root/recibido"

PROYECTO = r'''
set -euo pipefail
mkdir -p despliegue/espacio-trabajo plantilla-curso sdk/src
cat > despliegue/instalar.sh <<'FIN'
#!/bin/bash
set -euo pipefail
d="/root/recibido/$(date +%s%N)"
mkdir -p "$d"
printf '%s\n' "$@" > "$d/argumentos"
while [ $# -gt 0 ]; do
  case "$1" in
    --plantilla|--sdk|--espacio) cp -a "$2" "$d/${1#--}"; shift 2 ;;
    *) shift ;;
  esac
done
echo "$d" > /root/recibido/ultimo
FIN
echo "FROM scratch" > despliegue/espacio-trabajo/Containerfile
echo '{"name":"curso","dependencies":{"@campusia/sdk":"file:vendor/campusia-sdk-0.3.0.tgz"}}' > plantilla-curso/package.json
echo '{"name":"@campusia/sdk","version":"0.3.0"}' > sdk/package.json
echo 'export const x = 1' > sdk/src/index.ts
'''


class Instalador:
    pass


def ultimo(c):
    d = c.ok(f"cat {RECIBIDO}/ultimo").strip()
    return d, c.ok(f"cat {d}/argumentos").split("\n")


@pytest.fixture(scope="module")
def inst(imagen_debian):
    c = levantar_contenedor(imagen_debian, f"campusia-instalador-{SUFIJO}")
    i = Instalador()
    i.c = c
    try:
        c.ok("useradd -r -m -d /srv/campusia -s /bin/bash campusia && mkdir -p /srv/origen /etc/campusia")
        c.copiar(CONTINUO / "campusia-instalar", INSTALADOR)
        c.ok(f"chown root:root {INSTALADOR} && chmod 755 {INSTALADOR} && mkdir -p {RECIBIDO}")
        c.ok(f"printf 'INSTALAR_ORIGEN={ORIGEN}\\nINSTALAR_RAMA=main\\nDESPLIEGUE_DIR={DIR}\\n' > /etc/campusia/instalar.env")
        c.ok(
            f"git init -q --bare -b main {ORIGEN} && git init -q -b main {TRABAJO} && cd {TRABAJO} "
            "&& git config user.email prueba@ejemplo.com && git config user.name prueba "
            f"&& git remote add origin {ORIGEN} && bash -s && git add -A && git commit -q -m inicial && git push -q origin main",
            entrada=PROYECTO,
        )
        i.commit = c.ok(f"git -C {TRABAJO} rev-parse HEAD").strip()
        i.fuentes = f"{DIR}/fuentes/{i.commit}"
        c.ok(
            f"mkdir -p {i.fuentes} && git -C {TRABAJO} archive {i.commit} | tar -x -C {i.fuentes} && cd {i.fuentes} "
            "&& mkdir -p compilado/bin interfaz/dist plantilla-curso/vendor sdk/dist sdk/node_modules "
            "&& printf '#!/bin/sh\\n' > compilado/bin/campusia-nucleo && chmod 755 compilado/bin/campusia-nucleo "
            "&& echo '<!doctype html>' > interfaz/dist/index.html "
            "&& echo 'export const x = 1' > sdk/dist/index.js "
            "&& ln -s /etc/shadow sdk/node_modules/robado "
            "&& head -c 4096 /dev/urandom > plantilla-curso/vendor/campusia-sdk-0.3.0.tgz "
            "&& echo alterado > plantilla-curso/package.json "
            f"&& chown -R campusia:campusia {DIR}"
        )
        i.suma_tgz = c.ok(f"sha256sum {i.fuentes}/plantilla-curso/vendor/campusia-sdk-0.3.0.tgz").split()[0]
        yield i
    finally:
        c.borrar()


def instalar(i):
    return i.c.ejecutar(f"{INSTALADOR} {i.commit}", timeout=300)


@pytest.mark.aceptacion
def test_instalador_pasa_plantilla_sdk_y_espacio(inst):
    r = instalar(inst)
    assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
    d, argumentos = ultimo(inst.c)
    for opcion in ("--binario", "--interfaz", "--plantilla", "--sdk", "--espacio"):
        assert opcion in argumentos, f"instalar.sh no recibió {opcion}: {argumentos}"
    c = inst.c
    assert c.ok(f"sha256sum {d}/plantilla/vendor/campusia-sdk-0.3.0.tgz").split()[0] == inst.suma_tgz
    esperado = c.ok(f"git -C {TRABAJO} show {inst.commit}:plantilla-curso/package.json")
    assert c.ok(f"cat {d}/plantilla/package.json") == esperado, "la plantilla tiene que salir del commit publicado, no de las fuentes"
    c.ok(f"test -f {d}/sdk/package.json && test -f {d}/sdk/src/index.ts && test -f {d}/sdk/dist/index.js")
    c.ok(f"test ! -e {d}/sdk/node_modules")
    c.ok(f"test -f {d}/espacio/Containerfile")
    assert c.ok(f"find -P {d} -type l").strip() == ""


@pytest.mark.ataque
@pytest.mark.parametrize("caso", ["tgz_enlace", "vendor_enlace", "dist_con_enlace", "dist_enlace"])
def test_instalador_rechaza_enlaces_en_el_sdk(inst, caso):
    f = inst.fuentes
    preparar = {
        "tgz_enlace": f"mv {f}/plantilla-curso/vendor/campusia-sdk-0.3.0.tgz /tmp/tgz && ln -s /etc/shadow {f}/plantilla-curso/vendor/campusia-sdk-0.3.0.tgz",
        "vendor_enlace": f"mv {f}/plantilla-curso/vendor /tmp/vendor && mkdir -p /tmp/falso && cp /tmp/vendor/* /tmp/falso/ && ln -s /tmp/falso {f}/plantilla-curso/vendor",
        "dist_con_enlace": f"ln -s /etc/shadow {f}/sdk/dist/robado.js",
        "dist_enlace": f"mv {f}/sdk/dist /tmp/dist && ln -s /tmp/dist {f}/sdk/dist",
    }[caso]
    deshacer = {
        "tgz_enlace": f"rm -f {f}/plantilla-curso/vendor/campusia-sdk-0.3.0.tgz && mv /tmp/tgz {f}/plantilla-curso/vendor/campusia-sdk-0.3.0.tgz",
        "vendor_enlace": f"rm -f {f}/plantilla-curso/vendor && mv /tmp/vendor {f}/plantilla-curso/vendor && rm -rf /tmp/falso",
        "dist_con_enlace": f"rm -f {f}/sdk/dist/robado.js",
        "dist_enlace": f"rm -f {f}/sdk/dist && mv /tmp/dist {f}/sdk/dist",
    }[caso]
    antes = inst.c.ok(f"cat {RECIBIDO}/ultimo 2>/dev/null || true")
    inst.c.ok(preparar, usuario="campusia")
    try:
        r = instalar(inst)
        assert r.returncode != 0, f"el instalador aceptó un SDK con enlaces ({caso})\n{r.stdout}\n{r.stderr}"
        assert inst.c.ok(f"cat {RECIBIDO}/ultimo 2>/dev/null || true") == antes, "instalar.sh no tenía que correr"
    finally:
        inst.c.ejecutar(deshacer, usuario="campusia")


@pytest.mark.aceptacion
def test_fuentes_sin_sdk_empaquetado_conservan_la_plataforma(inst):
    f = inst.fuentes
    inst.c.ok(f"mv {f}/plantilla-curso/vendor /tmp/vendor-guardado", usuario="campusia")
    try:
        r = instalar(inst)
        assert r.returncode == 0, f"{r.stdout}\n{r.stderr}"
        assert "se conservan la plantilla" in r.stderr
        _, argumentos = ultimo(inst.c)
        assert "--binario" in argumentos and "--interfaz" in argumentos
        for opcion in ("--plantilla", "--sdk", "--espacio"):
            assert opcion not in argumentos
    finally:
        inst.c.ejecutar(f"mv /tmp/vendor-guardado {f}/plantilla-curso/vendor", usuario="campusia")
    r = instalar(inst)
    assert r.returncode == 0
    assert "--plantilla" in ultimo(inst.c)[1]
