# Tramo final de infraestructura

_Creado: 2026-11-10 21:33. Rama `tramo-infraestructura`. Alcance: `.orquestacion/tramo-infraestructura-final.md`. Contrato: `contratos/tramo-infraestructura-final.md` (completa a `contratos/tramo-infraestructura.md` y `contratos/tramo-infraestructura-cierre.md`). Continúa `handoffs/261110_0943_tramo-infraestructura-cierre.md`, que no se modifica._

## 1. Qué se hizo

`origin/main` (fase 4) ya estaba unido a la rama (commit `Unión de main en el tramo de infraestructura (fase 4)`). Desde esa unión `despliegue/campusia-nucleo.service` fija `PROVEEDOR_CONTENEDORES=docker` y el núcleo no arranca sin el Docker sin root de `campusia`, así que Docker sin root y `br_netfilter` pasaron a ser parte de las pruebas de punta a punta.

| Ruta | Cambio |
|---|---|
| `despliegue/Caddyfile` | `handle /_despliegue/webhook` hacia el receptor en `127.0.0.1:9010`. Los tres `handle` quedan dentro de un `route { … }` para que el `abort` de `@fuera_de_cloudflare` se aplique primero también al webhook (sin `route`, Caddy ordena el `handle` con camino antes y el webhook quedaba abierto a cualquier origen). Solo el camino exacto llega al receptor |
| `despliegue/instalar.sh` | instala `respaldo/respaldar.sh` y `restaurar.sh` en `/srv/campusia/plataforma/despliegue/respaldo/` (`root:campusia 0750`) y `campusia-respaldo.service` y `.timer` en systemd (`root:root 0644`), armando todo en temporales y reemplazando con `mv` sin seguir enlaces; `systemctl enable --now campusia-respaldo.timer`; falla con `falta …` si no están los archivos. Espera hasta 120 s la salud del núcleo y muestra el journal si no responde |
| `despliegue/docker/preparar-docker.sh` | instala `kmod` si falta `modprobe`, carga `br_netfilter` y escribe `/etc/modules-load.d/campusia-docker.conf`; arranca `user@<uid>.service` y espera `/run/user/<uid>/bus` antes de `systemctl --user`; escribe `/etc/systemd/user/docker.service.d/campusia-red.conf`; usa `vfs` si la carpeta personal está en overlayfs (contenedor de prueba); el drop-in del núcleo espera a que `docker version` responda |
| rol `base` | instala `tzdata`, enlaza `/etc/localtime` a `servidor_zona_horaria` (`America/Argentina/Buenos_Aires`), escribe `/etc/timezone` si existe y verifica el enlace. Sin `timedatectl` ni reloj de hardware |
| rol `docker` | `tasks/modulos.yml`: `kmod`, `/etc/modules-load.d/campusia-docker.conf` siempre, `community.general.modprobe br_netfilter`. Variable `docker_sin_root` (`not servidor_contenedor_de_prueba or servidor_docker_sin_root_en_prueba`) que gobierna Docker sin root, la carga del módulo y las verificaciones. Espera el bus del usuario. `campusia-red.conf` con `DOCKERD_ROOTLESS_ROOTLESSKIT_DETACH_NETNS=false` y reinicio de Docker sin root si cambia. Clave de Docker descargada solo si falta. Drop-in del núcleo con `ExecStartPre` que espera a Docker y `StartLimitIntervalSec=0` |
| rol `caddy` | la clave del repositorio de Caddy se descarga solo si falta (antes se pedía en cada corrida) |
| `group_vars/all.yml` | `servidor_zona_horaria` y `servidor_docker_sin_root_en_prueba: false` |
| `infraestructura/README.md` | variables nuevas, secciones "Zona horaria" y "`br_netfilter` y Docker sin root" |
| `contratos/tramo-infraestructura-final.md` | contrato del tramo |
| `pruebas/tramo-infraestructura-final/` | `test_caddy.py`, `test_instalar_respaldo.py`, `test_preparar_docker.py`, `test_servidor.py` y `correr.sh` |
| `pruebas/tramo-infraestructura-cierre/`, `pruebas/tramo-infraestructura/test_secretos.py`, `pruebas/tramo-plantilla-sdk/repo.test.mjs`, `infraestructura/servidor/.ansible-lint` | ajustes listados en "Cambios en pruebas" del contrato |

