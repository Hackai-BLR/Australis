# Contrato del tramo infraestructura

_Creado: 2026-11-10. Tramo paralelo en la rama `tramo-infraestructura`. Alcance: `.orquestacion/tramo-infraestructura.md`._

_Actualizado: 2026-11-10. `contratos/tramo-infraestructura-cierre.md` completa y, donde difiere, reemplaza a este contrato (IP sin valor por defecto, nombres de `campusia.env`, Caddy del repositorio oficial, permisos de `/srv/campusia/config`, instalación con `campusia-instalar`, `levantar.sh`, Ubuntu 24.04)._

El tramo describe como código la infraestructura que ya existe (Cloudflare y el servidor Debian 13) y agrega el despliegue continuo desde el servidor. No hay credenciales reales en el entorno de desarrollo: todo se valida y se prueba sin ellas. Quien tiene las credenciales corre después `tofu plan`, importa y aplica.

Solo se crean estas carpetas y archivos. No se toca ninguna otra:

| Ruta | Módulo |
|---|---|
| `infraestructura/cloudflare/` | cloudflare |
| `infraestructura/servidor/` y `infraestructura/README.md` | servidor |
| `despliegue/continuo/` | continuo |
| `contratos/tramo-infraestructura.md`, `pruebas/tramo-infraestructura/` | contrato (este documento y las pruebas) |

## 1. Rutas HTTP

Este tramo no agrega rutas a la API del núcleo. La única ruta HTTP nueva es la del webhook de despliegue.

### `POST /_despliegue/webhook`

Caddy la recibe en `campusia.tech` y la pasa sin cambios a `http://127.0.0.1:9010/_despliegue/webhook` (el receptor `despliegue/continuo/receptor.py`). La llama solo GitHub. No usa sesión ni cookies: la autenticación es la firma.

Encabezados que se leen:

| Encabezado | Uso |
|---|---|
| `X-Hub-Signature-256` | `sha256=<hex>`: HMAC SHA-256 del cuerpo crudo con `SECRETO_WEBHOOK`. Se compara en tiempo constante |
| `X-GitHub-Event` | `push` o `ping` |
| `X-GitHub-Delivery` | identificador de la entrega |
| `Content-Type` | `application/json` |

Cuerpo de un push (solo se leen estos campos): `{"ref": "refs/heads/main", "after": "<sha de 40 hex>", "repository": {"full_name": "ORGANIZACION/campusia"}}`.

Orden de validación y respuestas (el cuerpo de la respuesta es JSON `{"resultado": "<texto>"}`, sin detalles internos):

| Caso | Código | Dispara despliegue |
|---|---|---|
| Método distinto de `POST` en la ruta | 405 | no |
| Otra ruta | 404 | no |
| Cuerpo de más de 1 MiB (por `Content-Length` o leído) | 413 | no |
| Falta la firma, formato distinto de `sha256=<64 hex>`, o firma que no coincide | 401 | no |
| Falta `X-GitHub-Delivery` o `X-GitHub-Event` | 400 | no |
| Entrega repetida: mismo `X-GitHub-Delivery` o mismo cuerpo (sha256 del cuerpo) ya visto, aunque el receptor se haya reiniciado | 409 | no |
| `ping` firmado | 200 | no |
| Evento distinto de `push` y `ping` | 400 | no |
| Cuerpo que no es JSON válido | 400 | no |
| `ref` distinto de `refs/heads/<DESPLIEGUE_RAMA>` (otra rama, etiquetas) | 400 | no |
| `repository.full_name` distinto de `DESPLIEGUE_REPOSITORIO` | 400 | no |
| Push firmado a `main` del repositorio correcto, entrega nueva | 202 | sí |

La firma se verifica antes que cualquier otra cosa del contenido. Las entregas y los resúmenes de cuerpos vistos se guardan en `RECEPTOR_ENTREGAS` (un archivo, una entrada por línea, se conservan al menos las últimas 1000). Se registra una entrega como vista solo si la firma es válida.

El disparo ejecuta `DESPLIEGUE_DISPARADOR` dividido con `shlex.split`, sin shell, sin pasarle datos del cuerpo, sin esperar a que termine. El despliegue en sí hace `git fetch` y decide qué desplegar: el `after` del cuerpo no se usa para elegir la versión.

El receptor no arranca (sale con código distinto de 0) si `SECRETO_WEBHOOK` falta o está vacío. Por defecto escucha solo en `127.0.0.1`.

## 2. Modelo de datos

No hay base de datos ni migraciones en este tramo. Los datos persistentes son archivos:

### Estado de OpenTofu

- `infraestructura/cloudflare/estado/terraform.tfstate`: estado cifrado con el cifrado nativo de OpenTofu (`pbkdf2` + `aes_gcm`), versionado en git. Nunca existe una versión sin cifrar en el repo. Mientras nadie aplique con credenciales reales, el archivo no existe (la carpeta lleva un `.gitkeep`).

