# Infraestructura como código

Dos partes:

| Carpeta | Herramienta | Qué describe |
|---|---|---|
| `cloudflare/` | OpenTofu 1.10 con el proveedor `cloudflare/cloudflare` 5.x | DNS, reenvío de correo, ajustes de zona, Turnstile y certificado de origen |
| `servidor/` | Ansible (ansible-core 2.18) | el servidor: paquetes, usuario `campusia`, SSH, nftables, swap, Caddy, Docker sin root, `campusia.env` y el despliegue continuo |
| `levantar.sh` | bash, `ssh`, Ansible y OpenTofu | un servidor nuevo completo en un solo comando: Ansible, primer despliegue, restauración de un respaldo y DNS |

En el repo no hay ningún secreto. Todo lo secreto vive fuera, en `~/.config/campusia/` de quien tiene las credenciales, con permisos 600:

| Archivo | Contenido | Lo usa |
|---|---|---|
| `~/.config/campusia/cloudflare-token` | token de la API de Cloudflare | `cloudflare/tofu.sh` |
| `~/.config/campusia/tofu-frase` | frase de paso del estado cifrado (16 caracteres o más) | `cloudflare/tofu.sh` |
| `~/.config/campusia/vault-pass` | contraseña del Ansible Vault | `ansible-playbook` y `ansible-vault` |

```
mkdir -p ~/.config/campusia && chmod 700 ~/.config/campusia
printf '%s' '<token>' > ~/.config/campusia/cloudflare-token
openssl rand -base64 32 > ~/.config/campusia/tofu-frase
openssl rand -base64 32 > ~/.config/campusia/vault-pass
chmod 600 ~/.config/campusia/*
```

La frase del estado y la contraseña del Vault no se pueden recuperar: guardalas también en un gestor de contraseñas. Sin la frase no se lee `cloudflare/estado/terraform.tfstate`; sin la contraseña no se abre `servidor/secretos.vault.yml`.

## Herramientas

Sin sudo:

```
pipx install --include-deps 'ansible-core>=2.18,<2.19'
pipx inject ansible-core ansible-lint
curl -fsSL -o /tmp/tofu.zip https://github.com/opentofu/opentofu/releases/download/v1.10.7/tofu_1.10.7_linux_amd64.zip
unzip -o /tmp/tofu.zip tofu -d ~/.local/bin
cd infraestructura/servidor && ansible-galaxy collection install -r requirements.yml
```

## Secretos del servidor (Ansible Vault)

`servidor/secretos.ejemplo.yml` tiene las claves con valores ficticios. El Vault real se crea una vez y se versiona cifrado:

```
cd infraestructura/servidor
cp secretos.ejemplo.yml /tmp/secretos.yml
$EDITOR /tmp/secretos.yml
ansible-vault encrypt --vault-password-file ~/.config/campusia/vault-pass --output secretos.vault.yml /tmp/secretos.yml
shred -u /tmp/secretos.yml
```

Para cambiar un valor después: `ansible-vault edit --vault-password-file ~/.config/campusia/vault-pass secretos.vault.yml`. El archivo empieza con `$ANSIBLE_VAULT;` y es el único que se sube. `sitio.yml` lo carga solo si existe. Para no repetir la opción se puede exportar `ANSIBLE_VAULT_PASSWORD_FILE=~/.config/campusia/vault-pass`.

| Clave del Vault | Variable en `/srv/campusia/config/campusia.env` |
|---|---|
| `vault_brevo_api_key` | `BREVO_API_KEY` |
| `vault_claude_code_oauth_token` | `CLAUDE_CODE_OAUTH_TOKEN` |
| `vault_turnstile_clave_sitio` | `TURNSTILE_SITE_KEY` |
| `vault_turnstile_clave_secreta` | `TURNSTILE_SECRET` |
| `vault_secreto_sesion` | `SESSION_SECRET` (32 caracteres o más) |
| `vault_secreto_firma` | `SECRETO_FIRMA` |
| `vault_secreto_webhook` | `SECRETO_WEBHOOK` (el mismo secreto que se carga en el webhook de GitHub) |
| `vault_identidad_clave_privada` | `IDENTIDAD_CLAVE_PRIVADA` (semilla Ed25519 de 32 bytes en base64url sin relleno). Si la base del núcleo ya guarda una, tiene que ser esa: el rol se niega a cambiarla. De ella sale `IDENTITY_PUBLIC_KEY` en `australis.env` |
| `vault_origen_clave` (opcional) | no va a `campusia.env`: se escribe en `/etc/caddy/certs/origen.key` si no existe |
| `vault_origen_certificado` (opcional) | no va a `campusia.env`: se escribe en `/etc/caddy/certs/origen.pem` si no existe |

