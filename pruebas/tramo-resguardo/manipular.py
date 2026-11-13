import hashlib
import io
import os
import sys
import tarfile

origen, destino, caso = sys.argv[1], sys.argv[2], sys.argv[3]
extra = sys.argv[4] if len(sys.argv) > 4 else ""
os.makedirs(destino, exist_ok=True)
tgz_origen = os.path.join(origen, "respaldo.tar.gz")
tgz = os.path.join(destino, "respaldo.tar.gz")
sha = os.path.join(destino, "respaldo.tar.gz.sha256")


def sumar(datos):
    return hashlib.sha256(datos).hexdigest()


def escribir_suma():
    with open(tgz, "rb") as f:
        s = sumar(f.read())
    with open(sha, "w") as f:
        f.write(s + "  respaldo.tar.gz\n")


with open(tgz_origen, "rb") as f:
    crudo = f.read()

if caso in ("byte", "suma-cero", "sin-suma"):
    if caso == "byte":
        b = bytearray(crudo)
        b[len(b) // 2] ^= 0xFF
        crudo = bytes(b)
    with open(tgz, "wb") as f:
        f.write(crudo)
    if caso == "byte":
        with open(os.path.join(origen, "respaldo.tar.gz.sha256")) as e, open(sha, "w") as s:
            s.write(e.read())
    elif caso == "suma-cero":
        with open(sha, "w") as f:
            f.write("0" * 64 + "  respaldo.tar.gz\n")
    sys.exit(0)

if caso == "truncado":
    with open(tgz, "wb") as f:
        f.write(crudo[: len(crudo) // 2])
    escribir_suma()
    sys.exit(0)

miembros = []
with tarfile.open(fileobj=io.BytesIO(crudo), mode="r:gz") as t:
    for m in t.getmembers():
        datos = t.extractfile(m).read() if m.isfile() else None
        miembros.append([m, datos])

prefijo = "./" if any(m.name.startswith("./") for m, _ in miembros) else ""


def limpio(nombre):
    return nombre[2:] if nombre.startswith("./") else nombre


def buscar(nombre):
    for par in miembros:
        if limpio(par[0].name) == nombre:
            return par
    raise SystemExit("no está en el tar: " + nombre)


manifiesto_par = buscar("MANIFIESTO.sha256")
lineas = manifiesto_par[1].decode().splitlines()


def manifiesto_poner(nombre, datos):
    global lineas
    lineas = [l for l in lineas if limpio(l[66:]) != nombre]
    lineas.append(sumar(datos) + "  " + prefijo + nombre)


def agregar_archivo(nombre, datos, al_manifiesto):
    info = tarfile.TarInfo(nombre)
    info.size = len(datos)
    info.mode = 0o600
    miembros.append([info, datos])
    if al_manifiesto:
        manifiesto_poner(limpio(nombre), datos)


def reemplazar(nombre, datos, al_manifiesto):
    par = buscar(nombre)
    par[1] = datos
    par[0].size = len(datos)
    if al_manifiesto:
        manifiesto_poner(nombre, datos)


if caso == "contenido":
    reemplazar("archivos/entregas/2026/leeme.txt", b"alterado\n", False)
elif caso == "extra":
    agregar_archivo(prefijo + "archivos/extra.txt", b"de mas\n", False)
elif caso == "faltante":
    par = buscar("archivos/entregas/2026/leeme.txt")
    miembros.remove(par)
elif caso == "escape":
    agregar_archivo("../fuera.txt", b"escape\n", True)
elif caso == "escape-profundo":
    agregar_archivo(prefijo + "archivos/../../fuera2.txt", b"escape\n", True)
elif caso == "absoluta":
    agregar_archivo(extra, b"absoluta\n", True)
elif caso == "enlace":
    info = tarfile.TarInfo(prefijo + "archivos/enlace")
    info.type = tarfile.SYMTYPE
    info.linkname = "/etc/passwd"
    miembros.append([info, None])
elif caso == "enlace-pasaje":
    info = tarfile.TarInfo(prefijo + "archivos/pasaje")
    info.type = tarfile.SYMTYPE
    info.linkname = extra
    miembros.append([info, None])
    agregar_archivo(prefijo + "archivos/pasaje/escrito.txt", b"pasaje\n", True)
elif caso == "duro":
    info = tarfile.TarInfo(prefijo + "archivos/duro")
    info.type = tarfile.LNKTYPE
    info.linkname = prefijo + "plataforma/campusia.db"
    miembros.append([info, None])
elif caso == "fifo":
    info = tarfile.TarInfo(prefijo + "archivos/tubo")
    info.type = tarfile.FIFOTYPE
    miembros.append([info, None])
elif caso == "base-rota":
    reemplazar("plataforma/campusia.db", b"SQLite format 3\x00" + os.urandom(8192), True)
elif caso == "bundle-roto":
    reemplazar("cursos/algebra-1/repo.bundle", b"# v2 git bundle\n" + os.urandom(2048), True)
elif caso == "manifiesto-escape":
    lineas.append(sumar(b"x") + "  ../../fuera3.txt")
elif caso == "sin-manifiesto":
    miembros.remove(manifiesto_par)
elif caso == "sin-base":
    par = buscar("plataforma/campusia.db")
    miembros.remove(par)
    lineas = [l for l in lineas if limpio(l[66:]) != "plataforma/campusia.db"]
else:
    raise SystemExit("caso desconocido: " + caso)

if manifiesto_par in miembros:
    nuevo = ("\n".join(lineas) + "\n").encode()
    manifiesto_par[1] = nuevo
    manifiesto_par[0].size = len(nuevo)

with tarfile.open(tgz, "w:gz", format=tarfile.GNU_FORMAT) as t:
    for m, datos in miembros:
        t.addfile(m, io.BytesIO(datos) if datos is not None else None)
escribir_suma()