### Despliegue continuo (en el servidor, bajo `DESPLIEGUE_DIR`, por defecto `/srv/campusia/despliegue`)

| Ruta | Contenido |
|---|---|
| `repo.git/` | clon espejo del origen |
| `fuentes/<commit>/` | checkout limpio de cada versión (sin archivos ajenos al commit) |
| `actual` | sha de 40 hex de la versión desplegada, con salto de línea final |
| `registro.log` | una línea JSON por despliegue intentado |
| `despliegue.lock` | cerrojo con `flock` (util-linux); lo usan `desplegar.sh` y `limpiar.sh` |
| `cache/` | caché de compilación (`cargo`, `target`, almacén de pnpm) |
| `bin/` | copia instalada de los scripts de `despliegue/continuo/` |
| `entregas-vistas` | entregas del webhook ya procesadas |

Formato de cada línea de `registro.log`:

```json
{"fecha": "2026-11-10T04:00:00Z", "commit": "<40 hex>", "anterior": "<40 hex o null>", "resultado": "exito", "duracion_s": 42}
```

`resultado` es uno de: `exito`, `fallo-pruebas`, `fallo-compilacion`, `fallo-instalacion`, `revertido`, `fallo-salud` (falló la salud y no había versión anterior), `fallo-reversion`. `duracion_s` es un número mayor o igual a 0. Las corridas sin cambios no escriben en el registro. Un despliegue ocupado por el cerrojo tampoco escribe.

## 3. Variables de entorno y variables de configuración

### OpenTofu (`infraestructura/cloudflare/`)

| Variable | Tipo | Defecto | Notas |
|---|---|---|---|
| `cloudflare_api_token` | string, `sensitive = true` | sin defecto | se pasa con `TF_VAR_cloudflare_api_token` leído de `~/.config/campusia/cloudflare-token` |
| `frase_estado` | string, `sensitive = true` | sin defecto | al menos 16 caracteres; `TF_VAR_frase_estado` leído de `~/.config/campusia/tofu-frase` |
| `cuenta_id` | string | `00000000000000000000000000000000` | |
| `zona_id` | string | `11111111111111111111111111111111` | |
| `dominio` | string | `campusia.tech` | |
| `ip_servidor` | string | sin defecto | IPv4 del servidor; el valor real va solo en `produccion.tfvars` (ignorado) o en `levantar.sh` |
| `correo_destino_reenvio` | string | sin defecto | dirección verificada a la que se reenvía `hola@`; no se escribe en el repo |
| `csr_origen` | string | sin defecto | CSR PEM del servidor (`/etc/caddy/certs/origen.csr`); es pública |
| `ids_existentes` | map(string) | `{}` | ids de Cloudflare de los recursos existentes para importar; con el mapa vacío no se planea ninguna importación |

`variables.ejemplo.tfvars` muestra todas las variables no secretas con valores ficticios. Cualquier otro `*.tfvars` está ignorado por git.

### Ansible (`infraestructura/servidor/`)

Variables del Vault (`secretos.vault.yml`, cifrado; en el repo solo `secretos.ejemplo.yml` con estas mismas claves y valores ficticios):

| Variable | Va a `campusia.env` como |
|---|---|
| `vault_brevo_api_key` | `BREVO_API_KEY` |
| `vault_claude_code_oauth_token` | `CLAUDE_CODE_OAUTH_TOKEN` |
| `vault_turnstile_clave_sitio` | `TURNSTILE_CLAVE_SITIO` |
| `vault_turnstile_clave_secreta` | `TURNSTILE_CLAVE_SECRETA` |
| `vault_secreto_sesion` | `SECRETO_SESION` |
| `vault_secreto_firma` | `SECRETO_FIRMA` |
| `vault_secreto_webhook` | `SECRETO_WEBHOOK` |

Además `campusia.env` lleva `DOMINIO_BASE=campusia.tech` y `PROVEEDOR_EMAIL=brevo`. Los nombres de las variables del núcleo se pueden ajustar con la variable `campusia_env_extra` (diccionario que se agrega al archivo), sin cambiar las de la tabla.

Variables de los roles (con defecto para producción; las pruebas las cambian):

| Variable | Defecto | Uso |
|---|---|---|
| `servidor_contenedor_de_prueba` | `false` | en `true`, los roles no aplican `swapon`, no aplican `sysctl` en vivo (solo escriben la configuración) y no arrancan Docker sin root; todo lo demás igual |
| `swap_tamano_mb` | `4096` | tamaño de `/swapfile` |
| `firewall_cloudflare_ipv4` | sin definir | si está definida, se usa esta lista en lugar de descargar `https://www.cloudflare.com/ips-v4` |
| `firewall_cloudflare_ipv6` | sin definir | idem con `https://www.cloudflare.com/ips-v6` |
| `ssh_claves_root` | `[]` | claves públicas que se agregan a `root` (nunca se quitan las existentes) |
| `caddy_caddyfile_origen` | `{{ playbook_dir }}/../../despliegue/Caddyfile` | si el archivo existe se instala; si no, se deja el Caddyfile mínimo |
| `campusia_env_extra` | `{}` | ver arriba |