`campusia.env` tiene una línea por cada variable de `despliegue/campusia.env.ejemplo` (se lee del repo al correr el playbook): los secretos salen del Vault y el resto toma el valor del ejemplo (`ENTORNO=produccion`, `DOMINIO_BASE=campusia.tech`, `PROVEEDOR_EMAIL=brevo`, `PUERTO=8080`, etc.). `campusia_env_extra` agrega o reemplaza variables no secretas. El rol falla si alguna queda con `completar`.

La clave y el certificado de origen se escriben solo si ninguno de los dos archivos existe (o si existe la clave y es la misma del Vault), y nunca reemplazan una clave o un certificado que ya están en el servidor. Se pegan en el Vault como texto PEM completo.

## Inventario

`servidor/inventario.ejemplo.yml` usa la IP de documentación `203.0.113.10`. Copialo a `servidor/inventario.yml` (ignorado por git) y poné la IP real y las claves públicas de `ssh_claves_root`. La IP real solo va en archivos ignorados (`servidor/inventario.yml`, `cloudflare/produccion.tfvars`) o en `CAMPUSIA_IP` al correr `levantar.sh`. El rol `ssh` se niega a desactivar las contraseñas si `root` no tiene ninguna clave autorizada.

Variables que se pueden cambiar por host:

| Variable | Defecto | Uso |
|---|---|---|
| `ssh_claves_root` | `[]` | claves públicas que se agregan a root (nunca se quitan las existentes) |
| `swap_tamano_mb` | `4096` | tamaño de `/swapfile` |
| `firewall_cloudflare_ipv4` y `firewall_cloudflare_ipv6` | sin definir | listas fijas en lugar de descargar `https://www.cloudflare.com/ips-v4` e `ips-v6` |
| `caddy_caddyfile_origen` | `despliegue/Caddyfile` del repo | se instala tal cual en `/etc/caddy/Caddyfile` |
| `campusia_env_extra` | `{}` | variables no secretas que se agregan o reemplazan en `campusia.env` |
| `despliegue_origen` | `git@github.com:ORGANIZACION/campusia.git` | `DESPLIEGUE_ORIGEN` en `continuo.env` e `INSTALAR_ORIGEN` en `/etc/campusia/instalar.env` |
| `despliegue_rama` | `main` | `DESPLIEGUE_RAMA` e `INSTALAR_RAMA` |
| `despliegue_continuo_env` | `{}` | variables extra de `/srv/campusia/config/continuo.env` |
| `despliegue_known_hosts` | claves de host publicadas de `github.com` | contenido de `/etc/campusia/known_hosts` |
| `servidor_zona_horaria` | `America/Argentina/Buenos_Aires` | zona horaria del servidor; el temporizador de respaldo (`04:30`) usa la hora local |
| `servidor_contenedor_de_prueba` | `false` | solo para las pruebas: no hace `swapon`, no aplica `sysctl` en vivo ni instala el perfil de AppArmor de `rootlesskit`; sin `servidor_docker_sin_root_en_prueba` tampoco arranca Docker sin root ni carga `br_netfilter` |
| `servidor_docker_sin_root_en_prueba` | `false` | solo tiene efecto con `servidor_contenedor_de_prueba: true`: en `true` igual carga `br_netfilter` e instala, habilita y verifica Docker sin root de `campusia` (para contenedores `--privileged` con `/lib/modules` montado). Fuera de los contenedores de prueba todo se hace siempre |

## Importar lo que ya existe

La infraestructura actual se creó a mano. Primero se importa a OpenTofu sin cambiar nada, después se aplica Ansible sobre el servidor existente.

### 1. Cloudflare

```
cd infraestructura/cloudflare
cp variables.ejemplo.tfvars produccion.tfvars
$EDITOR produccion.tfvars
./tofu.sh init
./tofu.sh plan -var-file=produccion.tfvars
```

`produccion.tfvars` está ignorado por git. Ahí van los valores reales no secretos (`correo_destino_reenvio`, `csr_origen`) y el mapa `ids_existentes` con el id de cada recurso que ya existe en Cloudflare. Cada clave del mapa activa el bloque `import` (en `importar.tf`) del recurso que le corresponde; con el mapa vacío no se importa nada.

