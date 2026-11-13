# Contrato del tramo final de infraestructura

_Creado: 2026-11-10. Rama `tramo-infraestructura`. Alcance: `.orquestacion/tramo-infraestructura-final.md`. Continúa `contratos/tramo-infraestructura.md` y `contratos/tramo-infraestructura-cierre.md`: todo lo que fijan sigue vigente salvo lo que este documento cambia explícitamente._

`origin/main` ya está unido a la rama (commit `Unión de main en el tramo de infraestructura (fase 4)`). Desde esa unión el núcleo de `main` arranca con `PROVEEDOR_CONTENEDORES=docker` fijo en `despliegue/campusia-nucleo.service`: si no puede preparar la red de cursos en el Docker sin root de `campusia`, sale con error. Por eso Docker sin root y `br_netfilter` dejan de ser opcionales en las pruebas de punta a punta.

Solo se tocan estas carpetas:

| Ruta | Módulo |
|---|---|
| `infraestructura/` | servidor |
| `despliegue/` (incluye `Caddyfile`, `instalar.sh`, `docker/`, `respaldo/`, `continuo/`) | despliegue |
| `contratos/tramo-infraestructura-final.md`, `pruebas/tramo-infraestructura-final/`, `pruebas/tramo-infraestructura-cierre/` (ver "Cambios en pruebas") | contrato |
| `handoffs/` | cierre (un archivo nuevo) |

## 1. Rutas HTTP

No hay rutas nuevas en la API del núcleo ni pantallas nuevas. Cambia cómo llega el webhook del despliegue continuo:

| Método y ruta | Quién la llama | Comportamiento |
|---|---|---|
| `* https://campusia.tech/_despliegue/webhook` (puerto 443) | GitHub, a través de Cloudflare | Caddy la manda a `127.0.0.1:9010` (receptor del despliegue continuo, `despliegue/continuo/receptor.py`, sin cambios). Solo el camino exacto `/_despliegue/webhook`: `/_despliegue/webhook/`, `/_despliegue/webhookx`, `/_despliegue/webhook/otra`, `/_despliegue/otra` y cualquier otra ruta siguen yendo al núcleo |
| `* https://campusia.tech/*` y `https://*.campusia.tech/*` | solo Cloudflare | sin cambios: al núcleo en `127.0.0.1:8080` con `CF-Connecting-IP` y `X-Forwarded-For` iguales a la IP real del cliente |
| cualquier ruta desde un origen que no es Cloudflare | | `abort` (Caddy corta la conexión sin responder), **también** para `/_despliegue/webhook`. Los encabezados `CF-Connecting-IP`, `X-Forwarded-For` o `X-Real-IP` de un origen que no es Cloudflare no cambian nada |

Respuestas del receptor que se ven a través de Caddy (definidas en el contrato del tramo de infraestructura, sección 1):

| Caso | Código | Cuerpo |
|---|---|---|
| `POST` con `X-Hub-Signature-256` válida, `X-GitHub-Event: ping` y `X-GitHub-Delivery` nueva | 200 | `{"resultado": "pong"}` |
| `POST` con firma válida y `push` a la rama | 202 | dispara `campusia-despliegue.service` |
| firma ausente o inválida | 401 | `{"resultado": "firma invalida"}` |
| entrega repetida | 409 | |
| otro método | 405 | |

### Caddyfile

`despliegue/Caddyfile` agrega, dentro del bloque `campusia.tech, *.campusia.tech`, un bloque

```
handle /_despliegue/webhook {
	reverse_proxy 127.0.0.1:9010
}
```

con esa forma exacta (la prueba busca `handle /_despliegue/webhook {` y `reverse_proxy 127.0.0.1:9010` dentro). El resto del archivo (opciones globales, `tls`, `request_body`, `@fuera_de_cloudflare`, el `handle` del núcleo) no cambia de comportamiento. Ojo: Caddy ordena los `handle` por especificidad de su matcher de camino, así que un `handle /_despliegue/webhook` suelto puede quedar **antes** del `handle @fuera_de_cloudflare` y dejar el webhook abierto a cualquier origen. La implementación tiene que garantizar que el corte de orígenes que no son Cloudflare se aplica primero (por ejemplo con `route { … }` envolviendo los `handle`, o con `abort @fuera_de_cloudflare` antes), y las pruebas de ataque lo verifican. El archivo queda en el formato de `caddy fmt` y es válido para Caddy 2.8 (`caddy adapt` sin errores).