La contraseña del Vault vive en `~/.config/campusia/vault-pass` y nunca en el repo. `ansible.cfg` puede apuntar a ella con `vault_password_file = ~/.config/campusia/vault-pass`.

### Despliegue continuo (`despliegue/continuo/`)

Todas tienen defecto; en producción vienen del `EnvironmentFile` de las unidades (`/srv/campusia/config/campusia.env` y, opcional, `/srv/campusia/config/continuo.env`).

| Variable | Defecto | Usa |
|---|---|---|
| `CAMPUSIA_RAIZ` | `/srv/campusia` | todos |
| `DESPLIEGUE_DIR` | `$CAMPUSIA_RAIZ/despliegue` | todos |
| `DESPLIEGUE_ORIGEN` | `git@github.com:ORGANIZACION/campusia.git` | desplegar |
| `DESPLIEGUE_RAMA` | `main` | desplegar, receptor |
| `DESPLIEGUE_REPOSITORIO` | `ORGANIZACION/campusia` | receptor |
| `DESPLIEGUE_CLAVE` | `$CAMPUSIA_RAIZ/.ssh/campusia_deploy` | desplegar: si existe, `GIT_SSH_COMMAND` la usa con `IdentitiesOnly=yes` |
| `DESPLIEGUE_PRUEBAS` | pruebas del proyecto en un contenedor Docker | desplegar |
| `DESPLIEGUE_COMPILAR` | compilación de producción del núcleo y la interfaz en un contenedor Docker | desplegar |
| `DESPLIEGUE_INSTALAR` | `bash despliegue/instalar.sh` | desplegar |
| `DESPLIEGUE_SALUD` | `curl -fsS --max-time 5 http://127.0.0.1:${NUCLEO_PUERTO:-8080}/salud` | desplegar |
| `DESPLIEGUE_SALUD_ESPERA` | `60` | segundos durante los que se reintenta la salud |
| `DESPLIEGUE_CPUS` | `1.5` | `--cpus` de los contenedores de prueba y compilación |
| `DESPLIEGUE_MEMORIA` | `3g` | `--memory` de esos contenedores |
| `DESPLIEGUE_IMAGEN` | `campusia-despliegue` | repositorio de las imágenes por versión (`$DESPLIEGUE_IMAGEN:<commit>`) |
| `DESPLIEGUE_CONSERVAR` | `3` | versiones que se conservan (fuentes e imágenes) |
| `CACHE_DIR` | `$DESPLIEGUE_DIR/cache` | limpiar |
| `CACHE_MAX` | `4G` | tamaño máximo de la caché; acepta bytes o sufijos `K`, `M`, `G` (potencias de 1024) |
| `CACHE_MAX_DIAS` | `30` | se borran los archivos de la caché más viejos que esto |
| `SECRETO_WEBHOOK` | obligatorio | receptor |
| `RECEPTOR_DIRECCION` | `127.0.0.1` | receptor |
| `RECEPTOR_PUERTO` | `9010` | receptor |
| `RECEPTOR_ENTREGAS` | `$DESPLIEGUE_DIR/entregas-vistas` | receptor |
| `DESPLIEGUE_DISPARADOR` | `systemctl --user start --no-block campusia-despliegue.service` | receptor |

## 4. Módulo cloudflare: `infraestructura/cloudflare/`

OpenTofu 1.10 o posterior y el proveedor oficial `cloudflare/cloudflare` 5.x. `.terraform.lock.hcl` versionado.

Archivos obligatorios:

- `estado.tf`: contiene solo el bloque `terraform { backend "local" { path = "estado/terraform.tfstate" } encryption { ... } }` y la declaración de `variable "frase_estado"`. No depende de nada más de la configuración (las pruebas lo copian solo). El cifrado: `key_provider "pbkdf2"` con `passphrase = var.frase_estado`, `method "aes_gcm"`, y bloques `state` y `plan` con `enforced = true` y sin método de respaldo sin cifrar. Leer o escribir estado sin cifrar falla.
- `.gitignore`: ignora `.terraform/`, `*.tfplan`, `*.tfvars` salvo `variables.ejemplo.tfvars`, `*.tfstate.backup`, `crash.log`. No ignora `estado/terraform.tfstate`.
- `estado/.gitkeep`.
- `variables.ejemplo.tfvars`.
- `tofu.sh`: envoltorio que exporta `TF_VAR_cloudflare_api_token` y `TF_VAR_frase_estado` desde `~/.config/campusia/` y llama a `tofu` con los argumentos recibidos. Falla con un mensaje claro si faltan los archivos.

Recursos, con estas direcciones exactas (las pruebas las usan):

