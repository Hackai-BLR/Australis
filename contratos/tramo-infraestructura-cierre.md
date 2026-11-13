# Contrato del cierre del tramo infraestructura

_Creado: 2026-11-10. Rama `tramo-infraestructura`. Alcance: `.orquestacion/tramo-infraestructura-cierre.md`. Continúa `contratos/tramo-infraestructura.md`: todo lo que ese contrato fija sigue vigente salvo lo que este documento cambia explícitamente._

`main` ya está unido a la rama (commit `Unión de main en el tramo de infraestructura`): están `despliegue/instalar.sh`, `despliegue/Caddyfile`, `despliegue/campusia-nucleo.service`, `despliegue/campusia.env.ejemplo`, `despliegue/docker/preparar-docker.sh` y `despliegue/respaldo/`. Esos archivos son de otros tramos y no se modifican: se usan tal cual.

Solo se tocan estas carpetas:

| Ruta | Módulo |
|---|---|
| `infraestructura/` (incluye `infraestructura/levantar.sh` y `infraestructura/README.md`) | servidor |
| `despliegue/continuo/` | continuo |
| `contratos/`, `pruebas/tramo-infraestructura/`, `pruebas/tramo-infraestructura-cierre/` | contrato (este documento y las pruebas) |
| `handoffs/` | cierre (un archivo nuevo) |

## 1. Rutas HTTP

Este cierre no agrega rutas a la API del núcleo ni pantallas. Las rutas que intervienen son las existentes:

| Método y ruta | Quién la llama | Uso en este cierre |
|---|---|---|
| `GET /salud` en `127.0.0.1:8080` | el propio servidor (instalador, `desplegar.sh`, `levantar.sh` por SSH) | responde 200 cuando el núcleo está sano. Nunca se expone fuera del servidor: el núcleo escucha solo en `127.0.0.1` |
| `POST /_despliegue/webhook` en `127.0.0.1:9010` | GitHub, a través de Caddy | sin cambios respecto del contrato anterior (sección 1). El Caddyfile definitivo de `main` no tiene todavía el `handle /_despliegue/webhook`; como se instala tal cual, el webhook público queda pendiente para el tramo de despliegue y el disparador efectivo es el temporizador de 5 minutos |
| `https://campusia.tech/*` y `https://*.campusia.tech/*` en el puerto 443 | solo Cloudflare | Caddy del repositorio oficial con `despliegue/Caddyfile`: TLS con el certificado de origen y `abort` para cualquier origen que no sea de Cloudflare |

## 2. Modelo de datos y migraciones

No hay migraciones nuevas. El núcleo aplica las suyas al instalar (`campusia-nucleo migrar` dentro de `instalar.sh`) y al arrancar.

Archivos nuevos en el servidor:

| Ruta | Dueño y permisos | Contenido |
|---|---|---|
| `/srv/campusia` | `campusia:campusia 0750` | igual que lo deja `instalar.sh`, así Ansible y el instalador no se pisan |
| `/srv/campusia/config` | `campusia:campusia 0750` | (antes 0700) igual que lo deja `instalar.sh` |
| `/srv/campusia/config/campusia.env` | `campusia:campusia 0600` | ver sección 3.3 |
| `/srv/campusia/config/continuo.env` | `campusia:campusia 0600` | `DESPLIEGUE_ORIGEN`, `DESPLIEGUE_RAMA` y lo que agregue `despliegue_continuo_env`; formato `CLAVE=valor` de `EnvironmentFile` de systemd |
| `/srv/campusia/config/restaurado` | `root:root 0600` | sha256 (64 hex y salto de línea) del último `respaldo.tar.gz` restaurado por `levantar.sh` |
| `/srv/campusia/previo-<AAAAMMDD-HHMMSS>/` | lo crea `restaurar.sh` | datos anteriores a una restauración |
| `/etc/campusia/` | `root:root 0755` | configuración del instalador con privilegios |
| `/etc/campusia/instalar.env` | `root:root 0644` | `INSTALAR_ORIGEN`, `INSTALAR_RAMA`, `INSTALAR_CLAVE`, `INSTALAR_KNOWN_HOSTS`, `DESPLIEGUE_DIR` |
| `/etc/campusia/known_hosts` | `root:root 0644` | claves de host del origen (por defecto las publicadas de `github.com`) |
| `/var/lib/campusia-instalar/` | `root:root 0700` | `repo.git` (espejo propio de root del origen) y carpetas temporales del instalador |
| `/usr/local/sbin/campusia-instalar` | `root:root 0755` | instalador con privilegios (sección 6) |
| `/etc/sudoers.d/campusia-instalar` | `root:root 0440` | única regla de sudo de `campusia` |
| `/etc/systemd/system/user@.service.d/delegate.conf` | `root:root 0644` | `[Service]` y `Delegate=cpu cpuset io memory pids` |
| `/etc/systemd/system/campusia-nucleo.service.d/docker.conf` | `root:root 0644` | `Wants=` y `After=user@<uid>.service`, `Environment=XDG_RUNTIME_DIR=/run/user/<uid>` y `Environment=DOCKER_HOST=unix:///run/user/<uid>/docker.sock` |