| Clave de `ids_existentes` | Recurso | Formato del id | De dónde sale |
|---|---|---|---|
| `apex` | `cloudflare_dns_record.registros["apex"]` | `<id del registro>` (32 hex) o `<zona>/<id del registro>` | `GET /zones/<zona>/dns_records?name=campusia.tech&type=A` |
| `comodin` | `cloudflare_dns_record.registros["comodin"]` | idem | `name=*.campusia.tech&type=A` |
| `brevo1_dkim` | `cloudflare_dns_record.registros["brevo1_dkim"]` | idem | `name=brevo1._domainkey.campusia.tech` |
| `brevo2_dkim` | `cloudflare_dns_record.registros["brevo2_dkim"]` | idem | `name=brevo2._domainkey.campusia.tech` |
| `brevo_codigo` | `cloudflare_dns_record.registros["brevo_codigo"]` | idem | TXT del apex con `brevo-code:` |
| `dmarc` | `cloudflare_dns_record.registros["dmarc"]` | idem | `name=_dmarc.campusia.tech&type=TXT` |
| `spf` | `cloudflare_dns_record.registros["spf"]` | idem | TXT del apex con `v=spf1` |
| `reenvio` | `cloudflare_email_routing_dns.reenvio` | cualquier valor no vacío (se importa con el id de la zona) | |
| `destino` | `cloudflare_email_routing_address.destino` | `<id de la dirección>` o `<cuenta>/<id de la dirección>` | `GET /accounts/<cuenta>/email/routing/addresses` |
| `hola` | `cloudflare_email_routing_rule.hola` | `<id de la regla>` o `<zona>/<id de la regla>` | `GET /zones/<zona>/email/routing/rules` |
| `ssl` | `cloudflare_zone_setting.ssl` | cualquier valor no vacío (se importa como `<zona>/ssl`) | |
| `always_use_https` | `cloudflare_zone_setting.always_use_https` | idem (`<zona>/always_use_https`) | |
| `tls_minimo` | `cloudflare_zone_setting.tls_minimo` | idem (`<zona>/min_tls_version`) | |
| `login` | `cloudflare_turnstile_widget.login` | `<sitekey>` o `<cuenta>/<sitekey>` | `GET /accounts/<cuenta>/challenges/widgets` |
| `origen` | `cloudflare_origin_ca_certificate.origen` | id numérico del certificado de origen | `GET /certificates?zone_id=<zona>` |

La cuenta es `00000000000000000000000000000000` y la zona `11111111111111111111111111111111`. Para listar los ids:

```
TOKEN="$(cat ~/.config/campusia/cloudflare-token)"
curl -s -H "Authorization: Bearer $TOKEN" "https://api.cloudflare.com/client/v4/zones/11111111111111111111111111111111/dns_records?per_page=100" | jq -r '.result[] | [.id, .type, .name, .content] | @tsv'
```

`csr_origen` es el pedido que está en el servidor en `/etc/caddy/certs/origen.csr` (lo genera el rol `caddy` a partir de la clave existente; es público). El certificado tiene `prevent_destroy` e ignora cambios en el CSR, así que importarlo no lo recrea.

El plan tiene que mostrar solo importaciones y, como mucho, cambios cosméticos. Si propone destruir o reemplazar algo, no se aplica: se corrige la configuración o el id. Cuando el plan está bien:

```
./tofu.sh apply -var-file=produccion.tfvars
git add estado/terraform.tfstate && git commit -m "Estado de Cloudflare importado"
```

El estado queda cifrado en `cloudflare/estado/terraform.tfstate` y se versiona. Una vez importado, las entradas de `ids_existentes` se pueden dejar (no vuelven a importar recursos que ya están en el estado) o borrar.

### 2. Servidor existente

```
cd infraestructura/servidor
ansible-playbook -i inventario.yml sitio.yml --vault-password-file ~/.config/campusia/vault-pass --check --diff
ansible-playbook -i inventario.yml sitio.yml --vault-password-file ~/.config/campusia/vault-pass
```

La primera corrida con `--check` muestra qué cambiaría sin tocar nada. Los roles respetan lo que ya está: no recrean `origen.key` ni `origen.pem` (solo ajustan dueño y permisos: clave `root:caddy` 640), no quitan claves de SSH y reemplazan `campusia.env` por el que sale del Vault (cargá antes en el Vault los valores que hoy tiene el archivo). Una segunda corrida tiene que terminar con `changed=0`.

## Levantar todo desde cero

### Con `levantar.sh`

