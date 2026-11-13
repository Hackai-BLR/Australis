# Tramo resguardo: respaldo, restauración y Docker sin root

_Creado: 2026-11-10 05:00. Rama `tramo-resguardo`. Corrió en paralelo con la fase 1 del núcleo. Contrato: `contratos/tramo-resguardo.md`._

## 1. Qué se hizo

Scripts de servidor, unidades de systemd y pruebas de punta a punta. No hay rutas de API ni pantallas nuevas; el prototipo no cambia.

| Archivo | Qué hace |
|---|---|
| `despliegue/respaldo/respaldar.sh` | Respaldo consistente: `sqlite3 .backup` de `datos/campusia.db` y de cada base de curso, `git bundle create --all` de cada repo de curso, copia de `archivos/` sin seguir enlaces, `MANIFIESTO.sha256`, tar.gz con su `.sha256`. Candado con `flock`, `umask 077`, armado en carpeta temporal dentro de `respaldos/` y renombre atómico. Rotación de 7 diarios y 4 semanales ISO |
| `despliegue/respaldo/restaurar.sh` | Verificación completa antes de tocar nada (suma, tar, tipos y rutas de entradas, manifiesto exacto, `PRAGMA integrity_check`, `git bundle verify`). Modo normal: detiene `campusia.service`, mueve lo actual a `previo-<fecha>/`, restaura y arranca de nuevo. Modo de prueba `--destino DIR`. Dueños `campusia:campusia` y permisos solo para el dueño |
| `despliegue/respaldo/campusia-respaldo.service` y `.timer` | Oneshot como `campusia`, endurecido; timer diario 04:30 con `Persistent=true` |
| `despliegue/respaldo/litestream.yml` | Ejemplo desactivado para replicar `campusia.db` a R2; credenciales solo por variables |
| `despliegue/docker/preparar-docker.sh` | Como root en Debian 13, idempotente: repo oficial de Docker, `docker-ce-rootless-extras` y dependencias, linger, verificación de subuid y subgid, Docker del sistema deshabilitado, `campusia` fuera del grupo `docker`, delegación de cgroups v2, `dockerd-rootless-setuptool.sh install`, prueba con `hello-world` con y sin límites de CPU y memoria, drop-in `campusia.service.d/docker.conf` con `DOCKER_HOST` y `XDG_RUNTIME_DIR` |
| `pruebas/tramo-resguardo/` | Aceptación y ataque (ver sección 5) |

## 2. Cómo se compila

No hay compilación. Son scripts de bash y unidades de systemd.

## 3. Cómo se levanta (en el servidor, lo hace el orquestador)

El repo se despliega en `/srv/campusia/plataforma`.

Docker sin root, una vez, como root:

```
bash /srv/campusia/plataforma/despliegue/docker/preparar-docker.sh
```

Requiere que `campusia` exista con subuid y subgid (al menos 65536). Deja el drop-in del núcleo en `/etc/systemd/system/campusia.service.d/docker.conf`.

Respaldo diario:

```
cp /srv/campusia/plataforma/despliegue/respaldo/campusia-respaldo.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now campusia-respaldo.timer
```

Respaldo manual: `systemctl start campusia-respaldo.service`. Restaurar: `restaurar.sh /srv/campusia/respaldos/<AAAAMMDD-HHMMSS>`; para probar sin tocar producción, `restaurar.sh --destino /tmp/prueba <respaldo>`.

Litestream queda desactivado; los pasos de activación están en el contrato, sección 7.

## 4. Cómo se prueba

Desde la raíz del repo, sin pasos manuales:

```
bash pruebas/tramo-resguardo/correr.sh
```

Una sola: `bash pruebas/tramo-resguardo/correr.sh ataque_respaldo`. Necesita `bash`, `python3`, `sqlite3`, `git`, `tar`, `gzip`, `sha256sum`, `flock` y Docker sin sudo (imagen `debian:trixie` para el Debian simulado y `koalaman/shellcheck:v0.10.0` si no hay `shellcheck` local). Todo corre en carpetas temporales que simulan `/srv/campusia`.