## 2. Cómo se compila

No hay compilación propia del tramo. El binario y la interfaz se compilan en contenedores con la etapa por defecto del despliegue continuo (las pruebas lo hacen solas):

```
bash despliegue/continuo/desplegar.sh --etapa compilar
```

## 3. Cómo se levanta y se despliega

Igual que en el cierre: un servidor nuevo (Debian 12/13, Ubuntu 22.04/24.04) se levanta con

```
CAMPUSIA_IP=<ip nueva> CLOUDFLARE_API_TOKEN="$(cat ~/.config/campusia/cloudflare-token)" \
TOFU_FRASE_ESTADO="$(cat ~/.config/campusia/tofu-frase)" ANSIBLE_VAULT_CONTRASENA="$(cat ~/.config/campusia/vault-pass)" \
[CAMPUSIA_RESPALDO=<carpeta o respaldo.tar.gz>] infraestructura/levantar.sh
```

Ahora además deja `br_netfilter` cargado y persistido, la zona horaria de Buenos Aires, los guiones y unidades de respaldo instalados con `campusia-respaldo.timer` habilitado (04:30 hora local) y el webhook `https://campusia.tech/_despliegue/webhook` publicado por Caddy hacia el receptor. Después el despliegue continuo sigue solo (temporizador de 5 minutos o webhook de GitHub firmado con `SECRETO_WEBHOOK`).

En un servidor ya levantado alcanza con volver a correr el playbook (`ansible-playbook -i inventario.yml sitio.yml …`) y esperar al próximo despliegue de `main` para que `instalar.sh` instale el respaldo y el Caddyfile nuevos.

## 4. Cómo se prueba

Desde cero, sin pasos manuales (varias horas con las anteriores; conviene en segundo plano):

```
bash pruebas/tramo-infraestructura-final/correr.sh
```

Corre `pruebas/tramo-infraestructura-cierre/correr.sh` (que incluye el tramo de infraestructura y las suites de fases), después `pytest` en `pruebas/tramo-infraestructura-final/` e imprime los totales combinados. `SOLO_FINAL=1` omite las anteriores, `FINAL_DISTROS=debian13,ubuntu2404` agrega Ubuntu 24.04 a `test_servidor.py`, `CONSERVAR_CONTENEDORES=1` deja los contenedores. Requiere Docker con `--privileged`, `/lib/modules` montable y `br_netfilter` disponible en el kernel del anfitrión.

Resultado de la última corrida completa:

- aceptación: 112/113
- ataque: 182/183

Las dos que fallaron son de las pruebas del cierre en Ubuntu 24.04 y no son defectos del código:

| Prueba | Tipo | Error | Causa |
|---|---|---|---|
| `pruebas/tramo-infraestructura-cierre/test_levantar.py::test_segunda_corrida_idempotente[ubuntu2404]` | aceptación (error en el fixture `dos_veces`) | la segunda corrida de `levantar.sh` falló en `TASK [caddy : Descargar la clave del repositorio oficial de Caddy]` con `Temporary failure in name resolution` (`dl.cloudsmith.io`); `ansible-playbook` salió con 2 | falla transitoria de DNS dentro del contenedor de prueba; todas las tareas anteriores dieron `ok` con `changed=0`. Al volver a correr solo estas pruebas en Ubuntu 24.04 pasaron (2 passed), y en la misma corrida pasaron la variante Debian y `test_segunda_corrida_sin_cambios` del tramo final |
| `pruebas/tramo-infraestructura-cierre/test_levantar.py::test_respaldo_alterado_no_se_restaura[ubuntu2404]` | ataque (error en setup) | el mismo fallo heredado del fixture de la segunda corrida | la misma falla de DNS; al volver a correrla pasó |

