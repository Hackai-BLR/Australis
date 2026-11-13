import shutil

import pytest

from conftest import CONTINUO, correr

IMAGEN = "python:3.12-slim-bookworm"

GUION = r'''
set -euo pipefail
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq git >/dev/null 2>&1
useradd -r -m -d /srv/campusia -s /bin/bash campusia
mkdir -p /etc/campusia /srv/origen /root/recibido
install -m 755 /continuo/campusia-instalar /usr/local/sbin/campusia-instalar
D=/srv/campusia/despliegue
printf 'INSTALAR_ORIGEN=/srv/origen/c.git\nINSTALAR_RAMA=main\nDESPLIEGUE_DIR=%s\n' "$D" > /etc/campusia/instalar.env
git init -q --bare -b main /srv/origen/c.git
git init -q -b main /srv/origen/w
cd /srv/origen/w
git config user.email p@e.com
git config user.name p
git remote add origin /srv/origen/c.git
mkdir -p despliegue backend frontend
cat > despliegue/instalar.sh <<'FIN'
#!/bin/bash
set -euo pipefail
d=/root/recibido/ultimo
rm -rf "$d"; mkdir -p "$d"
printf '%s\n' "$@" > "$d/argumentos"
while [ $# -gt 0 ]; do
  case "$1" in
    --australis-binario) cp -a "$2" "$d/binario"; shift 2 ;;
    --australis-frontend) cp -a "$2" "$d/frontend"; shift 2 ;;
    *) shift ;;
  esac
done
FIN
echo x > backend/a
echo x > frontend/a
git add -A
git commit -q -m uno
git push -q origin main
C="$(git rev-parse HEAD)"
F="$D/fuentes/$C"
mkdir -p "$F/compilado/bin" "$F/interfaz/dist" "$F/frontend/dist/assets"
printf '#!/bin/sh\n' > "$F/compilado/bin/campusia-nucleo"
printf '#!/bin/sh\necho australis\n' > "$F/compilado/bin/australis-server"
chmod 700 "$F/compilado/bin/"*
echo '<!doctype html>' > "$F/interfaz/dist/index.html"
echo '<!doctype html>' > "$F/frontend/dist/index.html"
echo 'console.log(1)' > "$F/frontend/dist/assets/app.js"
chown -R campusia:campusia /srv/campusia
'''

COMPROBAR = r'''
set +e
C="$(git -C /srv/origen/w rev-parse HEAD)"
F=/srv/campusia/despliegue/fuentes/$C
/usr/local/sbin/campusia-instalar "$C"
echo "CODIGO_SANO=$?"
R=/root/recibido/ultimo
grep -q -- '--australis-binario' $R/argumentos && echo ARGUMENTO_BINARIO
grep -q -- '--australis-frontend' $R/argumentos && echo ARGUMENTO_FRONTEND
[ "$(stat -c %a $R/binario)" = 755 ] && echo BINARIO_755
cmp -s $R/binario "$F/compilado/bin/australis-server" && echo BINARIO_IGUAL
[ -f $R/frontend/assets/app.js ] && echo FRONTEND_COMPLETO
rm -rf /root/recibido/ultimo
ln -s /etc/shadow "$F/frontend/dist/assets/robado"
/usr/local/sbin/campusia-instalar "$C" >/dev/null 2>&1
echo "CODIGO_ENLACE=$?"
[ ! -e /root/recibido/ultimo ] && echo NO_INSTALO_CON_ENLACE
rm "$F/frontend/dist/assets/robado"
rm -rf "$F/compilado/bin/australis-server"
/usr/local/sbin/campusia-instalar "$C" >/dev/null 2>&1
echo "CODIGO_SIN_AUSTRALIS=$?"
grep -q -- '--australis-binario' /root/recibido/ultimo/argumentos || echo SIN_ARGUMENTOS_AUSTRALIS
'''


@pytest.mark.aceptacion
@pytest.mark.skipif(shutil.which("docker") is None, reason="hace falta docker")
def test_campusia_instalar_pasa_los_artefactos_de_australis_al_instalador():
    r = correr(
        ["docker", "run", "--rm", "-i", "-v", f"{CONTINUO}:/continuo:ro", IMAGEN, "bash", "-c",
         f"{GUION}\n{COMPROBAR}"],
        timeout=600,
    )
    salida = r.stdout
    assert r.returncode == 0, f"{salida}\n{r.stderr}"
    for marca in ("CODIGO_SANO=0", "ARGUMENTO_BINARIO", "ARGUMENTO_FRONTEND", "BINARIO_755", "BINARIO_IGUAL",
                  "FRONTEND_COMPLETO", "NO_INSTALO_CON_ENLACE", "SIN_ARGUMENTOS_AUSTRALIS"):
        assert marca in salida, f"falta {marca}\n{salida}\n{r.stderr}"
    assert "CODIGO_ENLACE=0" not in salida