Para un VPS nuevo (Debian 12 o 13, Ubuntu 22.04 o 24.04) con acceso SSH por clave, desde cualquier carpeta:

```
CAMPUSIA_IP=<ip nueva> CLOUDFLARE_API_TOKEN="$(cat ~/.config/campusia/cloudflare-token)" \
TOFU_FRASE_ESTADO="$(cat ~/.config/campusia/tofu-frase)" ANSIBLE_VAULT_CONTRASENA="$(cat ~/.config/campusia/vault-pass)" \
[CAMPUSIA_RESPALDO=<carpeta del respaldo>] infraestructura/levantar.sh
```

Hace falta tener `ssh`, `scp`, `ansible-playbook`, `ansible-galaxy`, `tofu`, `git` y `sha256sum` en el `PATH`, `servidor/secretos.vault.yml` cifrado y `cloudflare/produccion.tfvars`. No escribe nada en el repo: el inventario, la contraseña del Vault y los datos de OpenTofu (`TF_DATA_DIR`) van a una carpeta de `mktemp -d` que se borra al salir.

| Variable | Obligatoria | Defecto | Uso |
|---|---|---|---|
| `CAMPUSIA_IP` | sí | | IPv4 literal del servidor nuevo: destino de SSH y `ip_servidor` de OpenTofu |
| `CAMPUSIA_SSH_USUARIO` | no | `root` | usuario de SSH; si no es `root`, Ansible y los comandos remotos usan `sudo` sin contraseña |
| `CAMPUSIA_SSH_PUERTO` | no | `22` | puerto de SSH |
| `CAMPUSIA_SSH_CLAVE` | no | agente o claves por defecto de `ssh` | clave privada de SSH |
| `CAMPUSIA_KNOWN_HOSTS` | no | `~/.config/campusia/known_hosts` | claves de host; se usa con `StrictHostKeyChecking=accept-new` |
| `CLOUDFLARE_API_TOKEN` | sí | | token de Cloudflare; solo llega a OpenTofu como `TF_VAR_cloudflare_api_token` |
| `TOFU_FRASE_ESTADO` | sí | | frase del estado cifrado (16 caracteres o más); solo llega como `TF_VAR_frase_estado` |
| `ANSIBLE_VAULT_CONTRASENA` | sí | | contraseña del Vault; se entrega con `--vault-password-file` (archivo temporal 0600), nunca en los argumentos |
| `CAMPUSIA_VAULT_ARCHIVO` | no | `infraestructura/servidor/secretos.vault.yml` | Vault cifrado (tiene que empezar con `$ANSIBLE_VAULT;`) |
| `CAMPUSIA_TFVARS` | no | `infraestructura/cloudflare/produccion.tfvars` | variables de OpenTofu |
| `CAMPUSIA_RESPALDO` | no | vacío (sin restauración) | carpeta con `respaldo.tar.gz` y `respaldo.tar.gz.sha256`, o la ruta de `respaldo.tar.gz` con su `.sha256` al lado |
| `CAMPUSIA_ANSIBLE_EXTRA` | no | | archivo YAML o JSON de variables extra para Ansible (`-e @archivo`) |
| `LEVANTAR_ESPERA_DESPLIEGUE` | no | `3600` | segundos máximos esperando el primer despliegue si hay otro en curso |

Pasos, cada uno con su línea `==> [n/5] <paso>` y su resultado `<paso>: <resultado>`; al final `levantar: listo`. Si un paso falla imprime `levantar: falló el paso <paso>` y no sigue.

1. `verificar`: valida las variables, los archivos y los programas (sale con código 2 nombrando la variable, sin conectarse a nada) y prueba la conexión SSH.
2. `ansible`: instala las colecciones de `servidor/requirements.yml` y corre `sitio.yml` contra un inventario temporal con el host `CAMPUSIA_IP`.
3. `desplegar`: por SSH corre como `campusia`, con las variables de `continuo.env`, `desplegar.sh --forzar` (si el cerrojo está ocupado reintenta cada 10 segundos) y comprueba que `actual` es la última versión de la rama y que `/salud` responde. Resultado `desplegar: <commit>` o `desplegar: sin cambios <commit>`.
4. `restaurar`: si hay `CAMPUSIA_RESPALDO` y su suma no es la de `/srv/campusia/config/restaurado`, copia el respaldo y `despliegue/respaldo/restaurar.sh` del repo local a una carpeta temporal de root, restaura con `CAMPUSIA_SERVICIO=campusia-nucleo.service` y guarda la suma en `restaurado`. Un respaldo alterado se rechaza y los datos quedan como estaban. Si ya se restauró: `restaurar: ya restaurado`.
5. `dns`: `tofu init` y `tofu apply -target` de los registros `apex` y `comodin` con `ip_servidor=$CAMPUSIA_IP`.