Artefactos de compilación de cada versión (los produce la etapa de compilación por defecto de `desplegar.sh`, ya existente):

- `$DESPLIEGUE_DIR/fuentes/<commit>/compilado/bin/campusia-nucleo`: binario de producción, archivo regular ejecutable.
- `$DESPLIEGUE_DIR/fuentes/<commit>/interfaz/dist/`: interfaz compilada con `index.html`, solo archivos regulares y carpetas.

El binario se compila en la imagen `despliegue/continuo/imagen/Dockerfile` (base Debian 12) y tiene que correr en Debian 12 y 13 y en Ubuntu 22.04 y 24.04 (glibc de Debian 12 o anterior, o estático).

Respaldo que acepta `levantar.sh` (formato de `despliegue/respaldo/respaldar.sh`): una carpeta con `respaldo.tar.gz` y `respaldo.tar.gz.sha256`, o la ruta de `respaldo.tar.gz` con su `.sha256` al lado. El tar tiene `MANIFIESTO.sha256`, `plataforma/campusia.db` y opcionalmente `cursos/` y `archivos/`.

## 3. Variables

### 3.1 `infraestructura/levantar.sh`

| Variable | Obligatoria | Defecto | Validación y uso |
|---|---|---|---|
| `CAMPUSIA_IP` | sí | | IPv4 literal (cuatro octetos de 0 a 255, nada más). Destino de SSH y valor de `ip_servidor` en OpenTofu |
| `CAMPUSIA_SSH_USUARIO` | no | `root` | `^[a-z_][a-z0-9_-]{0,31}$`. Si no es `root`, Ansible y los comandos remotos usan `sudo` sin contraseña |
| `CAMPUSIA_SSH_PUERTO` | no | `22` | entero de 1 a 65535 |
| `CAMPUSIA_SSH_CLAVE` | no | agente o claves por defecto de `ssh` | ruta a una clave privada existente |
| `CAMPUSIA_KNOWN_HOSTS` | no | `~/.config/campusia/known_hosts` | archivo de claves de host; se usa con `StrictHostKeyChecking=accept-new` y `UserKnownHostsFile=` ese archivo |
| `CLOUDFLARE_API_TOKEN` | sí | | se pasa a OpenTofu solo como `TF_VAR_cloudflare_api_token` en el entorno |
| `TOFU_FRASE_ESTADO` | sí | | 16 caracteres o más; se pasa solo como `TF_VAR_frase_estado` |
| `ANSIBLE_VAULT_CONTRASENA` | sí | | se entrega a `ansible-playbook` con `--vault-password-file` (un archivo temporal 0600 que se borra al salir o un guion que la lee del entorno); nunca en los argumentos |
| `CAMPUSIA_VAULT_ARCHIVO` | no | `infraestructura/servidor/secretos.vault.yml` | tiene que existir y empezar con `$ANSIBLE_VAULT;` |
| `CAMPUSIA_TFVARS` | no | `infraestructura/cloudflare/produccion.tfvars` | tiene que existir |
| `CAMPUSIA_RESPALDO` | no | vacío (sin restauración) | carpeta o `respaldo.tar.gz` local, con su `.sha256`; tiene que existir |
| `CAMPUSIA_ANSIBLE_EXTRA` | no | | archivo YAML o JSON de variables extra (`-e @archivo`); lo usan las pruebas |
| `LEVANTAR_ESPERA_DESPLIEGUE` | no | `3600` | segundos máximos esperando el primer despliegue |

Los programas se buscan en el `PATH`: `ssh`, `scp`, `ansible-playbook`, `ansible-galaxy`, `tofu`, `git`, `sha256sum`. Las pruebas ponen delante envoltorios que registran los argumentos.

