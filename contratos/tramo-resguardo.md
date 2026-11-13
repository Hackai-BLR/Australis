# Contrato del tramo: resguardo y Docker sin root

_Creado: 2026-11-10. Rama `tramo-resguardo`. Corre en paralelo con la fase 1 del núcleo._

## 1. Alcance

Este tramo no agrega rutas de API ni pantallas. Entrega scripts de servidor y unidades de systemd:

| Carpeta | Contenido |
|---|---|
| `despliegue/respaldo/` | `respaldar.sh`, `restaurar.sh`, `campusia-respaldo.service`, `campusia-respaldo.timer`, `litestream.yml` |
| `despliegue/docker/` | `preparar-docker.sh` |
| `pruebas/tramo-resguardo/` | Pruebas de aceptación y de ataque |
| `contratos/tramo-resguardo.md` | Este contrato |

No se toca ningún otro archivo de `despliegue/` ni `nucleo/`, `interfaz/`, `plantilla-curso/`, `sdk/`.

### API e interfaz

- Rutas de la API: ninguna. El tramo no expone nada por HTTP.
- Flujos de la interfaz: ninguno. El prototipo (`prototipo/campus.html`) no tiene pantallas de respaldo; el panel de owner (Uso y proveedores) y el de administrador (Configuración, Actividad) no cambian. Si más adelante se muestra el estado de los respaldos en el panel de owner, se lee del directorio de respaldos y se agrega en una fase del núcleo.

### Quién puede ejecutar qué

| Acción | Quién |
|---|---|
| `respaldar.sh` | El usuario `campusia` (lo lanza `campusia-respaldo.timer`) o root |
| `restaurar.sh` | Root o `campusia`. Con root, puede detener e iniciar `campusia.service` |
| `restaurar.sh --destino` | Cualquier usuario con escritura en el destino. Nunca detiene servicios |
| `preparar-docker.sh` | Solo root. Si no corre como root sale con error sin cambiar nada |

## 2. Modelo de datos del servidor

No hay migraciones: el tramo no crea tablas. Trabaja sobre esta estructura (la crean otras fases):

```
/srv/campusia/                     CAMPUSIA_RAIZ
├── datos/campusia.db              base de la plataforma (SQLite, puede estar en modo WAL y en uso)
├── cursos/<id>/                   repo de git con árbol de trabajo (ramas main y prueba, etiquetas vN)
│   └── datos/                     ignorado por git; bases del curso (*.db, *.sqlite, *.sqlite3) y otros archivos
├── archivos/                      archivos de la plataforma (árbol arbitrario)
├── config/campusia.env            secretos; nunca entra en un respaldo
└── respaldos/                     CAMPUSIA_RESPALDOS
    └── <AAAAMMDD-HHMMSS>/
        ├── respaldo.tar.gz
        └── respaldo.tar.gz.sha256
```

El `<id>` de un curso es el nombre de su carpeta y los scripts lo tratan como dato opaco: puede tener espacios, acentos, comillas, `$`, `;`, paréntesis o empezar con `-`. Nunca se interpreta como código ni como opción.

### Formato del respaldo

Cada respaldo es una carpeta `<AAAAMMDD-HHMMSS>` (hora UTC) dentro de `CAMPUSIA_RESPALDOS` con dos archivos:

- `respaldo.tar.gz`: tar comprimido con gzip, con entradas relativas (sin `/` inicial, sin `..`, sin carpeta raíz envolvente). Solo contiene carpetas y archivos regulares; nunca enlaces simbólicos, enlaces duros ni dispositivos.
- `respaldo.tar.gz.sha256`: una línea en formato `sha256sum`: `<suma>  respaldo.tar.gz`.

Contenido del tar:

| Entrada | Origen |
|---|---|
| `MANIFIESTO.sha256` | Una línea por cada archivo regular del tar salvo él mismo, en formato `sha256sum` con la ruta relativa a la raíz del tar |
| `plataforma/campusia.db` | `sqlite3 datos/campusia.db ".backup ..."`: copia consistente, incluye lo que está en el WAL |
| `cursos/<id>/repo.bundle` | `git bundle create ... --all` del repo del curso |
| `cursos/<id>/datos/<ruta>` | Bases (`*.db`, `*.sqlite`, `*.sqlite3`) con `.backup`; los `-wal`, `-shm` y `-journal` se omiten; el resto se copia tal cual |
| `archivos/<ruta>` | Copia de `archivos/`. Los enlaces simbólicos no se siguen ni se copian |

