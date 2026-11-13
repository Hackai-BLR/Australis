# Cierre del tramo infraestructura como código

_Creado: 2026-11-10 09:43. Rama `tramo-infraestructura`. Alcance: `.orquestacion/tramo-infraestructura-cierre.md`. Contrato: `contratos/tramo-infraestructura-cierre.md` (completa y, donde difiere, reemplaza a `contratos/tramo-infraestructura.md`). Continúa `handoffs/261110_0558_tramo-infraestructura.md`, que no se modifica._

## 1. Qué se hizo

Se unió `main` a la rama (commit `Unión de main en el tramo de infraestructura`) y la infraestructura como código pasó a usar tal cual `despliegue/instalar.sh`, `despliegue/Caddyfile`, `despliegue/campusia-nucleo.service`, `despliegue/campusia.env.ejemplo` y `despliegue/respaldo/restaurar.sh` de `main`, sin modificarlos.

| Ruta | Cambio |
|---|---|
| `infraestructura/cloudflare/variables.tf` | `ip_servidor` sin valor por defecto, con validación estricta de IPv4 literal. La IP real va solo en `produccion.tfvars` (ignorado) o la pasa `levantar.sh` |
| `infraestructura/servidor/inventario.ejemplo.yml` | host de documentación `203.0.113.10` |
| `infraestructura/levantar.sh` | comando único del servidor reemplazable: `verificar`, `ansible`, `desplegar`, `restaurar`, `dns`, con salida `==> [n/5] <paso>` y `<paso>: <resultado>`. Solo variables de entorno, idempotente, sin secretos en salida ni argumentos, sin escribir en el repo |
| rol `base` | falla con mensaje claro fuera de Debian 12/13 y Ubuntu 22.04/24.04; instala `sudo`, `sqlite3`, `tar`, `gzip` y lo que falta en un VPS mínimo |
| rol `caddy` | Caddy del repositorio oficial (cloudsmith, `signed-by`, preferencia de apt), versión 2.8 o posterior verificada, reemplaza el de la distribución. Instala `despliegue/Caddyfile` byte a byte. Escribe `origen.key` y `origen.pem` desde el Vault solo si no existen. Se borró `Caddyfile.minimo` |
| rol `docker` | ya no llama a `despliegue/docker/preparar-docker.sh`: tareas propias para Debian y Ubuntu con el repositorio oficial de Docker; purga `podman`, `podman-docker` y `docker.io`; Docker del sistema deshabilitado; `campusia` fuera del grupo `docker`; `delegate.conf` y `campusia-nucleo.service.d/docker.conf`; perfil de AppArmor para `rootlesskit` en Ubuntu 24.04. Se borró `tasks/script.yml` |
| rol `campusia` | `campusia.env` generado a partir de `despliegue/campusia.env.ejemplo` con los nombres del núcleo de `main` (`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`, `SESSION_SECRET`); `continuo.env`, `/etc/campusia/instalar.env` y `/etc/campusia/known_hosts`; `/srv/campusia/config` con 0750 como lo deja `instalar.sh` |
| `despliegue/continuo/campusia-instalar` | instalador con privilegios: valida el commit, toma cerrojo, usa un espejo propio de root, exige que el commit esté publicado en la rama, extrae `despliegue/` de ese espejo y copia los artefactos sin seguir enlaces; corre `instalar.sh` de `main` |
| `despliegue/continuo/preparar-continuo.sh` | instala `campusia-instalar` y la regla de sudo única de `campusia` (validada con `visudo -cf`) |
| `despliegue/continuo/desplegar.sh` e `imagen/Dockerfile` | `DESPLIEGUE_INSTALAR` por defecto `sudo -n /usr/local/sbin/campusia-instalar "$COMMIT"`. Dependencias con `pnpm install --frozen-lockfile` con red y `--offline` sin red (reemplaza `pnpm fetch`, que fallaba con el `pnpm-workspace.yaml` de `interfaz/`); compilación `cargo build --release --locked` que deja `compilado/bin/campusia-nucleo` e `interfaz/dist/index.html`; pnpm 12.18.0 en la imagen |
| `pruebas/tramo-infraestructura-cierre/` | pruebas nuevas de punta a punta contra Debian 13 y Ubuntu 24.04 (sección 4) |
| `pruebas/tramo-infraestructura/` | ajustes a lo que cambió el contrato de cierre (nombres de `campusia.env`, permisos de `config`, `abort` de Caddy, IP de documentación, `DESPLIEGUE_INSTALAR` explícito en la prueba del continuo) |
| `infraestructura/README.md` | sin la IP real; sección de `levantar.sh` con todas sus variables y el orden manual equivalente |

## 2. Cómo se compila

No hay compilación propia del tramo. El binario y la interfaz se compilan en contenedores Docker con la etapa por defecto:

```
bash despliegue/continuo/desplegar.sh --etapa compilar
```

La imagen es `despliegue/continuo/imagen/Dockerfile` (base Debian 12, así el binario corre en Debian 12/13 y Ubuntu 22.04/24.04).

## 3. Cómo se levanta y se despliega