### 3.2 OpenTofu (`infraestructura/cloudflare/`)

- `ip_servidor`: sin valor por defecto, con la validación de IPv4 que ya tiene. El valor real solo va en `produccion.tfvars` (ignorado) o lo pasa `levantar.sh`.
- `variables.ejemplo.tfvars` usa `203.0.113.10`.
- El resto sin cambios.

### 3.3 Ansible (`infraestructura/servidor/`)

`inventario.ejemplo.yml`: grupo `servidores`, host `203.0.113.10`, `ansible_user: root`, `ssh_claves_root: []`. El inventario real es `inventario.yml` (ignorado).

Claves del Vault y su variable en `campusia.env` (cambian los nombres para coincidir con el núcleo de `main`):

| Clave del Vault | Variable | Obligatoria |
|---|---|---|
| `vault_brevo_api_key` | `BREVO_API_KEY` | sí |
| `vault_claude_code_oauth_token` | `CLAUDE_CODE_OAUTH_TOKEN` | sí |
| `vault_turnstile_clave_sitio` | `TURNSTILE_SITE_KEY` | sí |
| `vault_turnstile_clave_secreta` | `TURNSTILE_SECRET` | sí |
| `vault_secreto_sesion` | `SESSION_SECRET` (32 caracteres o más) | sí |
| `vault_secreto_firma` | `SECRETO_FIRMA` | sí |
| `vault_secreto_webhook` | `SECRETO_WEBHOOK` | sí |
| `vault_origen_clave` | no va a `campusia.env`: `/etc/caddy/certs/origen.key` si no existe | no |
| `vault_origen_certificado` | no va a `campusia.env`: `/etc/caddy/certs/origen.pem` si no existe | no |

`secretos.ejemplo.yml` agrega `vault_origen_clave` y `vault_origen_certificado` con textos ficticios que no son PEM (nada con `-----BEGIN`, para no disparar la prueba de claves privadas versionadas).

`campusia.env` contiene una línea por cada variable de `despliegue/campusia.env.ejemplo` (leído del repo al correr el playbook) más las de la tabla: los secretos salen del Vault y el resto toma el valor del ejemplo (`ENTORNO=produccion`, `DOMINIO_BASE=campusia.tech`, `PROVEEDOR_EMAIL=brevo`, `PUERTO=8080`, `DIRECCION=127.0.0.1`, etc.). `campusia_env_extra` agrega o reemplaza variables no secretas. Ninguna línea queda con el valor `completar`.

Variables nuevas de los roles:

| Variable | Defecto | Uso |
|---|---|---|
| `despliegue_origen` | `git@github.com:ORGANIZACION/campusia.git` | `DESPLIEGUE_ORIGEN` en `continuo.env` e `INSTALAR_ORIGEN` en `/etc/campusia/instalar.env` |
| `despliegue_rama` | `main` | `DESPLIEGUE_RAMA` e `INSTALAR_RAMA` |
| `despliegue_continuo_env` | `{}` | variables extra de `continuo.env` (las pruebas cambian las etapas) |
| `despliegue_known_hosts` | claves de host publicadas de `github.com` | contenido de `/etc/campusia/known_hosts` |

### 3.4 `campusia-instalar`

Lee solo `/etc/campusia/instalar.env` e ignora el entorno de quien lo llama:

| Variable | Defecto |
|---|---|
| `INSTALAR_ORIGEN` | `git@github.com:ORGANIZACION/campusia.git` |
| `INSTALAR_RAMA` | `main` |
| `INSTALAR_CLAVE` | `/srv/campusia/.ssh/campusia_deploy` (si existe, se usa para el `fetch` por SSH con `IdentitiesOnly=yes`) |
| `INSTALAR_KNOWN_HOSTS` | `/etc/campusia/known_hosts` (`StrictHostKeyChecking=yes`) |
| `DESPLIEGUE_DIR` | `/srv/campusia/despliegue` |

### 3.5 Despliegue continuo

Cambia un defecto: `DESPLIEGUE_INSTALAR=sudo -n /usr/local/sbin/campusia-instalar "$COMMIT"` (también en `continuo.env.ejemplo`). La vuelta atrás lo corre con el commit anterior. El resto de la sección 3 del contrato anterior sigue igual.

## 4. `infraestructura/levantar.sh`