Nunca contiene `config/` ni el contenido de `config/campusia.env`, ni `respaldos/`, ni carpetas `previo-*`.

## 3. Variables de entorno

| Variable | Valor por defecto | Usa | Para qué |
|---|---|---|---|
| `CAMPUSIA_RAIZ` | `/srv/campusia` | ambos | Raíz de datos; de ahí salen `datos/`, `cursos/`, `archivos/`, `config/` |
| `CAMPUSIA_RESPALDOS` | `$CAMPUSIA_RAIZ/respaldos` | ambos | Dónde se escriben y rotan los respaldos |
| `CAMPUSIA_AHORA` | `date -u +%Y%m%d-%H%M%S` | ambos | Hora simulada `AAAAMMDD-HHMMSS` (UTC) para el nombre del respaldo, la rotación y el nombre de `previo-*` |
| `RESPALDO_DIARIOS` | `7` | `respaldar.sh` | Días calendario con respaldo diario |
| `RESPALDO_SEMANALES` | `4` | `respaldar.sh` | Semanas ISO con respaldo semanal |
| `CAMPUSIA_USUARIO` | `campusia` | `restaurar.sh` | Dueño de lo restaurado |
| `CAMPUSIA_GRUPO` | `campusia` | `restaurar.sh` | Grupo de lo restaurado |
| `RESTAURAR_DETENER` | `si` | `restaurar.sh` | `si`: `systemctl stop` del servicio antes de restaurar en `CAMPUSIA_RAIZ` y `systemctl start` al final. `no`: no toca servicios |
| `CAMPUSIA_SERVICIO` | `campusia.service` | `restaurar.sh` | Unidad que se detiene y se inicia |

Ninguna variable lleva secretos. `litestream.yml` usa `LITESTREAM_ACCESS_KEY_ID` y `LITESTREAM_SECRET_ACCESS_KEY`, que viven solo en el archivo de entorno del servidor.

Dependencias del servidor: `bash`, `sqlite3`, `git`, `tar`, `gzip`, `sha256sum`, `flock`, `find`.

## 4. `despliegue/respaldo/respaldar.sh`

Uso: `respaldar.sh` (sin argumentos).

1. Toma un candado (`flock`) sobre `CAMPUSIA_RESPALDOS/.candado`; si otro respaldo está corriendo sale con código 1.
2. Trabaja con `umask 077`. Crea `CAMPUSIA_RESPALDOS` si falta, con modo `0700`.
3. Arma el contenido en una carpeta temporal dentro de `CAMPUSIA_RESPALDOS` cuyo nombre empieza con `.` (no en `/tmp`), escribe `MANIFIESTO.sha256`, comprime, escribe la suma y recién entonces renombra a `<CAMPUSIA_AHORA>/`. Si algo falla, borra lo temporal y sale con código distinto de 0 sin dejar un respaldo a medias.
4. Si ya existe un respaldo con ese nombre sale con código 1 sin tocarlo.
5. Permisos: la carpeta del respaldo `0700`, sus archivos `0600`.
6. Imprime en la última línea de la salida estándar la ruta absoluta de la carpeta creada.
7. Rota (ver abajo) y sale con 0.

### Rotación

Se consideran solo las carpetas de `CAMPUSIA_RESPALDOS` cuyo nombre es exactamente `AAAAMMDD-HHMMSS` con fecha válida. Las de nombre posterior a `CAMPUSIA_AHORA` y todo lo que no cumple el formato no se tocan. Del resto se conservan:

- Diarios: el más reciente de cada uno de los `RESPALDO_DIARIOS` días calendario que terminan en el día de `CAMPUSIA_AHORA` (ese día y los 6 anteriores).
- Semanales: el más reciente de cada una de las `RESPALDO_SEMANALES` semanas ISO (lunes a domingo) que terminan en la semana de `CAMPUSIA_AHORA` (esa semana y las 3 anteriores).

Todo lo demás se borra. El respaldo recién creado siempre queda.

## 5. `despliegue/respaldo/restaurar.sh`

Uso: `restaurar.sh [--destino DIR] <respaldo>`. `<respaldo>` es la carpeta `<AAAAMMDD-HHMMSS>` o la ruta a su `respaldo.tar.gz`.