Servidor nuevo (Debian 12 o 13, Ubuntu 22.04 o 24.04) con SSH por clave, desde la máquina de quien tiene las credenciales:

```
CAMPUSIA_IP=<ip nueva> CLOUDFLARE_API_TOKEN="$(cat ~/.config/campusia/cloudflare-token)" \
TOFU_FRASE_ESTADO="$(cat ~/.config/campusia/tofu-frase)" ANSIBLE_VAULT_CONTRASENA="$(cat ~/.config/campusia/vault-pass)" \
[CAMPUSIA_RESPALDO=<carpeta o respaldo.tar.gz>] infraestructura/levantar.sh
```

Requiere `infraestructura/servidor/secretos.vault.yml` cifrado e `infraestructura/cloudflare/produccion.tfvars`. Las variables opcionales (`CAMPUSIA_SSH_USUARIO`, `CAMPUSIA_SSH_PUERTO`, `CAMPUSIA_SSH_CLAVE`, `CAMPUSIA_KNOWN_HOSTS`, `CAMPUSIA_VAULT_ARCHIVO`, `CAMPUSIA_TFVARS`, `CAMPUSIA_ANSIBLE_EXTRA`, `LEVANTAR_ESPERA_DESPLIEGUE`) están en la sección 3.1 del contrato y en `infraestructura/README.md`.

Después, el despliegue continuo sigue solo: el temporizador de 5 minutos busca commits nuevos en `main`, prueba y compila en contenedores, e instala con `sudo -n /usr/local/sbin/campusia-instalar <commit>`.

## 4. Cómo se prueba

Desde cero, sin pasos manuales (40 a 70 minutos; conviene en segundo plano):

```
bash pruebas/tramo-infraestructura-cierre/correr.sh
```

Corre primero las pruebas del tramo anterior (`SOLO_CIERRE=1` las omite), después las del cierre, e imprime los totales combinados. `CONSERVAR_CONTENEDORES=1` deja los contenedores para inspeccionarlos. Las pruebas del cierre compilan una instantánea del árbol de trabajo, la publican como `main` en un `git daemon`, levantan un VPS mínimo con systemd por distribución (Debian 13 y Ubuntu 24.04) y corren `levantar.sh` dos veces con un respaldo de prueba y una tercera con un respaldo alterado, con un `tofu` falso.

Resultado de la última corrida completa:

- aceptación: 82/82
- ataque: 154/154

## 5. Decisiones

- El rol `docker` no usa `despliegue/docker/preparar-docker.sh` porque solo admite Debian 13 y no es idempotente; replica lo mismo con tareas de Ansible.
- El Caddyfile de `main` se instala tal cual. No tiene todavía `handle /_despliegue/webhook`, así que el disparador efectivo del despliegue continuo es el temporizador.
- `campusia-instalar` nunca confía en lo que `campusia` puede escribir: código del instalador desde un espejo propio de root, solo commits publicados en la rama, artefactos copiados sin seguir enlaces y rechazando rutas que salen de `fuentes/<commit>/`.
- `campusia.env` se genera leyendo `despliegue/campusia.env.ejemplo` al correr el playbook, así cualquier variable nueva de `main` aparece sin tocar el rol.
- La prueba de Caddy del tramo anterior se ajustó: ahora exige el `abort` para orígenes que no son Cloudflare (detalle en "Cambios en pruebas" del contrato de cierre).
- La prueba de ataque de IPs públicas recorre `git ls-files --cached --others --exclude-standard` y permite solo rangos de documentación, redes con prefijo, privadas y loopback. Única excepción: el handoff del plan.

## 6. Desvíos del plan

- La IP real se quitó de todos los archivos versionados del tramo, pero sigue en el historial de git de commits anteriores de la rama. No se reescribió la historia.
- pnpm de la imagen de compilación subió de 9.15.0 a 12.18.0 para instalar la interfaz de `main` (su `pnpm-workspace.yaml` usa `allowBuilds`).
- El Docker sin root no corre dentro de los contenedores de prueba (sin `--privileged`); esa parte se omite con `servidor_contenedor_de_prueba` y el núcleo instalado en las pruebas no crea contenedores de cursos.

## 7. Pendientes conocidos

- **`br_netfilter`** (punto 7 del alcance, agregado durante la ejecución): el rol `docker` todavía no carga el módulo ni escribe `/etc/modules-load.d/campusia-docker.conf`, y la prueba de punta a punta no verifica que el núcleo de la fase 2 cree su red de cursos. En el servidor real se arregló a mano. Hay que agregarlo al rol (y a `despliegue/docker/preparar-docker.sh` si corresponde, en su tramo) con una prueba.
- Webhook público: falta `handle /_despliegue/webhook` en el `despliegue/Caddyfile` de `main` (tramo de despliegue).
- Correr `levantar.sh` contra un VPS real con las credenciales y confirmar el DNS con OpenTofu real (las pruebas usan un `tofu` falso).
- Ubuntu 22.04 y Debian 12 están admitidos por el rol `base` pero las pruebas de punta a punta solo cubren Debian 13 y Ubuntu 24.04.