Comando único del criterio de servidor reemplazable. Desde un VPS Debian 12 o 13 o Ubuntu 22.04 o 24.04 recién creado, con acceso SSH por clave:

```
CAMPUSIA_IP=… CLOUDFLARE_API_TOKEN=… TOFU_FRASE_ESTADO=… ANSIBLE_VAULT_CONTRASENA=… [CAMPUSIA_RESPALDO=…] infraestructura/levantar.sh
```

Se puede correr desde cualquier carpeta (resuelve el repo a partir de su propia ruta). No escribe nada dentro del repo: el inventario y los temporales van a una carpeta de `mktemp -d` que se borra al salir.

Pasos y salida. Cada paso empieza con una línea exacta `==> [n/5] <paso>` y termina con una línea `<paso>: <resultado>`. Al final imprime `levantar: listo` y sale 0. Si un paso falla imprime `levantar: falló el paso <paso>` y sale con código distinto de 0 sin seguir con los pasos siguientes.

1. `verificar`: valida todas las variables de la sección 3.1, los archivos y los programas. Cualquier error sale con código 2 y el mensaje `levantar: <motivo>` que nombra la variable, **antes de ejecutar** `ssh`, `scp`, `ansible-playbook`, `ansible-galaxy` o `tofu`. Recién después prueba la conexión SSH (`ssh … true`).
2. `ansible`: `ansible-galaxy collection install -r infraestructura/servidor/requirements.yml` y `ansible-playbook -i <inventario temporal> sitio.yml -e @<vault> --vault-password-file <…> [-e @$CAMPUSIA_ANSIBLE_EXTRA]` desde `infraestructura/servidor/`. El inventario temporal tiene el host `CAMPUSIA_IP` en el grupo `servidores` con `ansible_user`, `ansible_port`, la clave y las opciones de SSH de arriba. Muestra el `PLAY RECAP`.
3. `desplegar`: por SSH, corre el despliegue de la última versión de `despliegue_rama` como `campusia` con el entorno de las unidades (`continuo.env`) y espera a que termine: `desplegar.sh --forzar` (con la versión ya desplegada sale 0 sin hacer nada). Si sale 75 (cerrojo ocupado) reintenta cada 10 segundos hasta `LEVANTAR_ESPERA_DESPLIEGUE`. Termina bien solo si `actual` es igual a `refs/heads/<rama>` del espejo y `curl -fsS http://127.0.0.1:8080/salud` responde en el servidor. Resultado: `desplegar: <commit>` o `desplegar: sin cambios <commit>`.
4. `restaurar`: si `CAMPUSIA_RESPALDO` está vacío, `restaurar: omitido`. Si el sha256 de `respaldo.tar.gz` ya está en `/srv/campusia/config/restaurado`, `restaurar: ya restaurado`. Si no, copia por `scp` el `respaldo.tar.gz`, su `.sha256` y `despliegue/respaldo/restaurar.sh` **del repo local** a una carpeta temporal de root (0700), corre `CAMPUSIA_SERVICIO=campusia-nucleo.service bash restaurar.sh <carpeta>` como root, escribe el sha256 en `restaurado`, borra la carpeta temporal y espera `/salud`. Si `restaurar.sh` rechaza el respaldo (código 3) o falla, `levantar.sh` falla en este paso y los datos del servidor quedan como estaban.
5. `dns`: en `infraestructura/cloudflare/` (con `-chdir=` o como carpeta de trabajo) corre `tofu init -input=false` y `tofu apply -input=false -auto-approve -var-file=$CAMPUSIA_TFVARS -var ip_servidor=$CAMPUSIA_IP -target='cloudflare_dns_record.registros["apex"]' -target='cloudflare_dns_record.registros["comodin"]'`, con `TF_VAR_cloudflare_api_token` y `TF_VAR_frase_estado` en el entorno. Resultado `dns: <ip>`.

Idempotente: una segunda corrida con las mismas variables sale 0, Ansible informa `changed=0`, el despliegue no escribe en `registro.log`, la restauración dice `ya restaurado` (no crea otro `previo-*`) y OpenTofu vuelve a aplicar sin cambios.

Ningún secreto (token, frase, contraseña del Vault, valores del Vault, clave de origen) aparece en la salida ni en los argumentos de ningún programa.

## 5. Módulo servidor: cambios en los roles

