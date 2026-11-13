import datetime
import re
import sys

ahora = datetime.datetime.strptime(sys.argv[1], "%Y%m%d-%H%M%S")
diarios = int(sys.argv[2])
semanales = int(sys.argv[3])
nombres = sys.argv[4:]

validos = {}
otros = []
for n in nombres:
    if not re.fullmatch(r"\d{8}-\d{6}", n):
        otros.append(n)
        continue
    try:
        validos[n] = datetime.datetime.strptime(n, "%Y%m%d-%H%M%S")
    except ValueError:
        otros.append(n)

conservar = set(otros)
candidatos = {}
for n, f in validos.items():
    if f > ahora:
        conservar.add(n)
    else:
        candidatos[n] = f

dias = {(ahora.date() - datetime.timedelta(days=i)) for i in range(diarios)}
lunes = ahora.date() - datetime.timedelta(days=ahora.date().weekday())
semanas = {(lunes - datetime.timedelta(weeks=i)) for i in range(semanales)}

mejor_dia = {}
mejor_semana = {}
for n, f in candidatos.items():
    d = f.date()
    if d in dias and (d not in mejor_dia or f > candidatos[mejor_dia[d]]):
        mejor_dia[d] = n
    s = d - datetime.timedelta(days=d.weekday())
    if s in semanas and (s not in mejor_semana or f > candidatos[mejor_semana[s]]):
        mejor_semana[s] = n

conservar |= set(mejor_dia.values()) | set(mejor_semana.values())
print("\n".join(sorted(conservar)))