Se puede volver a correr con las mismas variables: Ansible informa `changed=0`, el despliegue no hace nada, la restauración dice `ya restaurado` y OpenTofu no tiene cambios. Ningún secreto aparece en la salida ni en los argumentos de los programas.

Después: actualizá `ip_servidor` en `produccion.tfvars`, versioná el estado cifrado y, si el servidor clona por SSH, creá la deploy key (paso 5 de abajo).

### A mano (orden equivalente)

1. Secretos locales en `~/.config/campusia/` (ver arriba) y `servidor/secretos.vault.yml` ya creado con `ansible-vault`.
2. Inventario con la IP nueva en `servidor/inventario.yml`.
3. Servidor:

   ```
   cd infraestructura/servidor
   ansible-galaxy collection install -r requirements.yml
   ansible-playbook -i inventario.yml sitio.yml -e @secretos.vault.yml --vault-password-file ~/.config/campusia/vault-pass
   ```

   Aplica en orden los roles `base`, `usuario`, `ssh`, `firewall`, `swap`, `caddy`, `docker` y `campusia`. `base` verifica la distribución y fija la zona horaria. `caddy` instala Caddy del repositorio oficial (`dl.cloudsmith.io`), escribe el certificado de origen desde el Vault si no existe y, si tampoco está en el Vault, genera `/etc/caddy/certs/origen.key` y `origen.csr` y deja Caddy detenido hasta que esté `origen.pem`. `docker` instala Docker del repositorio oficial, desinstala podman, carga y persiste `br_netfilter` y deja Docker sin root para `campusia`. `campusia` escribe `campusia.env`, `continuo.env`, `/etc/campusia/instalar.env` y `/etc/campusia/known_hosts` y corre `despliegue/continuo/preparar-continuo.sh`, que instala los scripts, las unidades de usuario y `campusia-instalar`.

4. Certificado de origen. Si no está en el Vault, copiá `/etc/caddy/certs/origen.csr` a `csr_origen` en `produccion.tfvars`. Si el certificado viejo ya está en el estado y la clave vieja se perdió, hay que reemplazarlo a propósito: quitar `prevent_destroy` en una rama, `./tofu.sh apply -replace=cloudflare_origin_ca_certificate.origen` y volver a ponerlo. El certificado emitido se lee con `./tofu.sh state show cloudflare_origin_ca_certificate.origen`, se carga en el Vault (`vault_origen_clave` y `vault_origen_certificado`) o se copia a `/etc/caddy/certs/origen.pem`, y se vuelve a correr `ansible-playbook` para que Caddy arranque.

5. Deploy key. El servidor clona el repo con su propia deploy key de solo lectura en `/srv/campusia/.ssh/campusia_deploy` (`DESPLIEGUE_CLAVE` e `INSTALAR_CLAVE`). La crea quien tiene las credenciales, en el servidor:

   ```
   runuser -u campusia -- mkdir -p -m 700 /srv/campusia/.ssh
   runuser -u campusia -- ssh-keygen -t ed25519 -N '' -C campusia-deploy -f /srv/campusia/.ssh/campusia_deploy
   runuser -u campusia -- ssh-keyscan github.com >> /srv/campusia/.ssh/known_hosts
   cat /srv/campusia/.ssh/campusia_deploy.pub
   ```

   La clave pública se carga en GitHub como deploy key del repo, sin permiso de escritura. La privada nunca sale del servidor.

6. Webhook de GitHub hacia `https://campusia.tech/_despliegue/webhook`, tipo `application/json`, solo el evento `push`, con el mismo secreto que `vault_secreto_webhook`. Mientras tanto el temporizador de 5 minutos despliega igual.

7. Primer despliegue (compila en contenedores Docker sin root, el servidor no necesita Rust ni Node; instala con `sudo -n /usr/local/sbin/campusia-instalar`):

   ```
   runuser -u campusia -- env XDG_RUNTIME_DIR=/run/user/$(id -u campusia) systemctl --user start campusia-despliegue.service
   runuser -u campusia -- /srv/campusia/despliegue/bin/registro.sh -n 5
   ```

