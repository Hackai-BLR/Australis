# Contrato del tramo M1: Australis en el servidor

_Creado: 2026-11-13. Rama `feat/m1-deploy-australis`. Alcance: tarea M1 de la fase 0 de `docs/plan.md`. Continúa `contratos/tramo-infraestructura.md`, `tramo-infraestructura-cierre.md`, `tramo-infraestructura-final.md` y `tramo-resguardo.md`: todo lo que fijan sigue vigente salvo lo que este documento cambia._

Australis (`backend/` y `frontend/`) pasa a instalarse en el mismo servidor que el núcleo, como un segundo servicio de systemd. Este tramo no cambia cómo llega el tráfico: Caddy sigue mandando todo al núcleo en `127.0.0.1:8080`. Que el núcleo reenvíe una dirección reservada al puerto de Australis es la tarea M2 de la fase 0.

Solo se tocan estas carpetas:

| Ruta | Módulo |
|---|---|
| `despliegue/` (`instalar.sh`, `campusia-australis.service`, `australis.env.ejemplo`, `continuo/`, `respaldo/`) | despliegue |
| `infraestructura/servidor/roles/campusia/` | servidor |
| `pruebas/tramo-infraestructura-australis/`, `pruebas/tramo-infraestructura-cierre/` | pruebas |
| `contratos/tramo-australis.md`, `handoffs/` | contrato |

## 1. Rutas HTTP

Ninguna ruta nueva en el núcleo. Australis escucha solo en la interfaz local:

| Dirección | Quién la llama | Comportamiento |
|---|---|---|
| `http://127.0.0.1:8090/api/health` | el despliegue continuo y `instalar.sh` | 200 cuando Australis arrancó, migró su base y puede responder. Es la comprobación de salud de Australis |
| `http://127.0.0.1:8090/api/*` | el núcleo (tarea M2) | la API de Australis. Nada de afuera llega a este puerto: escucha en `127.0.0.1` y el firewall no lo abre |

El puerto 8090 no choca con 8080 (núcleo), 8081 (API de cursos), 8082 (espacios), 8083 (proxy de salida) ni 9010 (receptor del despliegue).

## 2. Modelo de datos y archivos en el servidor

No hay migraciones del núcleo. La base de Australis se migra sola al arrancar (`sqlx::migrate!` dentro de `australis-server`).

| Ruta | Dueño y permisos | Contenido | Lo crea |
|---|---|---|---|
| `/usr/local/bin/australis-server` | `root:root 0755` | binario de `backend/` compilado en release | `instalar.sh` |
| `/srv/campusia/australis/` | `campusia:campusia 0750` | carpeta de Australis | `instalar.sh` |
| `/srv/campusia/australis/datos/australis.db` | `campusia:campusia`, la carpeta `0750` | base SQLite de Australis. Archivo distinto de `datos/campusia.db` | `australis-server` al arrancar |
| `/srv/campusia/australis/archivos/` | `campusia:campusia 0700` | subidas (`UPLOAD_DIR`) | `instalar.sh` |
| `/srv/campusia/australis/frontend/` | `root:root`, `go=rX` | `frontend/dist` compilado. Se reemplaza entero en cada instalación | `instalar.sh` |
| `/srv/campusia/config/australis.env` | `campusia:campusia 0600` | entorno de Australis, generado a partir de `despliegue/australis.env.ejemplo` | rol `campusia` de Ansible |
| `/etc/systemd/system/campusia-australis.service` | `root:root 0644` | copia exacta de `despliegue/campusia-australis.service` | `instalar.sh` |

`australis.env.ejemplo` no tiene secretos. Fija `COOKIE_SECURE=true`, `APP_BASE_URL=https://campusia.tech`, `AI_PROVIDER=placeholder` y `ZOOM_PROVIDER=placeholder`. `DATABASE_URL`, `BIND_ADDR` y `UPLOAD_DIR` los fija la unidad y no pueden estar en el archivo (un `EnvironmentFile` pisa a `Environment=`): el rol de Ansible lo rechaza.

## 3. Unidad `campusia-australis.service`

- Corre `/usr/local/bin/australis-server` como `campusia`, con `Restart=on-failure`.
- `BIND_ADDR=127.0.0.1:8090`, `DATABASE_URL=sqlite:///srv/campusia/australis/datos/australis.db`, `UPLOAD_DIR=/srv/campusia/australis/archivos`.
- Endurecimiento como el del núcleo: `ProtectSystem=strict`, `ReadWritePaths=/srv/campusia/australis`, `PrivateTmp`, `NoNewPrivileges`, `MemoryMax=768M`.

## 4. Despliegue continuo

`despliegue/continuo/desplegar.sh`, con los scripts por defecto:

- **Pruebas.** Con red se hace `cargo fetch --locked` de `backend/` y `npm ci` de `frontend/`. Sin red: `cargo test --offline --locked` de `backend/`, y en `frontend/` `npm run lint`, `npm run build` y `npm test`. Si falla cualquiera, el commit queda `fallo-pruebas` y no se instala.
- **Compilación.** `cargo build --release --bin australis-server` (con su propio `target`, `CARGO_TARGET_DIR_AUSTRALIS`, para no mezclarlo con el del núcleo) deja `compilado/bin/australis-server`, y `npm run build` deja `frontend/dist/index.html`.
- **Imagen de compilación.** `despliegue/continuo/imagen/Dockerfile` pasa de `rust:1.88.0` a `rust:1.100.0`: las dependencias bloqueadas de `backend/` (por ejemplo `aes 0.9.4`) piden Rust 1.89 o más. El núcleo compila igual con la imagen nueva.
- **Instalación.** `campusia-instalar` (root) extrae `compilado/bin/australis-server` y `frontend/dist` de las fuentes como `campusia`, rechaza enlaces simbólicos y archivos especiales, y llama a `instalar.sh` con `--australis-binario` y `--australis-frontend`. Un commit sin esos artefactos se instala como antes, sin tocar Australis.
- **Salud.** La comprobación por defecto pide `/salud` del núcleo y, si las fuentes de ese commit tienen `compilado/bin/australis-server`, también `/api/health` de Australis. Si cualquiera falla, se reinstala el commit anterior, que reinstala el núcleo y Australis juntos, y se registra `revertido`.
- **Copia previa.** Antes de instalar se copia la base de Australis a `despliegue/previos/<commit>-australis.db`, junto a la del núcleo. La reversión no restaura datos: es la misma política que ya tenía el núcleo.

`instalar.sh` acepta `--australis-binario <ruta>` y `--australis-frontend <carpeta>`, siempre juntos. Con servicios, exige `/srv/campusia/config/australis.env`, habilita y reinicia los dos servicios y espera la salud de cada uno (hasta 120 s). Sin las opciones no toca nada de Australis.

## 5. Respaldo

- `respaldar.sh` agrega al `respaldo.tar.gz` la entrada `australis/` con `australis.db` (copia consistente con `.backup`) y `archivos/`, si `datos/australis.db` existe. Entra al manifiesto de sumas. Sin Australis instalado el respaldo sale como antes.
- `restaurar.sh` valida `australis/australis.db` con `PRAGMA integrity_check` (un respaldo con la base dañada o sin ella se rechaza con código 3), restaura en `australis/datos` y `australis/archivos` (o bajo `--destino`), y en el modo sin `--destino` detiene y vuelve a arrancar `campusia-australis.service` además de `campusia.service`. Lo anterior queda en `previo-<fecha>/australis/`.
- `campusia-respaldo.service` puede escribir en `/srv/campusia/australis`.
- `litestream.yml` replica las dos bases al mismo bucket, cada una a su prefijo (`plataforma` y `australis`).

## 6. Ansible

El rol `campusia` arma `australis.env` desde `despliegue/australis.env.ejemplo` más `campusia_australis_env_extra`, verifica que no queden valores `completar`, saltos de línea ni `DATABASE_URL`, `BIND_ADDR` o `UPLOAD_DIR`, lo escribe con dueño `campusia` y modo `0600`, y verifica dueño y modo. No hay secretos nuevos en el Vault. El resto (Caddy, firewall, Docker, usuario) no cambia: el puerto 8090 no se abre.

## 7. Pruebas

`pruebas/tramo-infraestructura-australis/` (`correr.sh`), sin contenedores de systemd:

| Archivo | Tipo | Qué cubre |
|---|---|---|
| `test_instalar_australis.py` | aceptación y ataque | instala el binario y el frontend, dos veces, conserva base y subidas, reemplaza el frontend viejo, sin opciones no instala nada, rechaza opciones a medias, frontend sin `index.html` o binario inexistente |
| `test_unidad_y_configuracion.py` | aceptación y ataque | puerto local propio, rutas bajo `/srv/campusia`, endurecimiento, entorno que no pisa la unidad ni lleva secretos, Litestream con las dos bases, tareas de Ansible, el script de despliegue lleva las etapas de Australis |
| `test_desplegar_australis.py` | aceptación | despliegue sano comprueba las dos salud, salud de Australis o del núcleo rota o instalación fallida revierten los dos, pruebas rotas no instalan, commit sin Australis no pide su salud, copia previa de su base |
| `test_respaldo_australis.py` | aceptación y ataque | el respaldo incluye base y subidas, manifiesto, restaurar a una carpeta y en su lugar (con `systemctl` falso), rechazo de bases dañadas o ausentes |

`pruebas/tramo-infraestructura-cierre/test_compilacion.py` suma dos pruebas: la compilación real por defecto deja un ELF `australis-server` y un `frontend/dist/index.html` sin enlaces.

## 8. Fuera de alcance

- Que el núcleo reenvíe tráfico a Australis y le pase la identidad firmada (M2).
- Ejecutar cualquier despliegue contra el servidor real o Cloudflare.
- La imagen del espacio de trabajo, Caddy y el firewall.