| Dirección | Valores |
|---|---|
| `cloudflare_dns_record.registros["apex"]` | A, `campusia.tech`, `var.ip_servidor`, `proxied = true`, `ttl = 1` |
| `cloudflare_dns_record.registros["comodin"]` | A, `*.campusia.tech`, `var.ip_servidor`, `proxied = true`, `ttl = 1` |
| `cloudflare_dns_record.registros["brevo1_dkim"]` | CNAME, `brevo1._domainkey.campusia.tech`, `b1.campusia-tech.dkim.brevo.com`, `proxied = false`, `ttl = 1` |
| `cloudflare_dns_record.registros["brevo2_dkim"]` | CNAME, `brevo2._domainkey.campusia.tech`, `b2.campusia-tech.dkim.brevo.com`, `proxied = false`, `ttl = 1` |
| `cloudflare_dns_record.registros["brevo_codigo"]` | TXT, `campusia.tech`, `brevo-code:04c2a6176a3004dcafba5dfca20c83a8`, `ttl = 1` |
| `cloudflare_dns_record.registros["dmarc"]` | TXT, `_dmarc.campusia.tech`, `v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com`, `ttl = 1` |
| `cloudflare_dns_record.registros["spf"]` | TXT, `campusia.tech`, `v=spf1 include:_spf.mx.cloudflare.net include:spf.brevo.com ~all`, `ttl = 1` |
| `cloudflare_email_routing_dns.reenvio` | `zone_id = var.zona_id`: reenvío activo con sus MX `route1/2/3.mx.cloudflare.net` y el DKIM `cf2024-1._domainkey`, que crea y mantiene Cloudflare (no se declaran como registros sueltos porque Cloudflare elige las prioridades y la clave) |
| `cloudflare_email_routing_address.destino` | `account_id = var.cuenta_id`, `email = var.correo_destino_reenvio` |
| `cloudflare_email_routing_rule.hola` | matcher `literal`, campo `to`, valor `hola@campusia.tech`; acción `forward` hacia `[var.correo_destino_reenvio]`; `enabled = true` |
| `cloudflare_zone_setting.ssl` | `setting_id = "ssl"`, `value = "strict"` |
| `cloudflare_zone_setting.always_use_https` | `setting_id = "always_use_https"`, `value = "on"` |
| `cloudflare_zone_setting.tls_minimo` | `setting_id = "min_tls_version"`, `value = "1.2"` |
| `cloudflare_turnstile_widget.login` | `account_id = var.cuenta_id`, `name = "campusia-login"`, `mode = "managed"`, `domains = ["campusia.tech"]` |
| `cloudflare_origin_ca_certificate.origen` | `hostnames = ["campusia.tech", "*.campusia.tech"]`, `request_type = "origin-ecc"`, `requested_validity = 5475`, `csr = var.csr_origen`, con `lifecycle { prevent_destroy = true  ignore_changes = [csr, requested_validity] }` |

Los nombres de los registros son siempre el nombre completo (FQDN). Todos usan `zone_id = var.zona_id`. Los valores de los TXT pueden ir con o sin comillas (las pruebas las ignoran).

Importación: cada recurso tiene un bloque `import` (en `importar.tf`) con `for_each` sobre las entradas de `var.ids_existentes` que le corresponden, de modo que con el mapa vacío no se importa nada y con el mapa completo se importa todo. Las claves de `ids_existentes` y el formato de cada id (por ejemplo `<zona>/<registro>` para DNS, `<cuenta>/<sitekey>` para Turnstile) quedan documentados en `infraestructura/README.md`.

## 5. Módulo servidor: `infraestructura/servidor/`

Ansible (ansible-core 2.18). Estructura:

- `ansible.cfg` con `roles_path = roles`.
- `sitio.yml`: un play sobre el grupo `servidores` que aplica en orden los roles `base`, `usuario`, `ssh`, `firewall`, `swap`, `caddy`, `docker`, `campusia`.
- `inventario.ejemplo.yml`: grupo `servidores` con el host de documentación `203.0.113.10`, `ansible_user: root`. El inventario real (`inventario.yml`) está ignorado por git.
- `requirements.yml`: colecciones que usan los roles (por ejemplo `ansible.posix`, `community.general`), con versión.
- `secretos.ejemplo.yml` con las claves del Vault y valores ficticios. `secretos.vault.yml` real lo crea quien tiene las credenciales, cifrado (empieza con `$ANSIBLE_VAULT;`).
- `.gitignore` en la carpeta si hace falta (nunca ignora `secretos.vault.yml`).

Condiciones generales: idempotente (la segunda corrida informa `changed=0`), pasa `ansible-lint --profile moderate`, cada rol termina con tareas de verificación (`assert` o comandos de comprobación) que fallan si el resultado no es el esperado, y ninguna tarea que maneje secretos muestra valores (`no_log: true`).

Roles:

| Rol | Hace | Se verifica con |
|---|---|---|
| `base` | `apt` actualizado y `upgrade`, `unattended-upgrades` instalado con `APT::Periodic::Unattended-Upgrade "1"` y `APT::Periodic::Update-Package-Lists "1"`; instala `git`, `curl`, `nftables`, `openssl`, `python3`, `util-linux` | `apt-config dump` |
| `usuario` | usuario de sistema `campusia` (uid menor a 1000), home `/srv/campusia` de `campusia`, shell `/bin/bash`, `/etc/subuid` y `/etc/subgid` con `campusia:200000:65536`, linger (`/var/lib/systemd/linger/campusia`) | `getent`, archivos |
| `ssh` | agrega `ssh_claves_root`; archivo `/etc/ssh/sshd_config.d/00-campusia.conf` con `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin prohibit-password`, `PubkeyAuthentication yes`; valida con `sshd -t` antes de recargar; se niega a desactivar contraseñas si `root` no tiene ninguna clave autorizada | `sshd -T` |
| `firewall` | `/etc/nftables.conf` con la tabla `inet filtro`, cadena `entrada` (`hook input`, `policy drop`): acepta establecidos y relacionados, `lo`, ICMP e ICMPv6, `tcp dport 22` desde cualquiera, y `tcp dport { 80, 443 }` solo con `ip saddr @cloudflare_v4` o `ip6 saddr @cloudflare_v6`. Los conjuntos `cloudflare_v4` (`ipv4_addr`, `flags interval`) y `cloudflare_v6` (`ipv6_addr`, `flags interval`) se cargan con las listas. Servicio `nftables` habilitado y activo. Instala `/usr/local/sbin/campusia-cloudflare-ips` y el temporizador `campusia-cloudflare-ips.timer` (semanal, habilitado) | `nft -j list ruleset` |
| `swap` | `/swapfile` de `swap_tamano_mb` MiB, permisos 600, `mkswap`, línea `/swapfile none swap sw 0 0` en `/etc/fstab`, `/etc/sysctl.d/90-campusia.conf` con `vm.swappiness = 20`; en producción `swapon` y aplica el sysctl | `/proc/swaps` o, en contenedor, los archivos |
| `caddy` | paquete `caddy` de Debian; `/etc/caddy/certs/` (root:caddy 750); si no existen, genera `origen.key` (EC P-256) y `origen.csr`, y nunca reemplaza una clave o un certificado que ya existen; `origen.key` root:caddy 640; `origen.pem` root:caddy 644; instala `caddy_caddyfile_origen` si existe o un Caddyfile mínimo (ver abajo); valida con `caddy validate` antes de recargar; servicio habilitado y activo (si falta `origen.pem` no lo arranca y lo informa) | `caddy validate`, `systemctl is-active caddy` |
| `docker` | si existe `despliegue/docker/preparar-docker.sh` (de otro tramo) lo invoca; si no, hace lo equivalente: repositorio oficial de Docker, `docker-ce`, `docker-ce-cli`, `docker-ce-rootless-extras`, `uidmap`, `dbus-user-session`, `slirp4netns`; `docker.service` y `docker.socket` del sistema deshabilitados y detenidos; `dockerd-rootless-setuptool.sh install` como `campusia` y servicio de usuario `docker` habilitado (omitido si `servidor_contenedor_de_prueba`); desinstala `podman` | `dpkg -s`, `systemctl is-enabled` |
| `campusia` | `/srv/campusia/config/` (campusia, 700) y `/srv/campusia/config/campusia.env` (campusia:campusia, 600) generado desde las variables del Vault con `no_log: true`; si existe `despliegue/continuo/preparar-continuo.sh` lo invoca como root (y usa su línea final `CAMBIOS=0` o `CAMBIOS=1` para informar si cambió) | `stat` |

Caddyfile mínimo:

```
{
	auto_https disable_certs
}

campusia.tech, *.campusia.tech {
	tls /etc/caddy/certs/origen.pem /etc/caddy/certs/origen.key
	handle /_despliegue/webhook {
		reverse_proxy 127.0.0.1:9010
	}
	handle {
		reverse_proxy 127.0.0.1:8080
	}
}
```

El Caddyfile definitivo lo provee `despliegue/` (otro tramo) y tiene que conservar `auto_https disable_certs`, el certificado de origen y la ruta del webhook.

`/usr/local/sbin/campusia-cloudflare-ips`: descarga `CLOUDFLARE_IPS_V4_URL` (defecto `https://www.cloudflare.com/ips-v4`) y `CLOUDFLARE_IPS_V6_URL` (defecto `https://www.cloudflare.com/ips-v6`), valida cada línea como red IPv4 o IPv6 según corresponda, rechaza listas vacías y cualquier prefijo más corto que `/8` en IPv4 o `/16` en IPv6 (y por lo tanto `0.0.0.0/0` y `::/0`). Si algo falla sale con código distinto de 0 y no cambia nada. Si todo está bien, reemplaza el contenido de los dos conjuntos en una sola transacción de `nft -f` y guarda las listas para que sobrevivan a `systemctl restart nftables`.

