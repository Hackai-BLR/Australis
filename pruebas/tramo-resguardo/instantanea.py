import hashlib
import os
import sqlite3
import subprocess
import sys

BASES = (".db", ".sqlite", ".sqlite3")


def volcado(ruta):
    con = sqlite3.connect("file:" + ruta + "?mode=ro", uri=True)
    try:
        return list(con.iterdump())
    finally:
        con.close()


def suma(ruta):
    h = hashlib.sha256()
    with open(ruta, "rb") as f:
        for bloque in iter(lambda: f.read(65536), b""):
            h.update(bloque)
    return h.hexdigest()


def arbol(raiz, salida, prefijo):
    if not os.path.isdir(raiz):
        salida.append(prefijo + " AUSENTE")
        return
    for actual, dirs, archivos in os.walk(raiz):
        dirs.sort()
        rel = os.path.relpath(actual, raiz)
        salida.append(prefijo + " dir " + repr(rel))
        for nombre in sorted(archivos):
            ruta = os.path.join(actual, nombre)
            relf = os.path.relpath(ruta, raiz)
            if os.path.islink(ruta):
                continue
            if nombre.endswith(("-wal", "-shm", "-journal")):
                continue
            if nombre.endswith(BASES):
                salida.append(prefijo + " base " + repr(relf))
                salida.extend("  " + linea for linea in volcado(ruta))
            else:
                salida.append(prefijo + " archivo " + repr(relf) + " " + suma(ruta))


def git(repo, *args):
    r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)
    return r.stdout.strip()


def main():
    raiz = sys.argv[1]
    salida = []
    db = os.path.join(raiz, "datos", "campusia.db")
    if os.path.isfile(db):
        salida.append("plataforma")
        salida.extend("  " + linea for linea in volcado(db))
    else:
        salida.append("plataforma AUSENTE")
    cursos = os.path.join(raiz, "cursos")
    for curso in sorted(os.listdir(cursos)) if os.path.isdir(cursos) else []:
        repo = os.path.join(cursos, curso)
        salida.append("curso " + repr(curso))
        salida.append("  refs " + git(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"))
        salida.append("  head " + git(repo, "symbolic-ref", "HEAD"))
        salida.append("  commit " + git(repo, "rev-parse", "HEAD"))
        salida.append("  historia " + git(repo, "log", "--all", "--format=%H %P %T %an %ae %at %s"))
        salida.append("  estado " + git(repo, "status", "--porcelain"))
        arbol(os.path.join(repo, "datos"), salida, "  datos")
    arbol(os.path.join(raiz, "archivos"), salida, "archivos")
    print("\n".join(salida))


main()
