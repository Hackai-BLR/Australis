# M1: Australis en el servidor

_Creado: 2026-11-13 03:00. Rama `feat/m1-deploy-australis`, desde `main` (fase 0 de `docs/plan.md`). Contrato: `contratos/tramo-australis.md`. No se hizo merge a `main`._

## Problema

El servidor solo instalaba el núcleo de Campus IA. Australis (`backend/` y `frontend/`) no tenía servicio, ni despliegue continuo, ni respaldo.

## Qué se hizo

- `despliegue/campusia-australis.service` y `despliegue/australis.env.ejemplo`: segundo servicio de systemd en `127.0.0.1:8090`, con base y subidas bajo `/srv/campusia/australis/`.
- `despliegue/instalar.sh`: opciones `--australis-binario` y `--australis-frontend`; instala el binario, el frontend y la unidad, reinicia los dos servicios y espera la salud de cada uno.
- `despliegue/continuo/desplegar.sh`: pruebas, compilación y comprobación de salud de Australis junto a las del núcleo; copia previa de su base; la reversión reinstala los dos juntos.
- `despliegue/continuo/campusia-instalar`: extrae el binario y `frontend/dist` de las fuentes con las mismas defensas contra enlaces que el núcleo.
- `despliegue/respaldo/`: `respaldar.sh` y `restaurar.sh` incluyen la base y las subidas de Australis; la unidad de respaldo puede escribir en su carpeta; `litestream.yml` replica la segunda base.
- `infraestructura/servidor/roles/campusia/`: Ansible genera `australis.env` (sin secretos nuevos en el Vault).
- `pruebas/tramo-infraestructura-australis/` (nuevo) y dos pruebas más en `pruebas/tramo-infraestructura-cierre/test_compilacion.py`.

## Decisiones

- Caddy no cambia. El reenvío del tráfico a Australis es de la tarea M2.
- Un commit sin `compilado/bin/australis-server` se instala como antes y su salud no pide el puerto 8090, para que la vuelta atrás a un commit anterior a este cambio siga funcionando.
- `DATABASE_URL`, `BIND_ADDR` y `UPLOAD_DIR` los fija la unidad: un `EnvironmentFile` pisa a `Environment=`, por eso Ansible los rechaza en `australis.env`.

## Pendiente

- Nada se corrió contra el servidor real ni contra Cloudflare. Falta correr `pruebas/tramo-infraestructura-cierre/correr.sh` completo (Ansible y systemd en contenedores) en una máquina con Docker privilegiado: el stub de compilación de `test_levantar.py` no produce Australis, así que esa prueba cubre el núcleo como antes y no el segundo servicio.
- La reversión no restaura datos de Australis (misma política que el núcleo); la copia previa queda en `despliegue/previos/<commit>-australis.db`.
- `restaurar.sh` en su lugar asume que `campusia-australis.service` existe cuando el respaldo trae `australis/`.