- `base`: falla con un mensaje claro si la distribución no es Debian 12 o 13 ni Ubuntu 22.04 o 24.04. Instala además `sudo`, `sqlite3`, `tar`, `gzip`, `ca-certificates`, `gnupg` y `curl` (la imagen de prueba es un VPS mínimo: no trae `sudo`, `git`, `curl`, `sqlite3` ni `python3-apt`).
- `usuario`: home `/srv/campusia` con 0750.
- `caddy`: instala `caddy` desde el repositorio oficial (`https://dl.cloudsmith.io/public/caddy/stable/`, clave en `/usr/share/keyrings/caddy-stable-archive-keyring.gpg`, fuente en `/etc/apt/sources.list.d/` con `signed-by`), nunca el de la distribución; si estaba el de la distribución lo reemplaza. Versión 2.8 o posterior (el Caddyfile de `main` usa `trusted_proxies_strict`). Si existen `vault_origen_clave` y `vault_origen_certificado` y los archivos no existen, los escribe con `no_log` (`origen.key` `root:caddy 0640`, `origen.pem` `root:caddy 0644`). Nunca reemplaza una clave o un certificado existentes. Instala `despliegue/Caddyfile` tal cual (byte a byte).
- `docker`: no invoca `despliegue/docker/preparar-docker.sh` (solo admite Debian 13 y no es idempotente); hace lo mismo con tareas propias para Debian y Ubuntu: repositorio oficial de Docker según `ansible_distribution` y `ansible_distribution_release`, paquetes `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-ce-rootless-extras`, `uidmap`, `dbus-user-session`, `slirp4netns`; desinstala (purga) `podman`, `podman-docker` y `docker.io` si están; `docker.service` y `docker.socket` del sistema deshabilitados y detenidos; `campusia` fuera del grupo `docker`; `delegate.conf` y `campusia-nucleo.service.d/docker.conf` de la sección 2; Docker sin root de `campusia` (omitido con `servidor_contenedor_de_prueba`).
- `campusia`: `campusia.env` como en la sección 3.3, `continuo.env`, `/etc/campusia/instalar.env` y `/etc/campusia/known_hosts`, y la invocación de `preparar-continuo.sh` como root.
- `ssh`, `firewall`, `swap`: sin cambios, y funcionan igual en Ubuntu 24.04 (servicio `ssh`, `nftables`).
- Sin IP real: `variables.tf` sin defecto para `ip_servidor`; `inventario.ejemplo.yml` con `203.0.113.10`; `README.md` sin la IP y con la sección de `levantar.sh` (todas sus variables) y el orden manual equivalente.

## 6. Módulo continuo: `campusia-instalar` y `preparar-continuo.sh`

`despliegue/continuo/campusia-instalar` (bash). `preparar-continuo.sh` (como root, idempotente, última línea `CAMBIOS=0` o `CAMBIOS=1`) lo instala en `/usr/local/sbin/campusia-instalar` (`root:root 0755`) y escribe `/etc/sudoers.d/campusia-instalar` (`root:root 0440`, validado con `visudo -cf` antes de instalarlo):

```
Defaults!/usr/local/sbin/campusia-instalar env_reset
campusia ALL=(root) NOPASSWD: /usr/local/sbin/campusia-instalar
```

Uso: `sudo -n /usr/local/sbin/campusia-instalar <commit>`.

1. Si no corre como root sale 1. Si no recibe exactamente un argumento que cumpla `^[0-9a-f]{40}$` sale 64 sin tocar nada.
2. Lee `/etc/campusia/instalar.env` y toma un cerrojo (`flock`) en `/run/campusia-instalar.lock`.
3. Actualiza su propio espejo `/var/lib/campusia-instalar/repo.git` desde `INSTALAR_ORIGEN` (nunca desde `$DESPLIEGUE_DIR/repo.git`, que es de `campusia`).
4. Exige que `<commit>` exista en ese espejo y sea `refs/heads/$INSTALAR_RAMA` o un ancestro. Si no, sale 1 con `campusia-instalar: el commit no está publicado en <rama>`.
5. Extrae `despliegue/` de ese commit de su espejo con `git archive` a una carpeta temporal de root bajo `/var/lib/campusia-instalar/`. Nunca ejecuta archivos de `$DESPLIEGUE_DIR/fuentes/`.
6. Copia a la carpeta temporal el binario `fuentes/<commit>/compilado/bin/campusia-nucleo` y la interfaz `fuentes/<commit>/interfaz/dist/`. Rechaza (sale 1 sin instalar nada) si el binario no es un archivo regular, si la interfaz no tiene `index.html`, si hay enlaces simbólicos, dispositivos o tuberías, o si alguna ruta resuelve fuera de `fuentes/<commit>/`.
7. Corre `bash <temporal>/despliegue/instalar.sh --binario <temporal>/campusia-nucleo --interfaz <temporal>/interfaz` con `PATH` fijo, devuelve su código de salida y borra la carpeta temporal.