## 5. Resultado de las pruebas

| Archivo | Tipo | Resultado |
|---|---|---|
| `estatico.sh` | aceptación | 49/49 |
| `aceptacion_respaldo.sh` | aceptación | 58/58 |
| `aceptacion_rotacion.sh` | aceptación | 18/18 |
| `aceptacion_docker.sh` | aceptación | 50/50 |
| `ataque_respaldo.sh` | ataque | 150/150 |
| `ataque_docker.sh` | ataque | 27/27 |

Aceptación 175/175, ataque 177/177. `shellcheck -s bash -S warning` sin advertencias en los tres scripts (con la imagen `koalaman/shellcheck:v0.10.0`).

## 6. Decisiones

- Formato del respaldo: una carpeta `<AAAAMMDD-HHMMSS>` en UTC con `respaldo.tar.gz` y `respaldo.tar.gz.sha256`; adentro, `MANIFIESTO.sha256` con todos los archivos. El restaurador rechaza archivos de más o de menos, enlaces, rutas absolutas o con `..`.
- Los repos de curso se respaldan como `git bundle --all` y se restauran como repo con árbol de trabajo, mismas ramas, etiquetas y `HEAD`, sin remotos.
- `config/campusia.env` nunca entra, ni por enlaces plantados en `archivos/` o en `datos/` de un curso: los enlaces no se siguen.
- El id del curso se trata como dato opaco (espacios, comillas, `$`, `;`, guion inicial): sin `eval`, todo entre comillas y `--` antes de rutas.
- Restauración en modo normal guarda lo anterior en `previo-<fecha>/` en lugar de borrarlo, y reinicia el servicio aunque la restauración falle.
- `CAMPUSIA_AHORA` permite simular la hora para probar rotación y nombres.
- Docker sin root para `campusia`, nunca el grupo `docker`. Los comandos de `preparar-docker.sh` se llaman por nombre para poder observarlos con sustitutos en `PATH` dentro de `debian:trixie`, sin red.
- Notas de endurecimiento para la unidad del núcleo en el contrato, sección 8: `ProtectHome=yes` y `PrivateUsers=yes` son incompatibles con Docker sin root; se usa `InaccessiblePaths=/home /root`.

## 7. Desvíos del plan

- El plan ponía copias de seguridad y restauración en la fase 4; se adelantaron a este tramo paralelo. La fase 4 conserva archivos, registro de entregas y sus pruebas de ataque.
- La fase 0 del plan menciona Podman; este tramo usa Docker en modo sin root, según el alcance del tramo.
- `campusia-respaldo.service` tiene `ReadWritePaths=/srv/campusia/respaldos /srv/campusia/datos /srv/campusia/cursos`, no solo `respaldos` como dice el contrato: `sqlite3 .backup` sobre una base en modo WAL necesita escribir el `-shm` junto a la base. Sigue sin acceso a `config/` y sin `EnvironmentFile`.

## 8. Pendientes conocidos

- Probar `preparar-docker.sh` en el servidor real: las pruebas lo corren en `debian:trixie` con sustitutos de `apt-get`, `systemctl`, `loginctl`, `curl`, `docker` y `dockerd-rootless-setuptool.sh`; no ejercitan la instalación real, el linger ni la delegación de cgroups.
- Probar el timer y un ciclo respaldar y restaurar con `systemd` real en el servidor.
- Bucket de R2 y activación de Litestream; subir los respaldos diarios fuera del servidor (hoy quedan solo en `/srv/campusia/respaldos`).
- La unidad `campusia.service` del núcleo (fase 1) tiene que tomar las notas de endurecimiento del contrato y convivir con el drop-in `docker.conf`.
- Al integrar con la fase 1, `correr.sh` de las pruebas completas tiene que incluir también `pruebas/fase-1/`.
- Mostrar el estado de los respaldos en el panel de owner queda para una fase del núcleo.