Códigos de salida: `0` restaurado; `1` uso incorrecto, `<respaldo>` inexistente o destino no válido; `3` el respaldo no pasó la verificación (incluye que falte `respaldo.tar.gz.sha256`).

1. Verificación completa antes de tocar nada:
   - la suma de `respaldo.tar.gz` coincide con `respaldo.tar.gz.sha256`;
   - el tar se lee entero sin errores;
   - todas las entradas son carpetas o archivos regulares, con rutas relativas y sin componentes `..`;
   - `MANIFIESTO.sha256` existe, sus rutas cumplen lo mismo, cada archivo listado existe y su suma coincide, y no hay archivos regulares fuera del manifiesto;
   - `plataforma/campusia.db` existe y pasa `PRAGMA integrity_check`; cada `cursos/<id>/repo.bundle` pasa `git bundle verify`.
   Si algo falla sale con 3 y no modifica `CAMPUSIA_RAIZ` ni el destino. La extracción para verificar se hace en una carpeta temporal privada que se borra al salir.
2. Modo de prueba `--destino DIR`: `DIR` no existe o está vacío (si no, sale con 1). Restaura en `DIR/datos/campusia.db`, `DIR/cursos/<id>/`, `DIR/archivos/`. Nunca llama a `systemctl` ni toca `CAMPUSIA_RAIZ`.
3. Modo normal (sin `--destino`): si `RESTAURAR_DETENER=si`, `systemctl stop "$CAMPUSIA_SERVICIO"`. Mueve lo actual que exista (`datos/campusia.db` y sus `-wal`/`-shm`, `cursos/`, `archivos/`) a `CAMPUSIA_RAIZ/previo-<CAMPUSIA_AHORA>/` conservando la misma estructura; restaura en `CAMPUSIA_RAIZ`; si había detenido el servicio, `systemctl start "$CAMPUSIA_SERVICIO"` (también si la restauración falla después de detenerlo). No toca `config/` ni `respaldos/`.
4. Cada curso se restaura como repo de git con árbol de trabajo: mismas `refs/heads/*` y `refs/tags/*` (mismos objetos), mismo `HEAD` simbólico, árbol de trabajo en el commit de `HEAD`, sin remotos configurados. Después se restaura su `datos/`.
5. Dueños y permisos: todo lo restaurado queda con dueño `CAMPUSIA_USUARIO:CAMPUSIA_GRUPO`; `datos/` y cada `cursos/<id>/datos/` con `0700`; `datos/campusia.db` y cada base de curso con `0600`; ningún archivo ni carpeta restaurada con escritura para grupo u otros.

## 6. Unidades de systemd del respaldo

`campusia-respaldo.service`:
- `Type=oneshot`, `User=campusia`, `Group=campusia`, `UMask=0077`.
- `ExecStart=/srv/campusia/plataforma/despliegue/respaldo/respaldar.sh` (el repo de la plataforma se despliega en `/srv/campusia/plataforma`).
- Endurecimiento: `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=strict`, `ReadWritePaths=/srv/campusia/respaldos`, `ProtectHome=yes`.
- No usa `EnvironmentFile=/srv/campusia/config/campusia.env`: el respaldo no necesita secretos.

`campusia-respaldo.timer`:
- `OnCalendar=*-*-* 04:30:00`, `Persistent=true`, `Unit=campusia-respaldo.service`, `[Install] WantedBy=timers.target`.

Instalación (la hace el orquestador): copiar ambas a `/etc/systemd/system/`, `systemctl daemon-reload`, `systemctl enable --now campusia-respaldo.timer`.

## 7. `despliegue/respaldo/litestream.yml`

Ejemplo desactivado para replicar `campusia.db` a R2. No se instala ni se habilita en este tramo.

Requisitos del archivo:
- `dbs:` con `path: /srv/campusia/datos/campusia.db` y una réplica `type: s3`, `bucket: campusia-respaldos`, `path: plataforma`, `endpoint: https://<cuenta>.r2.cloudflarestorage.com`, `region: auto`.
- Credenciales solo como referencias `${LITESTREAM_ACCESS_KEY_ID}` y `${LITESTREAM_SECRET_ACCESS_KEY}`; ninguna clave literal.