`desplegar.sh`: el defecto de `DESPLIEGUE_INSTALAR` pasa a ser el de la sección 3.5. Además las etapas por defecto (`--etapa pruebas` y `--etapa compilar`) tienen que funcionar con el código real de `main`: hoy `pnpm fetch` falla en `interfaz/` con `packages field missing or empty` porque `interfaz/pnpm-workspace.yaml` solo tiene `allowBuilds` y `onlyBuiltDependencies` (no se puede modificar: es de otro tramo). El paso de dependencias con red tiene que resolverlo de otra forma (por ejemplo `pnpm install --frozen-lockfile` con red en el paso de dependencias y `--offline` en el paso sin red), dejando la compilación sin red. La compilación por defecto tiene que dejar `compilado/bin/campusia-nucleo` e `interfaz/dist/index.html`.

## 7. Interfaz

No hay pantallas nuevas. El prototipo `prototipo/campus.html` no cambia. `registro.log` mantiene su formato para mostrarlo más adelante en "Uso y proveedores" del panel de owner.

## 8. Permisos y reglas de seguridad

- Ningún archivo versionado o versionable (`git ls-files --cached --others --exclude-standard`) contiene una IP pública que no sea de documentación (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32`). Se permiten redes con prefijo (como los rangos de Cloudflare) y direcciones privadas o de loopback. Única excepción: `handoffs/261110_0400_plan-implementacion-plataforma.md`, que no es de este tramo.
- `inventario.yml`, `produccion.tfvars`, `secretos.yml` y cualquier `*.tfvars` salvo el ejemplo están ignorados por git. `levantar.sh` no deja archivos nuevos en el repo.
- `campusia` solo puede usar sudo para `/usr/local/sbin/campusia-instalar`. Ese instalador no confía en nada que `campusia` pueda escribir para decidir qué se ejecuta como root: el código del instalador sale de un espejo propio de root, solo se instalan commits publicados en la rama, y los artefactos se copian sin seguir enlaces.
- El puerto 443 y el 80 solo aceptan orígenes de Cloudflare (nftables) y Caddy corta (`abort`) las conexiones de otros orígenes. El núcleo (8080) y el receptor (9010) escuchan solo en loopback.
- SSH solo con clave en Debian y en Ubuntu.
- Podman no queda instalado. Docker del sistema deshabilitado; los contenedores usan Docker sin root de `campusia`.
- Un respaldo con la suma, el manifiesto o la base alterados no se restaura y no toca los datos.
- Los secretos nunca aparecen en la salida de `levantar.sh`, de Ansible, ni en argumentos de programas.

## 9. Cómo se compila, se levanta y se prueba

No hay compilación propia del tramo. El binario y la interfaz se compilan en contenedores Docker con la etapa por defecto de `desplegar.sh`.

Producción (quien tiene las credenciales):

```
CAMPUSIA_IP=<ip nueva> CLOUDFLARE_API_TOKEN="$(cat ~/.config/campusia/cloudflare-token)" \
TOFU_FRASE_ESTADO="$(cat ~/.config/campusia/tofu-frase)" ANSIBLE_VAULT_CONTRASENA="$(cat ~/.config/campusia/vault-pass)" \
infraestructura/levantar.sh
```

Pruebas, desde cero y sin pasos manuales (40 a 70 minutos; conviene en segundo plano):

```
bash pruebas/tramo-infraestructura-cierre/correr.sh
```

El comando:

1. Corre primero las pruebas de la fase anterior (`pruebas/tramo-infraestructura/correr.sh`, que además instala OpenTofu, el entorno de Python con Ansible y pytest y las colecciones en `pruebas/tramo-infraestructura/.herramientas/`). `SOLO_CIERRE=1` las omite.
2. Corre `pytest` en `pruebas/tramo-infraestructura-cierre/` con esas herramientas. Los argumentos (`-k …`) se pasan a este pytest.
3. Imprime los totales de cada suite y el total combinado como `aceptación: X/Y` y `ataque: A/B`. Sale distinto de 0 si algo falla.

Qué hacen las pruebas del cierre:

- Compilan en el anfitrión, con la etapa por defecto `desplegar.sh --etapa compilar` (Docker del anfitrión, imagen `campusia-pruebas-cierre-compilacion`, caché en `~/.cache/campusia-pruebas-cierre`), una instantánea del árbol de trabajo actual (incluye cambios sin commit) publicada como `main` en un repo bare servido con `git daemon` en la puerta de enlace de Docker (`git://172.17.0.1:<puerto>/origen.git`).
- Construyen dos imágenes de VPS mínimo con systemd (`imagenes/debian13`, `imagenes/ubuntu2404`; traen `openssh-server`, `python3` y `podman`, y no traen `sudo`, `git`, `curl` ni `sqlite3`) y levantan un contenedor por distribución como en el tramo anterior (sin `--privileged`).
- Dejan la clave pública de prueba en `/root/.ssh/authorized_keys`, copian los artefactos compilados a `/srv/prueba/compilado/` y un `/srv/prueba/compilar.sh` que los pone en `compilado/bin/` e `interfaz/dist/`.
- Generan un Vault cifrado con valores al azar (incluye un certificado de origen autofirmado), un `produccion.tfvars` de prueba y un archivo de variables extra con `servidor_contenedor_de_prueba: true`, `swap_tamano_mb: 64`, listas fijas de Cloudflare, `despliegue_origen` en el `git daemon`, y `despliegue_continuo_env` con `DESPLIEGUE_PRUEBAS=true` y `DESPLIEGUE_COMPILAR=bash /srv/prueba/compilar.sh`. La instalación usa el defecto real (`campusia-instalar` con `instalar.sh`, la unidad y el Caddyfile de `main`).
- Ponen delante en el `PATH` envoltorios de `ssh`, `scp`, `ansible-playbook` y `ansible-galaxy` que registran los argumentos y llaman al programa real, y un `tofu` falso que registra argumentos y entorno y sale 0 (no hay DNS real).
- Corren `levantar.sh` dos veces por distribución con un respaldo de prueba y una tercera vez con un respaldo cuyo manifiesto no coincide.

| Archivo | Aceptación | Ataque |
|---|---|---|
| `test_datos_reales.py` | `ip_servidor` sin defecto y con validación, inventario de ejemplo con `203.0.113.10`, archivos reales ignorados | ninguna IP pública real en archivos versionables, el escáner detecta IPs públicas, IP inválida rechazada por OpenTofu |
| `test_levantar_validacion.py` | `levantar.sh` existe, es ejecutable, pasa `bash -n` y está documentado | falta cada variable obligatoria, IP inválida o con inyección, usuario SSH inválido, frase corta, Vault sin cifrar, respaldo inexistente: falla antes de ejecutar nada remoto |
| `test_compilacion.py` | la etapa de compilación por defecto produce el binario y la interfaz | |
| `test_levantar.py` (Debian 13 y Ubuntu 24.04) | pasos en orden, núcleo e interfaz desplegados y sanos, registro, unidad y Caddyfile de `main` tal cual, Caddy oficial, certificado de origen servido, Docker sin root sin podman, `campusia.env` completo, continuo e instalador instalados, restauración, DNS con OpenTofu, segunda corrida idempotente | secretos fuera de la salida y de los argumentos, puertos web cerrados fuera de Cloudflare, Caddy corta otros orígenes, SSH sin contraseña, sudo de `campusia` limitado, instalador que rechaza argumentos raros, commits no publicados, instaladores alterados y enlaces, respaldo alterado no restaurado, sin archivos nuevos en el repo |

`CONSERVAR_CONTENEDORES=1` deja los contenedores para inspeccionarlos.

## Cambios en pruebas

- 2026-11-10: `pruebas/tramo-infraestructura/test_servidor.py::test_caddy_sirve_con_el_certificado_de_origen` (fase anterior) esperaba un código HTTP de 2xx a 5xx en una petición desde `127.0.0.1`. Eso contradice este contrato (secciones 1 y 8): Caddy instala tal cual el `despliegue/Caddyfile` de `main` y corta con `abort` todo origen que no sea de Cloudflare. La última aserción ahora exige ese corte (curl falla o devuelve `000`); el resto de la prueba (Caddy activo, Caddyfile válido, permisos y huella del certificado de origen) no cambia.