## 6. Módulo continuo: `despliegue/continuo/`

Archivos:

| Archivo | Qué hace |
|---|---|
| `desplegar.sh` | un despliegue completo; ver abajo |
| `receptor.py` | receptor del webhook (Python 3.10 o posterior, solo biblioteca estándar) |
| `limpiar.sh` | limpieza de caché, fuentes e imágenes |
| `registro.sh` | muestra el registro: `registro.sh [-n N]` imprime las últimas N entradas (defecto 20), una por línea, con fecha, commit corto, resultado y duración. Sale 0 aunque el registro no exista |
| `preparar-continuo.sh` | se corre como root e idempotente: crea `DESPLIEGUE_DIR` con `fuentes/`, `cache/` y `bin/` de `campusia`; copia los scripts a `bin/`; instala las unidades en `/srv/campusia/.config/systemd/user/` y las habilita (enlaces en `timers.target.wants/` y `default.target.wants/`); no hace `git fetch` ni toca credenciales; última línea `CAMBIOS=0` o `CAMBIOS=1` |
| `systemd/campusia-despliegue.service` | `Type=oneshot`, ejecuta `bin/desplegar.sh`, con `CPUQuota=` y `MemoryMax=` |
| `systemd/campusia-despliegue.timer` | cada 5 minutos (`OnUnitActiveSec=5min` o `OnCalendar=*:0/5`) |
| `systemd/campusia-receptor.service` | `receptor.py`, `Restart=on-failure`, `EnvironmentFile=/srv/campusia/config/campusia.env` |
| `systemd/campusia-limpieza.service` y `.timer` | `limpiar.sh` semanal (`OnCalendar=weekly`) |
| `imagen/Dockerfile` | imagen de compilación (Rust, Node 22, pnpm) para las etapas por defecto |
| `continuo.env.ejemplo` | las variables de la sección 3 con sus defectos |

Son unidades de usuario de `campusia` (con linger), así no hace falta root para disparar ni desplegar.

### `desplegar.sh`

1. Toma el cerrojo `flock -n $DESPLIEGUE_DIR/despliegue.lock`. Si está tomado sale con código 75 sin escribir nada.
2. Crea lo que falte bajo `DESPLIEGUE_DIR`, clona `DESPLIEGUE_ORIGEN` como espejo la primera vez y hace `git fetch`.
3. Si el commit de `origin/<DESPLIEGUE_RAMA>` es igual a `actual`, sale 0 sin escribir en el registro. Si ese commit ya tiene una entrada fallida en el registro (cualquier resultado distinto de `exito`), tampoco lo reintenta: sale 0 sin escribir (`--forzar` lo reintenta).
4. Extrae un checkout limpio en `fuentes/<commit>/`.
5. Cada etapa es un comando que corre con `bash -c` en `fuentes/<commit>/` y con las variables `COMMIT`, `FUENTES`, `CAMPUSIA_RAIZ` y `DESPLIEGUE_DIR` exportadas. Etapas: `DESPLIEGUE_PRUEBAS`, `DESPLIEGUE_COMPILAR`, `DESPLIEGUE_INSTALAR`, `DESPLIEGUE_SALUD` (reintentada cada segundo hasta `DESPLIEGUE_SALUD_ESPERA` segundos).
6. Si fallan las pruebas o la compilación no instala nada (`fallo-pruebas`, `fallo-compilacion`, código 1). Si falla la instalación, reinstala la anterior (`fallo-instalacion`, código 1).
7. Si falla la salud y hay una versión anterior, vuelve a correr `DESPLIEGUE_INSTALAR` en `fuentes/<anterior>/` con `COMMIT=<anterior>`, comprueba su salud y registra `revertido` (código 2; `fallo-reversion` si la anterior tampoco responde). `actual` sigue apuntando a la anterior.
8. Si todo pasa escribe `actual` y registra `exito` (código 0).

Las etapas por defecto corren en contenedores Docker sin root (`DOCKER_HOST=unix:///run/user/<uid>/docker.sock`) con `--cpus "$DESPLIEGUE_CPUS"` y `--memory "$DESPLIEGUE_MEMORIA"`, la caché montada desde `CACHE_DIR`, un paso de dependencias con red (`cargo fetch`, `pnpm fetch`) y las pruebas y la compilación con `--network none`. La compilación produce el binario del núcleo y `interfaz/dist` y etiqueta la imagen `$DESPLIEGUE_IMAGEN:<commit>`. La instalación por defecto es `despliegue/instalar.sh` del commit desplegado (lo escribe otro tramo): se invoca desde la raíz de las fuentes, como `campusia`, con las variables de arriba. Mientras no exista, la etapa falla y el despliegue queda en `fallo-instalacion`.