## 2. Modelo de datos y migraciones

No hay migraciones. Archivos nuevos o que cambian en el servidor:

| Ruta | Dueño y permisos | Contenido | Lo crea |
|---|---|---|---|
| `/etc/modules-load.d/campusia-docker.conf` | `root:root 0644` | exactamente `br_netfilter\n` | rol `docker` y `preparar-docker.sh` |
| `/etc/localtime` | enlace a `/usr/share/zoneinfo/America/Argentina/Buenos_Aires` | | rol `base` |
| `/etc/timezone` (si la distribución lo usa) | `root:root 0644` | `America/Argentina/Buenos_Aires` | rol `base` |
| `/srv/campusia/plataforma/despliegue/` y `…/despliegue/respaldo/` | `root:campusia 0750` | carpetas | `instalar.sh` |
| `/srv/campusia/plataforma/despliegue/respaldo/respaldar.sh` y `restaurar.sh` | `root:campusia 0750` (nunca escribibles por `campusia`) | copia exacta de `despliegue/respaldo/` del commit instalado | `instalar.sh` |
| `/etc/systemd/system/campusia-respaldo.service` y `.timer` | `root:root 0644` | copia exacta de `despliegue/respaldo/` | `instalar.sh` |
| `/srv/campusia/respaldos/` | `campusia:campusia 0700` | un respaldo por carpeta `AAAAMMDD-HHMMSS/` con `respaldo.tar.gz` y `respaldo.tar.gz.sha256` (`campusia`, 0600) | `instalar.sh` (ya lo hacía) y `respaldar.sh` |

En la carpeta de respaldo instalada solo hay dos ejecutables: `respaldar.sh` y `restaurar.sh`.

## 3. Variables

### 3.1 Ansible (`infraestructura/servidor/`)

| Variable | Defecto | Uso |
|---|---|---|
| `servidor_zona_horaria` | `America/Argentina/Buenos_Aires` | zona horaria del servidor (rol `base`) |
| `servidor_docker_sin_root_en_prueba` | `false` | con `servidor_contenedor_de_prueba: true`, si es `true` el rol `docker` igual instala, habilita y verifica Docker sin root de `campusia` y carga `br_netfilter` (las pruebas corren en contenedores `--privileged` con `/lib/modules` montado). Con `false` en un contenedor de prueba se omite Docker sin root y la carga del módulo (no el archivo de `modules-load.d`), como hasta ahora. Fuera de contenedores de prueba no tiene efecto: todo se hace siempre |

Lo que sigue omitiéndose en cualquier contenedor de prueba: el perfil de AppArmor de `rootlesskit`, `swapon` y `sysctl`.

### 3.2 `instalar.sh`

Sin opciones nuevas. Con `--raiz <carpeta> --sin-servicios` copia también los guiones y las unidades de respaldo debajo de esa raíz (`<raiz>/srv/campusia/plataforma/despliegue/respaldo/` y `<raiz>/etc/systemd/system/`) sin tocar systemd.

### 3.3 `campusia.env`

Sin cambios. `DIR_RESPALDOS=/srv/campusia/respaldos` ya está en el ejemplo.

## 4. Módulo servidor (`infraestructura/`)

- Rol `base`: instala `tzdata` y deja la zona horaria en `servidor_zona_horaria` (`community.general.timezone` o enlace de `/etc/localtime` más `/etc/timezone`), idempotente (la segunda corrida informa `changed=0`). Verifica al final que `/etc/localtime` apunta a esa zona. Nunca toca el reloj de hardware.
- Rol `docker`:
  - instala `kmod` (los VPS mínimos de prueba no traen `modprobe`);
  - escribe `/etc/modules-load.d/campusia-docker.conf` (`br_netfilter\n`, `root:root 0644`) siempre;
  - carga `br_netfilter` (`community.general.modprobe` o `modprobe br_netfilter`) antes de instalar Docker sin root, salvo en un contenedor de prueba sin `servidor_docker_sin_root_en_prueba`;
  - las tareas de Docker sin root (arrancar `user@<uid>.service`, `dockerd-rootless-setuptool.sh install`, `systemctl --user enable --now docker.service`, verificación final) corren cuando `not servidor_contenedor_de_prueba or servidor_docker_sin_root_en_prueba`;
  - verifica al final que `/sys/module/br_netfilter` existe (con la misma condición que la carga) y que el archivo de `modules-load.d` tiene el contenido esperado;
  - todo idempotente.