8. Restauración opcional de un respaldo, como root en el servidor:

   ```
   CAMPUSIA_SERVICIO=campusia-nucleo.service bash restaurar.sh <carpeta con respaldo.tar.gz y respaldo.tar.gz.sha256>
   ```

9. DNS hacia la IP nueva:

   ```
   cd infraestructura/cloudflare
   ./tofu.sh apply -var-file=produccion.tfvars -var ip_servidor=<ip nueva> -target='cloudflare_dns_record.registros["apex"]' -target='cloudflare_dns_record.registros["comodin"]'
   ```

   Después actualizá `ip_servidor` en `produccion.tfvars` y versioná el estado.

## Zona horaria

El rol `base` instala `tzdata`, enlaza `/etc/localtime` a `/usr/share/zoneinfo/<servidor_zona_horaria>` y, si la distribución usa `/etc/timezone`, escribe ahí el nombre de la zona (`root:root 0644`). No usa `timedatectl` ni toca el reloj de hardware. Al final verifica que `/etc/localtime` apunta a la zona. `campusia-respaldo.timer` (`OnCalendar=*-*-* 04:30:00`) corre a las 04:30 de Buenos Aires.

## `br_netfilter` y Docker sin root

El Docker sin root de `campusia` necesita el módulo `br_netfilter` para las redes puente (entre ellas `campusia-cursos`, que crea el núcleo al arrancar; sin Docker sin root el núcleo no arranca). El rol `docker`:

1. instala `kmod` (trae `modprobe`; los VPS mínimos no lo tienen);
2. escribe siempre `/etc/modules-load.d/campusia-docker.conf` con `br_netfilter` (`root:root 0644`), así `systemd-modules-load` lo carga en cada arranque;
3. carga el módulo con `community.general.modprobe` antes de instalar Docker sin root;
4. arranca `user@<uid>.service`, espera `/run/user/<uid>/bus`, corre `dockerd-rootless-setuptool.sh install` y `systemctl --user enable --now docker.service` como `campusia`;
5. verifica que `docker.service` de usuario está habilitado y activo, que existe `/sys/module/br_netfilter` y que el archivo de `modules-load.d` tiene el contenido y los permisos esperados.

Antes de arrancar Docker sin root el rol escribe `/etc/systemd/user/docker.service.d/campusia-red.conf` (`root:root 0644`) con `DOCKERD_ROOTLESS_ROOTLESSKIT_DETACH_NETNS=false`. El núcleo abre la escucha de la API para cursos con `nsenter -U -n -t <child_pid>`; con el modo `detach-netns` (el predeterminado de Docker 29) `/proc/<child_pid>/ns/net` a veces no es la red de Docker sino una que pertenece al espacio de usuarios del servidor, y `nsenter` falla con `Operation not permitted`. Sin ese modo todo el proceso hijo vive en la red de Docker. Si el archivo cambia en un servidor que ya tenía Docker sin root, el rol lo reinicia. `despliegue/docker/preparar-docker.sh` escribe el mismo archivo. El drop-in `campusia-nucleo.service.d/docker.conf` además espera hasta 90 s a que `docker version` responda antes de arrancar el núcleo.

En un contenedor de prueba los pasos 3 y 4 y las verificaciones de Docker sin root y de `/sys/module/br_netfilter` solo corren con `servidor_docker_sin_root_en_prueba: true`; el perfil de AppArmor, `swapon` y `sysctl` se omiten siempre en los contenedores de prueba. La segunda corrida termina con `changed=0`.

## Firewall y rangos de Cloudflare

80 y 443 solo aceptan los rangos publicados por Cloudflare (conjuntos `cloudflare_v4` y `cloudflare_v6` de la tabla `inet filtro`); 22 queda abierto. `/usr/local/sbin/campusia-cloudflare-ips` baja las listas (`CLOUDFLARE_IPS_V4_URL` y `CLOUDFLARE_IPS_V6_URL`), rechaza listas vacías, redes inválidas y prefijos más cortos que `/8` o `/16` sin tocar nada, y si todo está bien las aplica en una sola transacción de `nft` y las guarda en `/etc/nftables.d/campusia-cloudflare.nft`. Lo corre `campusia-cloudflare-ips.timer` una vez por semana.

## Comprobar

```
cd infraestructura/servidor && ansible-lint --offline --profile moderate
cd infraestructura/cloudflare && tofu fmt -check && tofu init -backend=false && tofu validate
bash pruebas/tramo-infraestructura/correr.sh
bash pruebas/tramo-infraestructura-final/correr.sh
```