Migraciones: las del núcleo tienen que ser compatibles con la versión anterior (solo agregar), así volver atrás reinstalando el binario y la interfaz anteriores no rompe la base. Antes de instalar, `desplegar.sh` deja una copia de `datos/campusia.db` (si existe) en `DESPLIEGUE_DIR/previos/<commit>.db` con `sqlite3 .backup` o, si no hay `sqlite3`, la omite.

### `limpiar.sh`

Toma el mismo cerrojo con `flock -n`; si está tomado sale 75 sin tocar nada. Luego:

- Caché: borra los archivos de `CACHE_DIR` con fecha de modificación de más de `CACHE_MAX_DIAS` días; después, si la suma de tamaños aparentes supera `CACHE_MAX`, borra desde el más viejo hasta quedar en o por debajo. Borra los directorios que quedan vacíos.
- Fuentes: conserva `actual` y las más recientes por fecha de modificación hasta sumar `DESPLIEGUE_CONSERVAR`; borra el resto de `fuentes/`.
- Imágenes: si `docker` responde, borra las etiquetas `$DESPLIEGUE_IMAGEN:<tag>` cuyo tag no sea un commit conservado. Nunca toca otros repositorios de imágenes. Si `docker` no está, lo omite.
- Sale 0.

## 7. Interfaz

Este tramo no agrega pantallas. El owner consulta los despliegues con `registro.sh` por SSH. El formato de `registro.log` (sección 2) queda fijo para que una fase posterior lo muestre en el panel de owner ("Uso y proveedores" del prototipo `prototipo/campus.html`).

## 8. Permisos y reglas de seguridad

- Ningún archivo versionado (ni los no ignorados que se van a versionar) contiene claves privadas, tokens de Cloudflare, claves de Brevo (`xkeysib-`), tokens de Anthropic (`sk-ant-`), el contenido de `campusia.env`, `*.tfvars` con valores reales ni estado de OpenTofu sin cifrar.
- El estado versionado está cifrado y no se lee sin la frase de paso; un estado sin cifrar se rechaza.
- `cloudflare_api_token` y `frase_estado` son `sensitive` y no tienen valor por defecto.
- 80 y 443 solo aceptan orígenes de Cloudflare; ninguna regla abre esos puertos a todo internet; la política de entrada es `drop`.
- SSH solo con clave. Root solo con clave.
- `campusia.env` es 600 de `campusia`, su carpeta 700, y su contenido nunca aparece en la salida de Ansible.
- El certificado y la clave de origen existentes no se recrean ni se reescriben.
- El webhook rechaza firmas inválidas, ramas distintas de `main`, otros repositorios y repeticiones.
- Un despliegue con pruebas o compilación fallidas no se instala; uno cuya salud falla vuelve a la versión anterior.
- Un solo despliegue a la vez.
- La caché no supera `CACHE_MAX` después de la limpieza.
- El servidor tiene su propia deploy key de solo lectura en `DESPLIEGUE_CLAVE`; la crea quien tiene las credenciales.

## 9. Cómo se compila, se levanta y se prueba

No hay compilación. Las herramientas se instalan sin sudo.

Producción (lo hace quien tiene las credenciales, documentado en `infraestructura/README.md`):

```
cd infraestructura/cloudflare && ./tofu.sh init && ./tofu.sh plan
cd infraestructura/servidor && ansible-galaxy collection install -r requirements.yml && ansible-playbook -i inventario.yml sitio.yml
```

Pruebas de punta a punta del tramo (desde cero, sin pasos manuales):

```
bash pruebas/tramo-infraestructura/correr.sh
```

El comando:

1. Descarga OpenTofu 1.10.7 (verificando su suma SHA-256) a `pruebas/tramo-infraestructura/.herramientas/bin/`.
2. Crea con `uv` un entorno de Python 3.12 en `.herramientas/venv` con `ansible-core`, `ansible-lint` y `pytest` (`requisitos.txt`), e instala las colecciones de `colecciones.yml` y de `infraestructura/servidor/requirements.yml`.
3. Construye la imagen `campusia-pruebas-debian13-systemd` (Debian 13 con systemd, `podman` preinstalado para comprobar que se quita) y levanta contenedores sin `--privileged`, con `NET_ADMIN` y `SYS_ADMIN` y `/proc/sys` de solo lectura, para no tocar el núcleo del anfitrión.
4. Corre `pytest` y al final imprime `aceptación: X/Y` y `ataque: A/B`. Sale distinto de 0 si alguna falla.

Toma entre 10 y 20 minutos (dos corridas completas de Ansible). Conviene correrlo en segundo plano. `CONSERVAR_CONTENEDORES=1` deja los contenedores para inspeccionarlos. Se puede elegir un subconjunto con `bash pruebas/tramo-infraestructura/correr.sh -k <expresión>`.

Qué prueban:

| Archivo | Aceptación | Ataque |
|---|---|---|
| `test_cloudflare.py` | `tofu fmt -check`, `init -backend=false`, `validate`, `tofu test` con proveedor simulado y los valores reales, bloques `import` para todo, estado cifrado que se lee con la frase, `.gitignore` | estado sin cifrar rechazado, frase equivocada o ausente no lee, estado versionado cifrado, token sin defecto |
| `test_servidor.py` | `ansible-lint`, dos corridas contra Debian 13 con systemd (la segunda sin cambios), usuario, SSH con clave, nftables, swap, Caddy con el certificado existente, actualizaciones automáticas, Docker sin root, `campusia.env`, actualización de IPs de Cloudflare | 80 y 443 cerrados para orígenes que no son Cloudflare, ninguna regla abierta a todo internet, SSH no ofrece contraseña, secretos fuera de la salida de Ansible, certificado no recreado, listas de IPs maliciosas rechazadas |
| `test_webhook.py` | push firmado a `main` dispara, `ping` responde | firma ausente, inválida o de otro cuerpo, otra rama, etiqueta, otro repositorio, otro evento, repetición (también tras reiniciar y con otro id de entrega), cuerpo enorme, sin secreto no arranca, solo escucha en loopback |
| `test_despliegue.py` | preparación, primer despliegue, sin cambios, segundo despliegue, registro, unidades de systemd | pruebas fallidas no instalan, compilación fallida no instala, salud fallida vuelve atrás, no reintenta un commit fallido, un solo despliegue a la vez, límites de CPU y memoria y red cortada |
| `test_limpieza.py` | caché por debajo del máximo, conserva las últimas 3 versiones e imágenes | no limpia durante un despliegue, no toca otras imágenes |
| `test_secretos.py` | `secretos.ejemplo.yml` con todas las claves | nada secreto versionado, Vault cifrado, contraseña del Vault fuera del repo |

Detalles fijos que usan las pruebas:

- Inventario de prueba: grupo `servidores`, host `campusia-prueba`, `ansible_connection: community.docker.docker`, `ansible_user: root`, `servidor_contenedor_de_prueba: true`, `swap_tamano_mb: 64`, listas fijas en `firewall_cloudflare_ipv4` y `firewall_cloudflare_ipv6`, y una clave de prueba en `ssh_claves_root`. Los secretos se pasan con `-e @secretos.yml` (valores al azar en cada corrida, mismas claves que `secretos.ejemplo.yml`). Se corre `ansible-playbook -i <inventario> sitio.yml -e @<secretos>` desde `infraestructura/servidor/`.
- Antes de la primera corrida, el contenedor ya tiene `/etc/caddy/certs/origen.key` y `origen.pem` (root:root, la clave 600), como en el servidor real. Después de las dos corridas tienen que ser idénticos byte a byte, con los dueños y permisos de la sección 5.
- El contenedor trae `podman` y `openssh-server` instalados. No tiene `--privileged`: `/proc/sys` es de solo lectura, `swapon` no funciona y Docker no puede arrancar adentro.
- `campusia-cloudflare-ips` se prueba con `CLOUDFLARE_IPS_V4_URL` y `CLOUDFLARE_IPS_V6_URL` apuntando a `http://127.0.0.1:8099/`. Listas rechazadas en las pruebas: `0.0.0.0/0`, `::/0`, listas vacías, prefijos cortos (`2000::/3`), redes inválidas, HTML, direcciones de la familia equivocada y texto con inyección (`; flush ruleset`). Con un rechazo, `nft -s list ruleset` no cambia.
- El despliegue continuo se prueba en el mismo tipo de contenedor, como `campusia`, con `DESPLIEGUE_ORIGEN` en un repo bare local, `DESPLIEGUE_PRUEBAS=bash ci/pruebas.sh`, `DESPLIEGUE_COMPILAR=bash ci/compilar.sh`, `DESPLIEGUE_SALUD` como un `test` de archivos y `DESPLIEGUE_SALUD_ESPERA=3`; `DESPLIEGUE_INSTALAR=bash despliegue/instalar.sh` (el instalador del proyecto de prueba; el defecto cambió en el contrato de cierre). Los scripts se ejecutan desde una copia de `despliegue/continuo/` (no desde `bin/`).
- `receptor.py` y `limpiar.sh` se prueban en el anfitrión (Python 3.12 del entorno de pruebas, bash y GNU coreutils). `limpiar.sh` se prueba con el Docker del anfitrión y un `DESPLIEGUE_IMAGEN` exclusivo de la prueba.
- `infraestructura/README.md` explica el orden para levantar todo desde cero y para importar lo existente, y menciona al menos: `tofu`, `import`, `ids_existentes`, `ansible-playbook`, `ansible-vault`, `~/.config/campusia`, `preparar-continuo.sh` y la `deploy key`.

No hay pruebas de fases anteriores en esta rama (el tramo es paralelo y no depende de otras fases); si se agregan carpetas `pruebas/fase-*/correr.sh`, `correr.sh` las corre antes.