- `levantar.sh`, `sitio.yml` y el resto de los roles sin cambios de interfaz. `README.md` documenta las dos variables nuevas, `br_netfilter` y la zona horaria.

## 5. Módulo despliegue (`despliegue/`)

- `Caddyfile`: sección 1.
- `docker/preparar-docker.sh` (sigue siendo solo para Debian 13): después de verificar el usuario y antes de instalar Docker, instala `kmod` si falta `modprobe`, corre `modprobe br_netfilter` y escribe `/etc/modules-load.d/campusia-docker.conf` (`br_netfilter\n`, 0644) con la función `escribir`. Además, después de `loginctl enable-linger` arranca `user@<uid>.service` y espera a que exista `/run/user/<uid>/bus` antes de usar `systemctl --user` (hoy falla en un VPS recién creado con `Failed to connect to user scope bus`). El resto sin cambios. Tiene que terminar con 0 en un Debian 13 mínimo con `curl` y el usuario `campusia` con sus subuid y subgid.
- `instalar.sh`:
  - copia `"$AQUI/respaldo/respaldar.sh"` y `restaurar.sh` a `$PLATAFORMA/despliegue/respaldo/` y `campusia-respaldo.service` y `.timer` a la carpeta de unidades de systemd de la raíz, verificando que existen en `$AQUI/respaldo/` (si falta alguno, falla con `instalar.sh: falta …`);
  - nunca escribe a través de enlaces: arma la carpeta en un temporal dentro de `$PLATAFORMA` y la reemplaza con `mv` (como `copiar_carpeta`), y si `$PLATAFORMA/despliegue` o `…/respaldo` es un enlace lo reemplaza sin seguirlo; las unidades se escriben con temporal y `mv -f`;
  - con servicios: carpetas `root:campusia 0750`, guiones `root:campusia 0750`, unidades `root:root 0644`, `systemctl daemon-reload` y `systemctl enable --now campusia-respaldo.timer`;
  - `$RESPALDOS` queda `campusia:campusia 0700` (ya lo hace);
  - corre dos veces seguidas sin fallar.
- `respaldo/`: los guiones y las unidades pueden ajustarse solo si hace falta para que `systemctl start campusia-respaldo.service` funcione en el servidor (por ejemplo `ReadWritePaths` o lo que necesite `respaldar.sh`); el temporizador sigue en `OnCalendar=*-*-* 04:30:00` (hora local) y la unidad sigue con `User=campusia` y `ExecStart=/srv/campusia/plataforma/despliegue/respaldo/respaldar.sh`.
- `continuo/`: sin cambios salvo que haga falta para que el receptor quede activo como servicio de usuario de `campusia` cuando corre Docker sin root.

## 6. Interfaz

No hay pantallas nuevas. El prototipo `prototipo/campus.html` no cambia.

## 7. Permisos y reglas de seguridad

- El webhook solo llega al receptor desde Cloudflare y por el camino exacto; el receptor sigue exigiendo la firma HMAC con `SECRETO_WEBHOOK`. Un origen que no es Cloudflare no llega a ningún servicio interno aunque mande encabezados de IP de Cloudflare.
- El núcleo (8080) y el receptor (9010) escuchan solo en loopback.
- `campusia` no puede escribir los guiones ni las carpetas de respaldo instaladas, las unidades de respaldo, `/etc/modules-load.d/campusia-docker.conf` ni `/etc/localtime`.
- Los respaldos son de `campusia`, con carpeta 0700 y archivos 0600; ningún otro usuario los lista ni los lee. El servicio de respaldo corre como `campusia`, nunca como root.
- El Docker sin root de `campusia` no lo puede usar otro usuario y no hay Docker del sistema accesible.
- La red de cursos (`campusia-cursos`) es interna (`Internal: true`) y sin comunicación entre contenedores (`enable_icc=false`); la crea el núcleo al arrancar y la vuelve a crear si falta.