Activación (cuando exista el bucket de R2):
1. Crear el bucket `campusia-respaldos` en R2 y un token de API de R2 con permiso de lectura y escritura solo sobre ese bucket.
2. Agregar `LITESTREAM_ACCESS_KEY_ID` y `LITESTREAM_SECRET_ACCESS_KEY` a `/srv/campusia/config/campusia.env` (modo `0600`, dueño `campusia`).
3. Reemplazar `<cuenta>` por el id de cuenta de Cloudflare y copiar el archivo a `/etc/litestream.yml`.
4. Instalar el paquete `.deb` de Litestream desde sus versiones publicadas, crear un drop-in de `litestream.service` con `User=campusia` y `EnvironmentFile=/srv/campusia/config/campusia.env`, y `systemctl enable --now litestream`.
5. Probar con `litestream restore -o /tmp/prueba.db /srv/campusia/datos/campusia.db` y `sqlite3 /tmp/prueba.db "PRAGMA integrity_check"`.
6. Subir también los respaldos diarios: `rclone` o `aws s3 cp` de la carpeta más reciente de `respaldos/` al mismo bucket bajo `diarios/`.

## 8. `despliegue/docker/preparar-docker.sh`

Se corre como root en Debian 13. Idempotente: correrlo dos veces deja el mismo estado y sale con 0 las dos veces.

Pasos y comandos (las pruebas los observan con sustitutos en `PATH`, así que se llaman por nombre, sin rutas absolutas):

1. Si `id -u` no es 0, sale con código distinto de 0 sin hacer nada más.
2. Verifica que `/etc/os-release` sea Debian con `VERSION_CODENAME=trixie`; si no, sale con error.
3. Verifica que exista el usuario `campusia` y que tenga entradas en `/etc/subuid` y `/etc/subgid` con al menos 65536 ids. Si falta algo, sale con error antes de instalar nada.
4. Linger: si no existe `/var/lib/systemd/linger/campusia`, corre `loginctl enable-linger campusia`.
5. Repositorio oficial de Docker: `install -m 0755 -d /etc/apt/keyrings`; `curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc`; un único archivo de fuentes en `/etc/apt/sources.list.d/docker.sources` (formato deb822) o `docker.list`, con `https://download.docker.com/linux/debian`, `trixie`, `stable` y `signed-by` a `/etc/apt/keyrings/docker.asc`. Se escribe completo cada vez (nunca se agregan líneas).
6. `apt-get update` y `apt-get install -y` con `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-ce-rootless-extras`, `uidmap`, `dbus-user-session` y `slirp4netns` o `passt`.
7. Docker con root del sistema deshabilitado: `systemctl disable --now docker.service docker.socket`.
8. Si `campusia` está en el grupo `docker`, lo saca (`gpasswd -d campusia docker`). Nunca lo agrega.
9. Delegación de cgroups v2: escribe `/etc/systemd/system/user@.service.d/delegate.conf` con `[Service]` y `Delegate=cpu cpuset io memory pids`, y `systemctl daemon-reload`.
10. Como `campusia`, con `runuser -u campusia -- env XDG_RUNTIME_DIR=/run/user/<uid> DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus ...`:
    - `dockerd-rootless-setuptool.sh install`
    - `systemctl --user enable --now docker`
    - `docker run --rm hello-world` con `DOCKER_HOST=unix:///run/user/<uid>/docker.sock`
    - `docker run --rm --cpus 0.5 --memory 64m hello-world` con el mismo `DOCKER_HOST`, para comprobar que los límites funcionan sin root.
    Si alguno falla, el script sale con error.
11. Escribe `/etc/systemd/system/campusia.service.d/docker.conf` (drop-in del núcleo) con:
    ```
    [Unit]
    Wants=user@<uid>.service
    After=user@<uid>.service

    [Service]
    Environment=XDG_RUNTIME_DIR=/run/user/<uid>
    Environment=DOCKER_HOST=unix:///run/user/<uid>/docker.sock
    ```
    con el uid real de `campusia`, y `systemctl daemon-reload`.

`<uid>` es `id -u campusia`. El script asume que `/run/user/<uid>` existe una vez activo el linger.

### Notas para la unidad de systemd del núcleo