Para reducir esa dependencia de la red, el rol `caddy` ahora solo descarga la clave si no existe (igual que la de Docker), así las corridas idempotentes ya no piden `gpg.key`. Ese cambio es posterior a la corrida completa y no se volvió a correr la suite entera.

## 5. Decisiones

- `route { … }` en el Caddyfile en lugar de un `abort @fuera_de_cloudflare` suelto: mantiene el bloque `handle @fuera_de_cloudflare` original y fija el orden de evaluación de forma explícita. El webhook lleva los mismos `header_up` que el núcleo.
- Zona horaria con enlace de `/etc/localtime` y `/etc/timezone` en vez de `community.general.timezone`: funciona en contenedores de prueba sin `timedatectl` y es idempotente.
- `servidor_docker_sin_root_en_prueba` permite correr Docker sin root real en las pruebas (contenedores `--privileged` con `/lib/modules`), sin cambiar el comportamiento de producción.
- `DOCKERD_ROOTLESS_ROOTLESSKIT_DETACH_NETNS=false`: con el modo `detach-netns` de Docker 29 el `nsenter -U -n -t <child_pid>` que usa el núcleo para abrir la escucha de la API de cursos fallaba a veces con `Operation not permitted`.
- `vfs` como controlador de almacenamiento de Docker sin root solo cuando la carpeta personal está en overlayfs (pasa dentro de los contenedores de prueba); en un servidor real no se toca `daemon.json`.
- El drop-in del núcleo espera hasta 90 s a `docker version` y quita el límite de reinicios, porque el núcleo de `main` sale con error si la red de cursos no se puede preparar.
- `instalar.sh` arma la carpeta de respaldo en un temporal dentro de `$PLATAFORMA` y la reemplaza con `mv`, borrando enlaces sin seguirlos, para que `campusia` no pueda redirigir la escritura de root.

## 6. Desvíos del plan

- `preparar-docker.sh` cambió más de lo que pedía el alcance: además de `br_netfilter` y la espera del bus, escribe `campusia-red.conf`, usa `vfs` en overlayfs y el drop-in espera a Docker. Hizo falta para que `test_preparar_docker.py` y el núcleo funcionen.
- `instalar.sh` espera la salud del núcleo hasta 120 s (antes 30) porque ahora el arranque espera a Docker sin root.
- Se ajustaron pruebas de tramos anteriores (cierre, `test_secretos.py`, `tramo-plantilla-sdk/repo.test.mjs`); cada cambio está justificado en "Cambios en pruebas" del contrato y ninguna aserción se debilitó.
- `respaldo/` y `continuo/` no cambiaron.

## 7. Pendientes conocidos

- Volver a correr la suite completa con el cambio del rol `caddy` (clave solo si falta) para confirmar 113/113 y 183/183; las dos pruebas que fallaron dependen de la red del contenedor.
- Correr `levantar.sh` contra un VPS real y confirmar el DNS con OpenTofu real (las pruebas usan un `tofu` falso).
- Configurar en GitHub el webhook hacia `https://campusia.tech/_despliegue/webhook` con el secreto de `SECRETO_WEBHOOK` y verificar un `ping` real a través de Cloudflare.
- En el servidor actual, `br_netfilter` se había arreglado a mano: correr el playbook para que quede persistido por el rol.
- Ubuntu 22.04 y Debian 12 están admitidos por el rol `base` pero las pruebas de punta a punta solo cubren Debian 13 y Ubuntu 24.04.
- La IP real sigue en el historial de git de commits viejos de la rama (no se reescribió la historia).