## 8. Cómo se compila, se levanta y se prueba

No hay compilación propia. El binario y la interfaz se compilan con la etapa por defecto `desplegar.sh --etapa compilar` (lo hacen las pruebas). Producción: igual que en el contrato de cierre (`infraestructura/levantar.sh`).

Pruebas, desde cero y sin pasos manuales (varias horas con las anteriores; conviene en segundo plano):

```
bash pruebas/tramo-infraestructura-final/correr.sh
```

1. Corre `pruebas/tramo-infraestructura-cierre/correr.sh` (que a su vez corre `pruebas/tramo-infraestructura/correr.sh` y las suites `pruebas/fase-*/correr.sh`, y prepara OpenTofu, Ansible y pytest en `pruebas/tramo-infraestructura/.herramientas/`). `SOLO_FINAL=1` lo omite.
2. Corre `pytest` en `pruebas/tramo-infraestructura-final/` (los argumentos se pasan a este pytest).
3. Imprime los totales de las anteriores y de este tramo y el total combinado como `aceptación: X/Y` y `ataque: A/B`. Sale distinto de 0 si algo falla.

Requisitos de la máquina: Docker que permita `--privileged` y montar `/lib/modules`, el módulo `br_netfilter` disponible en el kernel del anfitrión, `openssl`, red para bajar paquetes de Debian y Docker y las imágenes `caddy:2.8.4` y `node:22-alpine`.

| Archivo | Qué levanta | Aceptación | Ataque |
|---|---|---|---|
| `test_caddy.py` | `caddy:2.8.4` con `despliegue/Caddyfile` tal cual y un certificado de prueba, dos servicios falsos en `127.0.0.1:8080` (núcleo) y `127.0.0.1:9010` (receptor) en el mismo espacio de red, un cliente en una red Docker `173.245.63.0/24` (rango de Cloudflare) y otro en una red común | `handle /_despliegue/webhook` presente y hacia 9010, archivo válido y formateado, el webhook desde Cloudflare llega al receptor con el cuerpo entero, otros métodos también, el resto de las rutas y subdominios siguen yendo al núcleo con la IP real | rutas parecidas no llegan al receptor, orígenes que no son Cloudflare se cortan (con o sin encabezados de IP falsos, apex o subdominio), cada petición llega una sola vez |
| `test_instalar_respaldo.py` | `instalar.sh --raiz <tmp> --sin-servicios` con un binario falso | corre dos veces, copia exacta de guiones y unidades, unidad apuntando al guion instalado, `respaldos` 0700 | no escribe a través de enlaces (archivo o carpeta), no deja otros ejecutables |
| `test_preparar_docker.py` | contenedor Debian 13 mínimo `--privileged` con `/lib/modules`, corre `preparar-docker.sh` | `br_netfilter` cargado y persistido, Docker sin root que crea redes internas | sin Docker del sistema, `campusia` no cambia el archivo de módulos |
| `test_servidor.py` | VPS Debian 13 con systemd `--privileged` (con `FINAL_DISTROS=debian13,ubuntu2404` también Ubuntu 24.04) y `levantar.sh` completo dos veces, como en el cierre, con `servidor_docker_sin_root_en_prueba: true` | levantar termina, segunda corrida `changed=0`, `br_netfilter`, Docker sin root activo, el núcleo arranca, crea `campusia-cursos` y la vuelve a crear al reiniciar, zona horaria, guiones y unidades de respaldo, temporizador habilitado con próximo disparo `04:30:00 -03`, carpeta de respaldos, `campusia-respaldo.service` produce un respaldo válido, receptor activo, webhook firmado por Caddy desde una IP de Cloudflare (alias en `lo`) responde `pong`, el núcleo y la interfaz siguen servidos | firma falsa o ausente 401, webhook desde `127.0.0.1` o con IP de Cloudflare falsificada cortado, rutas parecidas no llegan al receptor, `campusia` no puede cambiar respaldo, módulos ni zona, respaldos solo de `campusia`, Docker de `campusia` inaccesible a otros, red de cursos interna, 8080 y 9010 solo en loopback |