- Necesita `XDG_RUNTIME_DIR=/run/user/<uid>` y `DOCKER_HOST=unix:///run/user/<uid>/docker.sock` (las pone el drop-in) y `User=campusia`.
- Compatibles: `NoNewPrivileges=yes` (el núcleo solo habla con el socket; `newuidmap` lo usa `dockerd` dentro de `user@<uid>.service`, no el núcleo), `PrivateTmp=yes`, `ProtectSystem=strict` con `ReadWritePaths=/srv/campusia`, `ProtectKernelTunables=yes`, `ProtectKernelModules=yes`, `ProtectControlGroups=yes`, `RestrictSUIDSGID=yes`, `LockPersonality=yes`, `SystemCallFilter=@system-service`, `CapabilityBoundingSet=` vacío.
- `RestrictAddressFamilies` tiene que incluir `AF_UNIX` además de `AF_INET` y `AF_INET6`.
- Incompatibles: `ProtectHome=yes` y `ProtectHome=tmpfs` (ocultan `/run/user`); en su lugar `InaccessiblePaths=/home /root`. `PrivateUsers=yes` (cambia la identidad con la que se habla al socket). `InaccessiblePaths` o `TemporaryFileSystem` sobre `/run/user`.
- El núcleo no necesita el grupo `docker` ni ningún permiso de root.

## 9. Reglas de seguridad

- Nada de `config/` entra en un respaldo, ni siquiera a través de enlaces simbólicos plantados en `archivos/` o en `datos/` de un curso.
- Respaldos y restauraciones con permisos solo para el dueño.
- Un respaldo corrupto, con sumas alteradas, con archivos de más o de menos, con rutas que escapan, con enlaces o con una base rota se rechaza con código 3 sin tocar los datos actuales.
- Los nombres de curso nunca se evalúan: ningún `eval`, ninguna expansión sin comillas, `--` antes de rutas en los comandos que lo admiten.
- `campusia` nunca queda en el grupo `docker`.
- Los scripts pasan `shellcheck -s bash -S warning` sin advertencias (local o con la imagen `koalaman/shellcheck:v0.10.0`) y no tienen comentarios salvo la primera línea `#!/bin/bash`; como no hay comentarios, no se usan directivas `# shellcheck`.

## 10. Cómo se compila, se levanta y se prueba

No hay compilación. Requisitos de la máquina de pruebas: `bash`, `python3`, `sqlite3`, `git`, `tar`, `gzip`, `sha256sum`, `flock` y Docker sin sudo (para la imagen `debian:trixie` y, si falta `shellcheck` local, la imagen `koalaman/shellcheck:v0.10.0`).

Todas las pruebas, desde la raíz del repo:

```
bash pruebas/tramo-resguardo/correr.sh
```

El comando arma `/srv/campusia` simulado en carpetas temporales (bases SQLite con datos y una en modo WAL abierta durante el respaldo, dos o más repos de curso con ramas y etiquetas, archivos), y para `preparar-docker.sh` levanta contenedores `debian:trixie` con sustitutos de `apt-get`, `curl`, `systemctl`, `loginctl`, `dockerd-rootless-setuptool.sh` y `docker` que registran cada llamada. Sale con 0 solo si todas pasan.

| Archivo | Tipo | Qué comprueba |
|---|---|---|
| `estatico.sh` | aceptación | Existen los archivos, `bash -n`, `shellcheck`, unidades y `litestream.yml` |
| `aceptacion_respaldo.sh` | aceptación | Respaldar, borrar, restaurar y comparar tablas, historia de git y sumas; modo `--destino`; modo normal con `previo-*` y `systemctl` |
| `aceptacion_rotacion.sh` | aceptación | Rotación con fechas simuladas |
| `aceptacion_docker.sh` | aceptación | `preparar-docker.sh` en Debian 13 simulado, dos veces |
| `ataque_respaldo.sh` | ataque | Respaldos corruptos o manipulados, nombres raros, secretos, permisos |
| `ataque_docker.sh` | ataque | Sin root, sin subuid, `campusia` en el grupo `docker` |

Una prueba sola: `bash pruebas/tramo-resguardo/correr.sh aceptacion_rotacion`.

Auxiliares: `lib.sh` (aserciones y armado de datos de prueba), `instantanea.py` (vuelca tablas, refs e historia de git, `HEAD`, estado del árbol de trabajo y sumas de archivos para comparar), `mantener_wal.py` (deja la base abierta con filas solo en el WAL), `rotacion_esperada.py` (calcula qué respaldos tienen que quedar), `manipular.py` (fabrica respaldos corruptos o manipulados con sumas recalculadas), `escenario_debian.sh` y `stubs/` (Debian 13 simulado para `preparar-docker.sh`, sin red).

No hay pruebas de fases anteriores en esta rama; cuando se integre con la fase 1, el comando de pruebas completo corre también las de `pruebas/fase-1/`.