`CONSERVAR_CONTENEDORES=1` deja los contenedores para inspeccionarlos.

## Cambios en pruebas

- 2026-11-10: `pruebas/tramo-infraestructura-cierre/conftest.py::levantar_contenedor` ahora levanta los VPS de prueba con `--privileged` y `-v /lib/modules:/lib/modules:ro`, y `pruebas/tramo-infraestructura-cierre/test_levantar.py` agrega `servidor_docker_sin_root_en_prueba: true` a las variables extra. Motivo: desde la unión de la fase 4, `despliegue/campusia-nucleo.service` fija `PROVEEDOR_CONTENEDORES=docker` y el núcleo no arranca sin el Docker sin root de `campusia`, así que sin estos cambios `levantar.sh` no podía terminar el paso `desplegar` en esas pruebas. Ninguna aserción cambia.
- 2026-11-10: `pruebas/tramo-infraestructura-final/test_caddy.py` y `test_servidor.py` calculan las IPs de Cloudflare que usan (`IP_CADDY_CF`, `IP_CLIENTE_CF`, `IP_CF_FALSA`, `IP_CF_LOCAL`) a partir de los rangos publicados (`173.245.63.0/24`, `173.245.48.0/20`) con `ipaddress` en lugar de escribirlas sueltas. Los valores son los mismos (`.2`, `.10`, `.1`, `.77`). Motivo: el contrato exige usar IPs de Cloudflare y `test_datos_reales.py::test_sin_ip_publica_real_en_archivos_versionables` rechaza cualquier IP pública suelta en archivos versionables; los rangos en notación de red sí están permitidos. Ninguna aserción cambia.
- 2026-11-10: `pruebas/tramo-infraestructura-cierre/conftest.py::ip_publica_no_documentada` deja pasar las direcciones sueltas de los resolvedores públicos `1.1.1.1`, `1.0.0.1`, `8.8.8.8` y `8.8.4.4`. Motivo: la unión de `main` trajo `pruebas/fase-2/ataque/contenedor.spec.ts`, que las usa a propósito como destinos externos para comprobar que los contenedores de cursos no tienen salida a internet; esa carpeta no es de este tramo. Ninguna de esas direcciones puede ser la IP del servidor, así que el escáner sigue detectando cualquier otra IP pública (la prueba del propio escáner no cambia).
- 2026-11-10: `pruebas/tramo-plantilla-sdk/repo.test.mjs` ("el tramo no toca carpetas de otros tramos") agrega `infraestructura` a las carpetas permitidas en la raíz. Motivo: este tramo y los anteriores de infraestructura fijan `infraestructura/` como módulo del repo, y la prueba lista las carpetas del disco, así que fallaba en esta rama aunque nada de `tramo-plantilla-sdk` cambie. Además `correr.sh` de `tramo-infraestructura-final` y de `tramo-infraestructura-cierre` exportan `ANSIBLE_HOME` dentro de `pruebas/tramo-infraestructura/.herramientas/` para que Ansible no deje una carpeta `.ansible/` en la raíz del árbol, e `infraestructura/servidor/.ansible-lint` (perfil `moderate`, `offline`) hace que `ansible-lint` tome `infraestructura/servidor/` como raíz del proyecto y guarde ahí su caché `.ansible/` (ignorada por git) en lugar de la raíz del repo.
- 2026-11-10: `pruebas/tramo-infraestructura/test_secretos.py::test_nada_secreto_versionado` exceptúa por ruta exacta `pruebas/tramo-experimento-intermediario/ataque/01-credenciales.test.mjs` y `02-rutas-y-arranque.test.mjs`. Motivo: llegaron con la unión de `main` y usan a propósito tokens de Anthropic inventados (`sk-ant-api03-ATACANTE-000…`, `sk-ant-api03-xxxx…`) como credenciales de un atacante; no son secretos y esa carpeta no es de este tramo. El resto del repo se sigue revisando con los mismos patrones.
