# Contrato de la fase 3: agente, versión de prueba, publicar y versiones

_Escrito: 2026-11-10. Referencias: `CONVENCIONES.md`, `handoffs/261110_0400_plan-implementacion-plataforma.md`, `contratos/fase-1.md`, `contratos/fase-2.md`, `contratos/identidad-cursos.md`, `contratos/tramo-plantilla-sdk.md`, `contratos/tramo-experimento-intermediario.md`, `pruebas/experimento-intermediario/RESULTADO.md`, `.orquestacion/fase-3.md` y `prototipo/campus.html`._

Este contrato es la fuente de verdad para implementar la fase 3. Las pruebas de `pruebas/fase-3/` lo verifican. Si algo de acá no coincide con una prueba, manda la prueba y se avisa en el handoff. Las pruebas no se cambian para que pasen. Todo lo de `contratos/fase-1.md` y `contratos/fase-2.md` sigue vigente salvo lo que este contrato cambia explícitamente.

La fase 4 corre al mismo tiempo en otra rama sobre el mismo Docker. Las migraciones de esta fase usan el prefijo 3xxx, el código nuevo va en módulos propios y los archivos compartidos (`nucleo/src/servidor.rs`, `nucleo/src/main.rs`, `nucleo/src/config.rs`, `interfaz/src/App.tsx`, `despliegue/instalar.sh`) se tocan lo mínimo: agregar rutas, variables y opciones, sin reordenar ni reescribir lo existente.

## 1. Módulos y carpetas

| Módulo | Carpetas | Qué entrega |
|---|---|---|
| Núcleo | `nucleo/` | Intermediario del modelo (`ProveedorDeModelo` con `suscripcion` y `api`), medición de uso y límite, escucha de espacios, proxy de salida, espacio de trabajo por curso (contenedor, copia del repo, inactividad), agente (ejecución, transmisión, conversación, commits en `prueba`), enrutador `-prueba`, publicar con verificación aislada, versiones y volver, migración `3001` |
| Interfaz | `interfaz/` | Modos Publicado y Prueba con el borde ámbar, panel Editar con el chat en vivo, botón Publicar, panel Versiones con "Volver a esta", errores de publicación y de límite |
| Espacio de trabajo, plantilla y despliegue | `despliegue/` (incluida la carpeta nueva `despliegue/espacio-trabajo/`), `plantilla-curso/`, `sdk/` | Imagen del espacio de trabajo (Node 22, pnpm, git, Claude Code con versión fija, hooks, `campusia-espacio`, `campusia-agente`), script `dev` de la plantilla, `despliegue/construir-espacio.sh`, unidad de systemd, ejemplo de entorno e `instalar.sh --espacio` |

Cada módulo toca solo sus carpetas. Nadie toca `pruebas/`, `contratos/`, `prototipo/`, `handoffs/` ni `.orquestacion/`, ni crea carpetas nuevas en la raíz del repo (`pruebas/tramo-plantilla-sdk/repo.test.mjs` las rechaza): la imagen del espacio vive en `despliegue/espacio-trabajo/`. Los módulos se comunican solo por lo que fija este contrato: el núcleo usa la imagen del espacio a través de la sección 9 y la interfaz usa la API de la sección 6.

## 2. Compilar, levantar y probar

### Compilar

```bash
. "$HOME/.cargo/env"
cargo build --manifest-path nucleo/Cargo.toml
pnpm --dir interfaz install && pnpm --dir interfaz run build
pnpm --dir sdk install && pnpm --dir sdk run build
rm -f plantilla-curso/vendor/campusia-sdk-*.tgz && pnpm --dir sdk pack --pack-destination plantilla-curso/vendor
bash despliegue/construir-espacio.sh --etiqueta campusia-espacio:1
```

`construir-espacio.sh` construye la imagen del espacio de trabajo sin sudo (Docker del usuario o Podman sin root) y necesita red para bajar Node, Claude Code y las dependencias.

### Levantar en desarrollo

```bash
export DATABASE_URL=sqlite:///tmp/campusia.db DOMINIO_BASE=campusia.prueba ENTORNO=desarrollo \
  PROVEEDOR_EMAIL=archivo ARCHIVO_EMAIL=/tmp/mails.jsonl SESSION_SECRET=$(openssl rand -hex 32) \
  TURNSTILE_SITE_KEY=1x00000000000000000000AA TURNSTILE_SECRET=1x0000000000000000000000000000000AA \
  INTERFAZ_DIR=$PWD/interfaz/dist EMAIL_FROM=no-responder@campusia.prueba \
  PROVEEDOR_CONTENEDORES=docker RAIZ_CURSOS=/tmp/campusia-cursos PLANTILLA_CURSO_DIR=$PWD/plantilla-curso SDK_DIR=$PWD/sdk \
  RAIZ_ESPACIOS=/tmp/campusia-espacios ESPACIO_IMAGEN=campusia-espacio:1 PROVEEDOR_MODELO=suscripcion MODELO_AGENTE=haiku
export CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.config/campusia/claude-oauth-token)"
nucleo/target/debug/campusia-nucleo migrar
nucleo/target/debug/campusia-nucleo sembrar pruebas/fase-2/datos.json
nucleo/target/debug/campusia-nucleo crear-owner equipo@campusia.prueba
nucleo/target/debug/campusia-nucleo
```

El token real solo lo lee el núcleo de su entorno. Nunca se escribe en el repo, en un contenedor, en un argumento de línea de comandos de un contenedor ni en un registro.

### Probar

```bash
bash pruebas/fase-3/correr.sh
```

Corre, en este orden y desde cero, sin pasos manuales:

1. `pruebas/tramo-plantilla-sdk/correr.sh`.
2. `pruebas/tramo-resguardo/correr.sh`.
3. Las pruebas del tramo del experimento del intermediario (`pruebas/tramo-experimento-intermediario/`, con `node --test`; las corre directamente, sin su `correr.sh`, que a su vez recorre todos los `correr.sh`). Gastan dos consultas cortas reales con haiku y necesitan el token de desarrollo. `SIN_EXPERIMENTO=1` las saltea.
4. `pruebas/correr.sh` (Playwright): compila el núcleo y la interfaz y corre `pruebas/fase-1/`, `pruebas/fase-2/` y `pruebas/fase-3/`. La primera prueba de la fase 3 de cada corrida construye la imagen del espacio con `despliegue/construir-espacio.sh --etiqueta cia3espacio:<corrida>` (una sola vez por corrida, con un candado entre workers) y la borra al terminar.

Sigue aunque una parte falle y termina con código distinto de 0 si alguna falló. Con argumentos (`bash pruebas/fase-3/correr.sh fase-3/ataque`) o con `SOLO_PLAYWRIGHT=1` corre solo Playwright con esos argumentos. `CAMPUSIA_SIN_COMPILAR=1` y `PRUEBAS_WORKERS` funcionan como antes.

Las pruebas automáticas usan un **modelo falso** (`pruebas/fase-3/lib/modelo-falso.ts`): un servidor local compatible con la API de mensajes de Anthropic (incluido el streaming SSE y `tool_use`) que sigue guiones. El agente es Claude Code de verdad, dentro del espacio de trabajo de verdad, con sus hooks; solo el destino del intermediario (`MODELO_DESTINO`) es falso. Cada guion se elige con una marca `[guion:<nombre>]` dentro del pedido del profesor. Así se prueba todo de punta a punta sin gastar uso y con resultados repetibles. El modelo falso exige la credencial real falsa de la corrida (`sk-ant-oat01-PRUEBA-...` generada en cada núcleo) y `oauth-2025-04-20` en `anthropic-beta`, como la API real.

La prueba con el modelo real es `pruebas/fase-3/real/modelo-real.spec.ts`. Se saltea salvo con `CAMPUSIA_MODELO_REAL=1` y se corre con:

```bash
bash pruebas/fase-3/manual/modelo-real.sh
```

Usa el token de `~/.config/campusia/claude-oauth-token` (otra ruta con `CAMPUSIA_TOKEN_ARCHIVO`), pide un cambio real con haiku, lo ve en prueba, lo publica y lo ve publicado. Antes de cerrar la fase hay que correrla al menos una vez con éxito y dejar el resultado (fecha, duración y consumo, sin el token) en el handoff.

Requisitos de la máquina: los de la fase 2, más red hacia `registry.npmjs.org` (las dependencias del espacio y de la verificación pasan por el proxy de salida) y hacia los registros de imágenes y npm para construir la imagen del espacio.

## 3. Variables de entorno nuevas

| Variable | Por defecto | Uso |
|---|---|---|
| `PROVEEDOR_MODELO` | `ninguno` | `suscripcion`, `api` o `ninguno`. `ninguno`: el agente y el intermediario no funcionan (`503 servicio_no_disponible`), publicar y versiones sí. Otro valor: el núcleo no arranca. El valor `proveedor_modelo` de `configuracion` (panel del owner) se sigue guardando y mostrando, pero no cambia el proveedor en uso |
| `CLAUDE_CODE_OAUTH_TOKEN` | vacío | Token de suscripción. Obligatorio con `suscripcion`; si falta o está vacío el núcleo no arranca |
| `ANTHROPIC_API_KEY` | vacío | Clave de API. Obligatoria con `api`; si falta o está vacía el núcleo no arranca |
| `MODELO_DESTINO` | `https://api.anthropic.com` | Base a la que reenvía el intermediario. Las pruebas usan el modelo falso |
| `MODELO_BETA` | `oauth-2025-04-20` | Valor que se agrega a `anthropic-beta` con `suscripcion` |
| `MODELO_AGENTE` | `sonnet` | Modelo con el que corre Claude Code (`--model`). Las pruebas usan `haiku` |
| `PRECIOS_MODELO_ARCHIVO` | vacío | Tabla de precios en JSON (sección 7). Vacío: la tabla incluida en el núcleo. Si el archivo no existe o no es válido, el núcleo no arranca |
| `ESPACIO_IMAGEN` | `campusia-espacio:1` | Imagen del espacio de trabajo y de la verificación al publicar |
| `RAIZ_ESPACIOS` | `/srv/campusia/espacios` | Una carpeta por curso con la copia de trabajo, su git y los datos de prueba |
| `RED_ESPACIOS` | `<PREFIJO>-espacios` | Red de los espacios de trabajo |
| `PUERTO_ESPACIOS` | `8082` | Puerto de la escucha de espacios (intermediario y API para cursos) |
| `DIRECCION_ESPACIOS` | la puerta de enlace de `RED_ESPACIOS` | Dirección de esa escucha y del proxy de salida |
| `URL_ESPACIOS` | `http://<DIRECCION_ESPACIOS>:<PUERTO_ESPACIOS>` | Base que reciben los espacios |
| `PUERTO_PROXY_SALIDA` | `8083` | Puerto del proxy de salida |
| `SALIDA_PERMITIDA` | `registry.npmjs.org` | Hosts, separados por coma, a los que el proxy deja conectar (solo `CONNECT <host>:443`) |
| `ESPACIO_MEMORIA` | `2g` | Límite de memoria del espacio y de la verificación |
| `ESPACIO_CPUS` | `1` | Límite de CPU |
| `ESPACIO_PIDS` | `1024` | Límite de procesos |
| `INACTIVIDAD_ESPACIO_SEG` | `1800` | Un espacio sin peticiones a `-prueba` ni ejecuciones del agente durante ese tiempo se detiene |
| `ARRANQUE_ESPACIO_SEG` | `900` | Cuánto puede tardar un espacio en responder `/salud` al encenderse (incluye instalar dependencias) |
| `ESPERA_PRUEBA_SEG` | `20` | Cuánto espera una petición a `-prueba` a que el espacio responda antes de devolver `503` |
| `AGENTE_MAX_SEG` | `900` | Tiempo máximo de una ejecución del agente |
| `PUBLICACION_MAX_SEG` | `1800` | Tiempo máximo de cada etapa de la verificación al publicar |

Con `PROVEEDOR_CONTENEDORES=docker`, si al arrancar no se puede preparar `RED_ESPACIOS` o abrir la escucha de espacios o el proxy de salida, el núcleo sale con código distinto de 0 y un mensaje claro. Ningún mensaje de error, registro ni respuesta incluye `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` ni los tokens de espacio.

## 4. Repos, ramas y carpetas

- `RAIZ_CURSOS/<id>` sigue siendo el repo del curso y la fuente de verdad: rama `main` (lo publicado), rama `prueba` (lo que hizo el agente) y etiquetas anotadas `v1`, `v2`, ... Su árbol de trabajo queda siempre en `main` sin cambios pendientes (salvo `datos/`).
- `RAIZ_ESPACIOS/<id>/` tiene la copia de trabajo del espacio: una carpeta con los archivos de la rama `prueba` que se monta en `/repo`, **sin `.git` adentro** (los metadatos de git quedan fuera del montaje), y la carpeta de datos de la versión de prueba que se monta en `/datos` (separada de `RAIZ_CURSOS/<id>/datos`, que es la del curso publicado). El núcleo puede guardar ahí otras cosas que no se montan.
- Después de cada ejecución del agente el núcleo hace un commit en `prueba` con los cambios de la copia de trabajo (si los hay). Antes del commit descarta los cambios en las rutas protegidas: `vendor/`, `Containerfile`, `.containerignore`, `.dockerignore`, `.gitignore`, `CLAUDE.md`, `.claude/` y cualquier ruta con un componente `.git`. Los archivos ignorados por el `.gitignore` de la plantilla (`node_modules`, `dist`, ...) no entran.
- El núcleo ejecuta git sobre la copia sin hooks ni configuración que venga de la copia (por ejemplo `git -c core.hooksPath=/dev/null --git-dir=<fuera del montaje> --work-tree=<copia>`). Nada que escriba el agente se ejecuta en el anfitrión.
- `prueba` siempre sale de `main`: después de publicar o de volver a una versión, `prueba` queda igual a `main` y la copia de trabajo se actualiza.
- Hay "cambios sin publicar" cuando `prueba` tiene commits que no están en `main`.

## 5. Modelo de datos

Migración nueva `nucleo/migraciones/3001_agente.sql`. Las anteriores no se modifican. Las columnas marcadas con * las leen o escriben las pruebas.

```sql
espacios(curso_id* TEXT PK REFERENCES cursos, nombre TEXT NOT NULL,
         estado* TEXT NOT NULL CHECK (estado IN ('apagado','encendiendo','encendido','error')),
         token_modelo_huella TEXT NOT NULL UNIQUE, token_curso_huella TEXT NOT NULL UNIQUE,
         ultima_actividad TEXT NULL, error TEXT NULL, creado_en TEXT NOT NULL, actualizado_en TEXT NOT NULL)

mensajes_agente(id* INTEGER PK, curso_id* TEXT NOT NULL REFERENCES cursos, rol* TEXT NOT NULL CHECK (rol IN ('profesor','agente')),
                autor_id INTEGER NULL REFERENCES usuarios, texto* TEXT NOT NULL, archivos TEXT NOT NULL DEFAULT '[]',
                estado* TEXT NOT NULL CHECK (estado IN ('en_curso','ok','error')), commit_prueba TEXT NULL,
                creado_en TEXT NOT NULL, terminado_en TEXT NULL)

uso_modelo(id* INTEGER PK, curso_id* TEXT NOT NULL, universidad_id* INTEGER NOT NULL, mes* TEXT NOT NULL, fecha TEXT NOT NULL,
           ruta TEXT NOT NULL, estado* INTEGER NOT NULL, modelo* TEXT NULL,
           tokens_entrada* INTEGER NOT NULL, tokens_salida* INTEGER NOT NULL,
           tokens_cache_creacion* INTEGER NOT NULL, tokens_cache_lectura* INTEGER NOT NULL, usd* REAL NOT NULL)

publicaciones(id* INTEGER PK, curso_id* TEXT NOT NULL REFERENCES cursos, tipo* TEXT NOT NULL CHECK (tipo IN ('publicar','volver')),
              estado* TEXT NOT NULL CHECK (estado IN ('en_curso','ok','error')), etapa* TEXT NOT NULL,
              version* INTEGER NULL, desde_version INTEGER NULL, commit_candidato TEXT NULL, descripcion TEXT NOT NULL,
              error TEXT NULL, registro TEXT NOT NULL DEFAULT '', autor_id INTEGER NULL,
              creada_en TEXT NOT NULL, terminada_en TEXT NULL)

versiones(curso_id* TEXT NOT NULL REFERENCES cursos, numero* INTEGER NOT NULL, commit_main* TEXT NOT NULL,
          descripcion* TEXT NOT NULL, autor_id INTEGER NULL, origen* INTEGER NULL, imagen TEXT NULL, fecha TEXT NOT NULL,
          PRIMARY KEY (curso_id, numero))
```

- Los tokens de espacio (`cmt_` para el modelo y `cct_` para la API de cursos) nunca se guardan en claro: solo su huella HMAC-SHA256 con `SESSION_SECRET`. Se generan de nuevo cada vez que se crea el contenedor del espacio; los anteriores dejan de servir.
- `uso_modelo` tiene una fila por petición reenviada al destino (aunque el destino responda error). Las peticiones rechazadas por el intermediario no agregan filas.
- `uso_agente(curso_id, mes)` de la fase 1 se sigue usando como total del mes: cada fila de `uso_modelo` suma su `usd` al `uso_agente` de su curso y su mes (`AAAA-MM`, UTC). Así el panel de administrador y el de owner muestran el uso real sin cambios.
- `cursos.version_publicada` es el número de la última versión publicada (o `null`).

## 6. Rutas de la API

Las reglas generales de las fases anteriores siguen: JSON, errores `{"error","mensaje"}`, `Cache-Control: no-store`, control de `Origin` y `X-Campusia: 1` en las modificaciones con cookie, y el orden de los controles. "Docente" es dueño o profesor del curso. Quien no está inscripto en el curso (aunque sea administrador u owner) o pide un curso que no existe recibe `404 no_encontrado`; un alumno del curso recibe `403 prohibido`. Con token: las lecturas piden `cursos:leer` y las modificaciones `cursos:escribir` (si falta: `403 permiso_del_token`).

Orden de los controles en las rutas de esta sección: host, origen, autenticación, permiso del token, curso e inscripción (`404`), rol (`403`), validación del cuerpo (`400`), proveedor disponible (`503 servicio_no_disponible`), estado del curso (`409 curso_no_listo` si `estado` no es `listo`), conflictos (`409`), límite de uso (`429`).

Códigos de error nuevos: `409 curso_no_listo`, `409 agente_ocupado`, `409 publicacion_en_curso`, `409 sin_cambios`, `409 es_la_publicada`, `429 limite_uso`. Se reusan `400 datos_invalidos`, `404 no_encontrado`, `403 prohibido` y `503 servicio_no_disponible`.

| Método y ruta | Quién | Token | Cuerpo | Respuesta |
|---|---|---|---|---|
| `GET /api/cursos/{id}` | inscripto | `cursos:leer` | | `200 Curso` con dos campos nuevos (abajo) |
| `GET /api/cursos/{id}/espacio` | docente | `cursos:leer` | | `200 {"espacio","error"}` |
| `POST /api/cursos/{id}/espacio` | docente | `cursos:escribir` | `{}` | `202 {"espacio","error"}`. Enciende el espacio (lo crea si no existe) y responde sin esperar. Idempotente |
| `GET /api/cursos/{id}/agente` | docente | `cursos:leer` | | `200 {"mensajes":[Mensaje],"en_curso": bool}`, del más viejo al más nuevo |
| `POST /api/cursos/{id}/agente` | docente | `cursos:escribir` | `{"pedido"}` | `200 text/event-stream` (abajo) |
| `GET /api/cursos/{id}/versiones` | docente | `cursos:leer` | | `200 {"publicada","cambios_sin_publicar","versiones":[Version]}`, de la más nueva a la más vieja |
| `POST /api/cursos/{id}/publicar` | docente | `cursos:escribir` | `{"descripcion"?}` | `202 Publicacion` |
| `POST /api/cursos/{id}/versiones/{n}/volver` | docente | `cursos:escribir` | `{}` | `202 Publicacion` |
| `GET /api/cursos/{id}/publicaciones` | docente | `cursos:leer` | | `200 {"publicaciones":[Publicacion]}`, las 20 más nuevas |
| `GET /api/cursos/{id}/publicaciones/{pid}` | docente | `cursos:leer` | | `200 Publicacion` |
| `GET /api/cursos/{id}/uso` | docente | `cursos:leer` | | `200 Uso` |

Formatos:

- `Curso` agrega `"espacio": "ninguno"|"apagado"|"encendiendo"|"encendido"|"error"` y `"cambios_sin_publicar": bool`.
- `Mensaje`: `{"id","rol":"profesor"|"agente","texto","autor":{"id","nombre","email"}|null,"archivos":[{"ruta","cambio":"agregado"|"modificado"|"borrado"}],"estado":"en_curso"|"ok"|"error","fecha"}`. `autor` es quien escribió el pedido (en los mensajes del agente, `null`). `archivos` son los archivos que entraron en el commit de `prueba` de esa ejecución, con rutas relativas a la raíz del repo y ordenados por ruta (un renombre son un `borrado` y un `agregado`); en los mensajes del profesor es `[]`.
- `Version`: `{"numero","fecha","descripcion","autor":{"id","nombre"}|null,"commit","origen": n|null}`. `origen` es la versión a la que se volvió (o `null`).
- `Publicacion`: `{"id","tipo":"publicar"|"volver","estado":"en_curso"|"ok"|"error","etapa","version": N|null,"desde_version": n|null,"descripcion","error": texto|null,"registro": texto,"autor":{"id","nombre"}|null,"creada","terminada": fecha|null}`. `etapa` es una de `preparando`, `dependencias`, `pruebas`, `tipos`, `compilacion`, `imagen`, `arranque`, `cambio`, `listo`; con `estado: "error"` es la etapa que falló; con `"ok"` es `listo`. `registro` son las últimas líneas (hasta 20 000 caracteres) de la salida de la verificación, sin secretos. `version` es el número nuevo cuando terminó bien.
- `Uso`: `{"mes":"AAAA-MM","usd","consultas","tokens_entrada","tokens_salida","tokens_cache_creacion","tokens_cache_lectura","usd_universidad","limite_usd"}` del mes actual. `usd` es el `uso_agente` del curso en el mes; `consultas` y los tokens son la cantidad de filas y las sumas de `uso_modelo` del curso en el mes; `usd_universidad` suma `uso_agente` de todos los cursos de la universidad del curso; `limite_usd` es el de la universidad.

### Espacio de trabajo

`espacio` vale `ninguno` si nunca se creó, y si no el estado del contenedor. `POST /api/cursos/{id}/espacio`, una petición a `-prueba` o un pedido al agente lo encienden: crean la copia de trabajo si falta, crean el contenedor si falta (sección 9) y lo arrancan. Queda `encendido` cuando `/salud` del espacio responde 200 (hasta `ARRANQUE_ESPACIO_SEG`; si no, `error` con el motivo en `error`). Nunca se arranca dos veces a la vez.

### Agente

`POST /api/cursos/{id}/agente`:
- `pedido`: de 1 a 8000 caracteres sin contar los espacios de los bordes. Si no: `400 datos_invalidos`.
- `503 servicio_no_disponible` con `PROVEEDOR_MODELO=ninguno` o `PROVEEDOR_CONTENEDORES=ninguno`. Encender el espacio, publicar y volver responden `503 servicio_no_disponible` solo con `PROVEEDOR_CONTENEDORES=ninguno`. Las lecturas (`GET`) de esta sección funcionan siempre: sin espacio, `espacio` es `ninguno`.
- `409 agente_ocupado` si ya hay una ejecución en curso en ese curso; `409 publicacion_en_curso` si hay una publicación en curso.
- `429 limite_uso` (mensaje "Se alcanzó el límite mensual de uso del agente de la universidad.") si la universidad del curso ya llegó a su límite (sección 7). No se guarda ningún mensaje ni se ejecuta nada.
- Si pasa los controles, guarda el mensaje del profesor y el del agente (`en_curso`), audita `agente_pedido` y responde `200` con `Content-Type: text/event-stream`. Eventos, en este orden:
  - `event: inicio` con `{"pedido": Mensaje, "respuesta": Mensaje}`.
  - Cero o más `event: texto` con `{"texto"}`: el texto del agente a medida que llega.
  - Cero o más `event: herramienta` con `{"nombre","ruta"}` (`ruta` relativa al repo o `null`) cuando el agente usa una herramienta.
  - `event: fin` con `{"respuesta": Mensaje}` (estado `ok` o `error`, con `archivos`). Después se cierra el stream.
  - Se pueden mandar comentarios SSE (`: ...`) para mantener viva la conexión.
- La ejecución: enciende el espacio si hace falta, corre el agente (sección 9) con el pedido tal cual (puede ir con contexto, pero el texto del profesor llega entero), y al terminar hace el commit en `prueba` (sección 4). El texto final del mensaje del agente es el resultado de Claude Code. Si Claude Code termina con error, supera `AGENTE_MAX_SEG` o el intermediario cortó por el límite, el mensaje queda `error` con un texto claro (con el límite, el de `429 limite_uso`), y los cambios que haya dejado igual se guardan en `prueba`.
- Si el cliente cierra la conexión, la ejecución sigue y el resultado queda guardado.
- El agente mantiene el contexto de la conversación del curso mientras el espacio sigue encendido (por ejemplo con `--continue`). La conversación (`mensajes_agente`) se guarda por curso y la ven todos sus docentes.

### Publicar

`POST /api/cursos/{id}/publicar`:
- `descripcion`: opcional, hasta 200 caracteres. Si falta o está vacía, la descripción son los pedidos al agente desde la última versión unidos con `"; "` (recortada a 200), o `"Publicación"` si no hay.
- `409 sin_cambios` si `prueba` no tiene commits que no estén en `main`. `409 publicacion_en_curso` y `409 agente_ocupado` como arriba. Cualquier otro campo del cuerpo (por ejemplo `version`) se ignora.
- Responde `202 Publicacion` (`en_curso`) y sigue en segundo plano con el commit candidato `C` = la punta de `prueba` en ese momento:
  1. `preparando`: `git archive C` a una carpeta temporal.
  2. `dependencias`: `pnpm install --frozen-lockfile` en un contenedor de `ESPACIO_IMAGEN` con salida solo por el proxy de salida.
  3. `pruebas`: `pnpm test`; `tipos`: `pnpm exec tsc --noEmit -p tsconfig.json`; `compilacion`: `pnpm build`. Las tres en un contenedor de `ESPACIO_IMAGEN` **sin red** (`--network none`), sin privilegios ni capacidades, con `no-new-privileges`, con los límites del espacio, como usuario sin privilegios y sin ninguna variable con secretos (ni tokens de curso, ni del modelo, ni `SESSION_SECRET`, ni `DOCKER_HOST`, ni `HTTP_PROXY`/`HTTPS_PROXY`). Cada etapa tiene hasta `PUBLICACION_MAX_SEG`.
  4. `imagen`: construye `<PREFIJO>-curso-<id>:<12 caracteres de C>` desde `git archive C`, como en la fase 2.
  5. `arranque`: crea un contenedor nuevo con esa imagen y las mismas reglas de la fase 2 (con un token de curso nuevo) y espera que `/salud` responda 200 (hasta `ARRANQUE_CURSO_SEG`).
  6. `cambio`: pasa el tráfico al contenedor nuevo, que queda con el nombre `<PREFIJO>-curso-<id>`, y borra el anterior.
  7. Recién entonces: etiqueta anotada `vN` sobre `C` (N = la última versión + 1, empezando en 1, con la descripción como mensaje), `main` pasa a `C`, `prueba` queda en `C`, `version_publicada = N`, fila en `versiones`, auditoría `publicacion`, y `estado: "ok"`, `etapa: "listo"`, `version: N`.
- Si cualquier etapa falla: `estado: "error"` con `etapa`, `error` y `registro`; auditoría `publicacion_fallida`. No se crea la etiqueta, `main`, `prueba`, `version_publicada` y las versiones no cambian, y el tráfico sigue en el contenedor anterior, que no se toca (mismo contenedor, sin reinicio). Lo que se haya creado para la publicación se borra.
- Una sola publicación (o vuelta) por curso a la vez, y nunca mientras corre el agente.

`POST /api/cursos/{id}/versiones/{n}/volver`:
- `404 no_encontrado` si el curso no tiene la versión `n`; `409 es_la_publicada` si `n` es la publicada; `409 publicacion_en_curso` y `409 agente_ocupado` como arriba.
- Crea sobre `main` un commit con el mismo árbol que `vn` y sigue los mismos pasos que publicar con ese commit como candidato. Si termina bien: versión nueva `vN` con `origen: n` y descripción `"Vuelta a la v<n>"`, `main` y `prueba` quedan en ese commit (los cambios sin publicar de `prueba` se descartan) y la copia de trabajo del espacio se actualiza. Auditoría `version_restaurada`. Si falla, nada cambia.

Los datos del curso publicado (`RAIZ_CURSOS/<id>/datos`) siguen entre versiones.

### Uso

`GET /api/cursos/{id}/uso` según el formato `Uso`. `GET /api/admin/cursos` (`uso_usd_mes`) y `GET /api/owner/uso` (`agente_usd_mes`) reflejan el uso medido porque leen `uso_agente`.

## 7. Intermediario del modelo

Se sirve solo en la **escucha de espacios** (`DIRECCION_ESPACIOS:PUERTO_ESPACIOS`, accesible desde `RED_ESPACIOS`, nunca expuesta por Caddy). En la escucha principal y en la de la API para cursos, `/modelo/*` responde 404.

| Método y ruta | Quién | Respuesta |
|---|---|---|
| `POST /modelo/v1/messages` (con o sin consulta, por ejemplo `?beta=true`) | espacio con su token de modelo | la del destino, en streaming |
| `POST /modelo/v1/messages/count_tokens` | espacio con su token de modelo | la del destino |
| `GET /salud` | cualquiera | `200 {"ok":true}` |

La escucha de espacios también sirve `GET /api/curso/yo` y `GET /api/curso/inscriptos` con el token de curso del espacio (`CAMPUSIA_TOKEN_CURSO`), con los formatos de la fase 2, para que la versión de prueba funcione igual que la publicada. Cualquier otra ruta: 404.

Credencial: `Authorization: Bearer cmt_<43 caracteres base64url>` (lo que manda Claude Code con `ANTHROPIC_AUTH_TOKEN`) o `x-api-key: cmt_...`, nunca las dos. Comparación por huella y en tiempo constante. El curso sale solo del token: ningún encabezado del cliente cambia a qué curso se atribuye el uso.

Orden de los controles; los errores usan el formato de Anthropic `{"type":"error","error":{"type","message"}}` con mensajes en castellano y nunca se reenvían:

1. Credencial ausente, doble, mal formada, de otro tipo (token de curso `cct_`, token personal `cia_`, cookie de sesión) o de un espacio anterior: `401 authentication_error`.
2. Ruta fuera de la lista (incluidas `/modelo/v1/models`, `/modelo/api/oauth/...`, `/modelo/v1/messages/../..` y las variantes codificadas con `%2e`, `%2f`, `%5c`): `404 not_found_error` (o `400 invalid_request_error`).
3. Método distinto de `POST`: `405 invalid_request_error`.
4. Cuerpo de más de 32 MiB: `413`.
5. La universidad del curso llegó a su límite: `429 rate_limit_error` con el mensaje "Se alcanzó el límite mensual de uso del agente de la universidad." y el encabezado `x-should-retry: false` (para que Claude Code no reintente).
6. Destino inalcanzable: `502 api_error`.

Reenvío (contrato `ProveedorDeModelo`):
- Destino: `MODELO_DESTINO` + la ruta sin `/modelo` + la consulta tal cual (`POST /modelo/v1/messages?beta=true` va a `POST <destino>/v1/messages?beta=true`). El `Host` y cualquier URL absoluta del cliente se ignoran.
- Se quitan `authorization`, `x-api-key`, `cookie`, `host`, los encabezados de salto a salto y cualquier `x-campus-*`. Se conservan `anthropic-version`, `anthropic-beta`, `content-type`, `accept`, `user-agent`, `x-app` y los `x-stainless-*`.
- `suscripcion`: agrega exactamente un `authorization: Bearer <CLAUDE_CODE_OAUTH_TOKEN>` y agrega `MODELO_BETA` a `anthropic-beta` (sin duplicarlo, conservando los valores del cliente).
- `api`: agrega exactamente un `x-api-key: <ANTHROPIC_API_KEY>`, sin `authorization` y sin agregar `oauth-2025-04-20`.
- El cuerpo va sin cambios. La respuesta vuelve con el mismo estado, encabezados (salvo los de salto a salto) y cuerpo, en streaming real (cada trozo se manda apenas llega). Cualquier aparición del token real en encabezados o cuerpo de la respuesta se reemplaza por `[token-oculto]`, también cuando llega partido entre trozos.

Medición:
- De cada respuesta se toman `model` y `usage` (en JSON, `usage`; en SSE, `message_start.message.usage` y el último `message_delta.usage`): `input_tokens`, `output_tokens`, `cache_creation_input_tokens` y `cache_read_input_tokens` (0 si faltan). Se guarda una fila en `uso_modelo` cuando la respuesta terminó y se suma a `uso_agente`.
- `usd = (entrada × p.entrada + salida × p.salida + cache_creacion × p.cache_creacion + cache_lectura × p.cache_lectura) / 1 000 000`, con `p` el precio del modelo en USD por millón de tokens.
- Tabla de precios (`PRECIOS_MODELO_ARCHIVO` o la incluida): un objeto JSON `{"<modelo>": {"entrada","salida","cache_creacion","cache_lectura"}, ..., "*": {...}}`. Se usa la clave igual al modelo; si no hay, la clave más larga que sea prefijo del modelo; si no, `"*"`. La tabla incluida tiene precios para las familias haiku, sonnet y opus y una entrada `"*"`.
- Límite: antes de reenviar, si la suma de `uso_agente.usd` del mes de todos los cursos de la universidad es mayor o igual a `universidades.limite_usd`, se corta con el `429` de arriba. Una petición ya reenviada termina aunque supere el límite.
- Ni el registro del núcleo ni la base guardan encabezados, cuerpos ni tokens.

## 8. Proxy de salida

En `DIRECCION_ESPACIOS:PUERTO_PROXY_SALIDA`, accesible solo desde `RED_ESPACIOS`. Solo acepta `CONNECT <host>:443` con `host` en `SALIDA_PERMITIDA` (comparación exacta, sin mayúsculas): responde `200` y une las conexiones. Cualquier otro `CONNECT` (otro host, otro puerto, una IP) responde `403` y cualquier otra petición (por ejemplo `GET http://...`) responde `403` o `405`, sin conectarse a ningún lado.

## 9. Espacio de trabajo

### Contenedor

`<PREFIJO>-espacio-<id>`, con las etiquetas `campusia.prefijo=<PREFIJO>`, `campusia.curso=<id>` y `campusia.tipo=espacio`, de la imagen `ESPACIO_IMAGEN`:

- `--network RED_ESPACIOS`: red `--internal` y con `com.docker.network.bridge.enable_icc=false` (los espacios no se ven entre sí ni ven a los cursos publicados). Sin puertos publicados, sin `--privileged`, sin `--network host`, sin el socket de Docker.
- `--read-only --cap-drop ALL --security-opt no-new-privileges --memory ESPACIO_MEMORIA --cpus ESPACIO_CPUS --pids-limit ESPACIO_PIDS`, como usuario sin privilegios.
- Montajes: la copia de trabajo en `/repo` (lectura y escritura, sin `.git`), los datos de prueba en `/datos` y un `tmpfs` en `/tmp`; el `HOME` del usuario puede ser un `tmpfs` o una carpeta de `RAIZ_ESPACIOS/<id>`. Nada más del anfitrión: ni `RAIZ_CURSOS`, ni otros espacios, ni la base.
- Variables de la plataforma, exactamente: `PORT=3000`, `CAMPUSIA_CURSO=<id>`, `CAMPUSIA_CLAVE_PUBLICA`, `CAMPUSIA_API=URL_ESPACIOS`, `CAMPUSIA_TOKEN_CURSO=cct_<43>` (propio del espacio), `CAMPUSIA_DATOS=/datos`, `ANTHROPIC_BASE_URL=URL_ESPACIOS/modelo`, `ANTHROPIC_AUTH_TOKEN=cmt_<43>`, `HTTP_PROXY` y `HTTPS_PROXY` (y sus versiones en minúscula si se quiere) con `http://<DIRECCION_ESPACIOS>:<PUERTO_PROXY_SALIDA>`, y `NO_PROXY` con `DIRECCION_ESPACIOS`. Ninguna con secretos de la plataforma: ni `CLAUDE_CODE_OAUTH_TOKEN`, ni `ANTHROPIC_API_KEY`, ni `SESSION_SECRET`, ni `IDENTIDAD_CLAVE_PRIVADA`, ni `DOCKER_HOST`.
- El núcleo le habla al espacio por su dirección en `RED_ESPACIOS`, puerto 3000. El espacio solo llega a la escucha de espacios y al proxy de salida.
- El núcleo tiene que poder leer y escribir lo que el agente deja en `/repo` (con Docker sin root, cuidando el mapeo de usuarios).
- Inactividad: cada `REVISION_INACTIVIDAD_SEG`, los espacios encendidos sin peticiones a `-prueba` ni ejecuciones del agente durante `INACTIVIDAD_ESPACIO_SEG` se detienen (`stop`) y pasan a `apagado`. Un espacio con una ejecución del agente en curso nunca se detiene. Si el contenedor desaparece se crea de nuevo (con tokens nuevos).

### Imagen (`despliegue/espacio-trabajo/`)

La construye `despliegue/construir-espacio.sh [--etiqueta <imagen>] [--cli docker|podman]` (por defecto `campusia-espacio:1` y `docker`), sin sudo. Contiene:

- Node 22, `pnpm@12.18.0` (el `packageManager` de la plantilla), `git`, `python3`, `make` y `g++` (para dependencias nativas como better-sqlite3, que no pueden bajar binarios fuera de npm), y Claude Code instalado con versión exacta (`@anthropic-ai/claude-code@<x.y.z>`) con `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`, `DISABLE_AUTOUPDATER=1` y `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Conviene dejar en la imagen el almacén de pnpm con las dependencias de la plantilla para que el primer arranque no baje todo.
- Ninguna credencial: ni `CLAUDE_CODE_OAUTH_TOKEN`, ni `ANTHROPIC_API_KEY`, ni archivos de credenciales de Claude, ni nada con `sk-ant-`.
- `/etc/claude-code/managed-settings.json` (de root, no escribible por el usuario del contenedor) con los hooks `PreToolUse` y los permisos del agente, y los scripts de los hooks también de root. Los hooks rechazan (con código 2 y un mensaje en castellano):
  - leer, escribir o editar rutas fuera de `/repo` (después de resolver `..` y enlaces);
  - escribir o editar las rutas protegidas de la sección 4;
  - comandos que lean variables de entorno o secretos: `env`, `printenv`, `export -p`, `set` sin argumentos, `/proc/*/environ`, `$ANTHROPIC_*`, `$CAMPUSIA_TOKEN_CURSO`, `$CLAUDE_*`, `process.env` (por ejemplo en `node -e`) y similares;
  - comandos que salgan de `/repo` o toquen git por dentro (`cd` fuera de `/repo`, `git config`, `.git/`), o que intenten usar la red fuera del proxy.
- `campusia-espacio` (comando por defecto): en `/repo` instala las dependencias (`pnpm install --frozen-lockfile`, por el proxy) y corre el curso en modo desarrollo en `PORT` con `pnpm dev`, de forma que los cambios en `servidor/` y `web/` se vean en a lo sumo 60 segundos y que el proceso se recupere solo cuando un cambio lo rompe y otro lo arregla. Responde `/salud` en cuanto el curso arranca.
- `campusia-agente`: el núcleo lo ejecuta como `docker exec -i -w /repo -e CAMPUSIA_MODELO=<MODELO_AGENTE> <espacio> campusia-agente [--continuar]`, con el pedido por la entrada estándar. Corre `claude -p --output-format stream-json --verbose --model "$CAMPUSIA_MODELO"` con `--permission-mode acceptEdits` y las herramientas `Read`, `Edit`, `Write`, `Glob`, `Grep` y `Bash` permitidas sin preguntar (los hooks deciden), con `--continue` cuando se pasa `--continuar`. Por la salida estándar van las líneas JSON de Claude Code tal cual y el código de salida es el de Claude Code.

### Plantilla

`plantilla-curso/package.json` agrega el script `dev`, que sirve el curso en `PORT` con las mismas rutas que la versión compilada (`/salud`, `/api/*`, la interfaz) y se recarga con los cambios. `CLAUDE.md` puede sumar reglas para el agente. Las pruebas de `pruebas/tramo-plantilla-sdk/` siguen en verde.

## 10. Enrutador

| Host | Fase 3 |
|---|---|
| `<id>.DOMINIO_BASE` | barra con el iframe del curso publicado o de la versión de prueba |
| `<id>-curso.DOMINIO_BASE` | igual que en la fase 2 (el contenedor publicado) |
| `<id>-prueba.DOMINIO_BASE` | reenvío al espacio de trabajo del curso (abajo) |

En `<id>-prueba.DOMINIO_BASE`, para todos los métodos y rutas, en este orden:
1. El curso no existe, o tiene `estado = 'sin_repo'` (los sembrados): 404.
2. Sin sesión válida: `401` en HTML, sin el nombre del curso, con el enlace a `<esquema>://<id>.<DOMINIO_BASE>[:puerto]/`.
3. Sesión de alguien que no es docente del curso (alumnos, no inscriptos, administradores, owner): `403` en HTML, sin el nombre del curso.
4. Métodos que no son `GET`, `HEAD` ni `OPTIONS`: el `Origin` tiene que ser exactamente `<esquema>://<id>-prueba.<DOMINIO_BASE>[:puerto]`; si no, `403` y la petición no llega al espacio.
5. Curso `preparando` o `error`: `503` en HTML.
6. Espacio apagado, sin crear o encendiéndose: lo enciende y espera hasta `ESPERA_PRUEBA_SEG`; si no responde, `503` en HTML con el texto "Preparando la versión de prueba" y `Retry-After`.
7. Reenvía como en `-curso` (fase 2, pasos 7 y 8): sin `Cookie`, `Authorization`, `Proxy-Authorization` ni `X-Campus-*` del navegador, con un único `X-Campus-Identidad` recién firmado para esa persona, ese curso y su rol; descarta los `Set-Cookie` y agrega `Content-Security-Policy: frame-ancestors <esquema>://<id>.<DOMINIO_BASE>[:puerto]` y `X-Content-Type-Options: nosniff`.

Cada petición a `-prueba` cuenta como actividad del espacio.

## 11. Interfaz

La interfaz reproduce el prototipo (`prototipo/campus.html`): `ponerModo`, `pintarChat`, `pintarVersiones`, el panel `#p-agente`, el panel `#p-versiones`, el botón `#publicar` y el borde `.lienzo.prueba`. Los selectores nombrados son parte del contrato. Todo lo de esta sección es solo para docentes: los alumnos no ven `[data-modo]`, `[data-panel="p-agente"]`, `[data-panel="p-versiones"]` ni `#publicar` (no están o están ocultos).

**Modos** (prototipo `ponerModo`):
- `[data-modo="publicado"]` y `[data-modo="prueba"]`. El activo tiene la clase `on`; el de prueba además `prueba` cuando está activo.
- En modo prueba, `#lienzo` tiene la clase `prueba` (borde ámbar) y `iframe#curso` apunta a `<esquema>://<id>-prueba.<base>[:puerto]/`; en modo publicado, sin la clase y a `-curso` como en la fase 2. El `sandbox` del iframe es el de la fase 2 en los dos modos.
- Mientras el espacio no está `encendido`, `#curso-cargando` se ve con el texto "Preparando la versión de prueba"; la barra hace `POST /api/cursos/{id}/espacio`, consulta `GET /api/cursos/{id}/espacio` cada pocos segundos y carga el iframe cuando queda encendido.

**Panel Editar** (`#p-agente`, prototipo `pintarChat`; lo abre `[data-panel="p-agente"]`, que además pasa a modo prueba):
- `#chat` muestra la conversación del curso (`GET /api/cursos/{id}/agente`): un `.msg.yo[data-mensaje="<id>"]` por pedido y un `.msg.ag[data-mensaje="<id>"]` por respuesta. Sin mensajes, un `.msg.ag` con "¿Qué querés cambiar del curso?".
- Las respuestas con archivos llevan un `.cambio` con una fila `[data-archivo="<ruta>"]` por archivo: clase `a` y `+` para `agregado`, `m` y `~` para `modificado`, `b` y `-` para `borrado`, seguido de la ruta.
- `#pedido` (textarea, "Pedile un cambio al curso") y `#enviar-pedido`. Al enviar: agrega el `.msg.yo`, un `.msg.ag.en-curso` que se va llenando con los eventos `texto`, deshabilita `#enviar-pedido` hasta el `fin`, y al terminar reemplaza la respuesta (con `.error` si `estado` es `error`), recarga el iframe de prueba y actualiza Publicar y Versiones.
- Si la API responde `429 limite_uso`, `409` o `503`, muestra un `.msg.ag.error` con el mensaje (para el límite, que contenga "límite").

**Publicar** (`#publicar`, prototipo):
- Habilitado solo en modo prueba, con cambios sin publicar y sin una publicación en curso.
- Al tocarlo: `POST /api/cursos/{id}/publicar`, el botón queda deshabilitado con el texto "Publicando…" y la barra consulta la publicación hasta que termina.
- Si sale bien: `#aviso` dice "Publicada la vN", vuelve a modo publicado y recarga el iframe.
- Si falla: `#aviso` dice "No se pudo publicar", se abre `#p-versiones` y `#ver-error` muestra la etapa con su nombre (`pruebas`, `tipos`, `arranque`, ..., se puede capitalizar), el error y el registro (en un `pre`).

**Panel Versiones** (`#p-versiones`, prototipo `pintarVersiones`; lo abre `[data-panel="p-versiones"]`):
- `#ver-lista` con, en este orden: `.ver.pru` ("Prueba", "Cambios sin publicar") si hay cambios; `.ver.pub[data-version="N"]` con "Publicada · vN" para la publicada; y un `.ver[data-version="n"]` por cada versión anterior con "vn", la descripción y la fecha, y `button[data-volver="n"]` ("Volver a esta"). Sin versiones: "Todavía no hay versiones publicadas".
- `[data-volver]` llama a `POST .../versiones/{n}/volver`, espera la publicación y avisa en `#aviso` "Volviste a la vn. Se publicó como vM". Si falla, igual que Publicar.

## 12. Permisos

| Acción | Dueño | Profesor del curso | Alumno del curso | No inscripto (incluye administrador y owner) | Token |
|---|---|---|---|---|---|
| Ver la versión de prueba (`-prueba`) | sí | sí | no (403) | no (403) | no (solo sesión) |
| Encender el espacio | sí | sí | no (403) | no (404) | `cursos:escribir` |
| Ver la conversación con el agente | sí | sí | no (403) | no (404) | `cursos:leer` |
| Pedir cambios al agente | sí | sí | no (403) | no (404) | `cursos:escribir` |
| Ver versiones, publicaciones y uso | sí | sí | no (403) | no (404) | `cursos:leer` |
| Publicar | sí | sí | no (403) | no (404) | `cursos:escribir` |
| Volver a una versión | sí | sí | no (403) | no (404) | `cursos:escribir` |
| Usar el intermediario del modelo | solo el espacio del curso, con su token de modelo | | | | `cmt_` del espacio |

Reglas:
- El token de modelo de un espacio solo sirve en el intermediario y solo para su curso; no sirve en la escucha principal, en la API para cursos ni en `/api/curso/*`. Los tokens de curso (`cct_`), los personales (`cia_`) y las cookies no sirven en el intermediario.
- Quien deja de ser docente del curso pierde el acceso en la petición siguiente.
- Lo que hace la interfaz se puede hacer por la API con los mismos permisos.
- El agente no puede leer otros cursos, el token real, ni salir a internet (salvo npm por el proxy) ni del contenedor.

Auditoría, acciones nuevas: `agente_pedido`, `publicacion`, `publicacion_fallida`, `version_restaurada`. `universidad_id` es la del curso; `detalle` menciona el id del curso, el mail de quien lo hizo y, cuando corresponde, el número de versión. Nunca incluye tokens.

## 13. Pruebas

Todas en `pruebas/fase-3/`, con ayudantes en `pruebas/fase-3/lib/` que reusan `pruebas/comun/` y `pruebas/fase-2/lib/`. Los datos son los de `pruebas/fase-2/datos.json`; el fixture sube el límite de la Universidad Austral a 1000 USD (la semilla ya la deja pasada de su límite de 40) y la Universidad de Prueba queda con el suyo para las pruebas de límite. Cada núcleo usa un prefijo `cia<8 hex>` propio, un `RAIZ_ESPACIOS` temporal, puertos libres para las escuchas, `MODELO_AGENTE=haiku`, una tabla de precios propia y el modelo falso, y al terminar borra todo lo de su prefijo. La imagen del espacio de la corrida (`cia3espacio:<corrida>`) se borra en `pruebas/fase-3/limpieza-global.ts`. Las pruebas nunca corren `docker system prune` ni `docker builder prune` ni borran imágenes que no crearon.

| Archivo | Qué prueba |
|---|---|
| `aceptacion/flujo.spec.ts` | Pedir un cambio al agente con el stream en vivo, verlo en `-prueba` y no en `-curso`, commit en `prueba`, publicar (v1), verlo publicado, segundo cambio (v2), volver a la v1 como v3, etiquetas y ramas, descripciones, conversación compartida entre docentes, auditoría |
| `aceptacion/intermediario.spec.ts` | Reenvío con la credencial de suscripción y el beta, streaming real, `count_tokens`, `x-api-key` del cliente, censura del token real, salud |
| `aceptacion/proveedor-api.spec.ts` | Con `PROVEEDOR_MODELO=api`: `x-api-key` real, sin `authorization` ni el beta de suscripción; el agente funciona |
| `aceptacion/uso.spec.ts` | Uso medido por curso con la tabla de precios, `uso_modelo`, `uso_agente`, `GET .../uso`, paneles de administrador y owner |
| `aceptacion/espacio.spec.ts` | Contenedor del espacio con sus variables, montajes y versión de Claude Code; identidad en `-prueba` para cada docente; datos de prueba separados; inactividad y despertar; una ejecución larga no se corta |
| `aceptacion/interfaz.spec.ts` | Modos con el borde ámbar, chat en vivo con archivos, Publicar, Versiones, Volver, error de publicación, alumnos sin controles |
| `aceptacion/arranque.spec.ts` | Arranque con proveedores mal configurados; `ninguno` responde 503 |
| `ataque/permisos.spec.ts` | Alumnos, profesores de otro curso, administradores, owner, quitados y tokens sin permiso contra todas las rutas y `-prueba`; orígenes falsos; nada se ejecuta |
| `ataque/intermediario.spec.ts` | Tokens de otro tipo, inventados, viejos o dobles; rutas y métodos fuera de la lista; atribución a otro curso; `/modelo` fuera de la escucha de espacios; nada llega al destino |
| `ataque/limite.spec.ts` | Superar el límite mensual corta el agente y el intermediario sin reenviar; subirlo lo habilita |
| `ataque/agente.spec.ts` | El agente intentando leer variables y tokens, salir del repo, leer otro curso, salir a internet, tocar archivos de la plataforma o plantar hooks de git |
| `ataque/espacio.spec.ts` | Contenedor endurecido, red interna, proxy con lista permitida, secretos fuera del espacio, del repo y de la base, enrutador `-prueba` con identidad falsificada y cookies |
| `ataque/publicar.spec.ts` | Una versión que no arranca, con pruebas que fallan o con errores de tipos no se publica y el tráfico sigue en la anterior; verificación sin red ni secretos; publicaciones simultáneas; volver a versiones inexistentes |
| `despliegue/despliegue.spec.ts` | Imagen del espacio sin credenciales y con versión fija, `construir-espacio.sh` sin sudo, ejemplo de entorno, unidad de systemd, `instalar.sh --espacio`, sin tokens en el repo |
| `real/modelo-real.spec.ts` | Con el modelo real (solo con `CAMPUSIA_MODELO_REAL=1`) |

## 14. Despliegue

- `despliegue/construir-espacio.sh` según la sección 9. No usa `sudo`.
- `despliegue/campusia-nucleo.service` agrega `Environment=RAIZ_ESPACIOS=/srv/campusia/espacios`. Sigue cumpliendo todo lo de la fase 2.
- `despliegue/campusia.env.ejemplo` agrega, sin secretos: `PROVEEDOR_MODELO=api`, `ANTHROPIC_API_KEY=completar`, `CLAUDE_CODE_OAUTH_TOKEN=` (vacío o `completar`), `MODELO_AGENTE`, `ESPACIO_IMAGEN=campusia-espacio:1`, `RAIZ_ESPACIOS=/srv/campusia/espacios`, `PUERTO_ESPACIOS=8082`, `PUERTO_PROXY_SALIDA=8083`, `SALIDA_PERMITIDA=registry.npmjs.org`, `INACTIVIDAD_ESPACIO_SEG`, `ESPACIO_MEMORIA`, `ESPACIO_CPUS`, `AGENTE_MAX_SEG` y `PRECIOS_MODELO_ARCHIVO` (puede ir vacío).
- `despliegue/instalar.sh` acepta `--espacio <carpeta>` opcional: copia la carpeta (la de `despliegue/espacio-trabajo/`) a `<raiz>/srv/campusia/plataforma/espacio-trabajo/`, reemplazando la anterior. Siempre crea `<raiz>/srv/campusia/espacios` con modo `0700`. Sin `--espacio` hace lo mismo que en la fase 2 más esa carpeta. Construir la imagen en el servidor es un paso aparte (`construir-espacio.sh`, como el usuario del servicio).

## 15. Fuera de alcance

- Confirmación del profesor para operaciones destructivas del agente, adjuntar archivos al chat y limpieza periódica de imágenes viejas de los cursos.
- Cuotas por minuto o concurrencia por curso en el intermediario (solo el límite mensual de la universidad).
- Archivos, entregas, notas y copias de seguridad de los repos (fase 4).

## Cambios en las pruebas (2026-11-10)

- `pruebas/tramo-resguardo/estatico.sh`, "no toca carpetas fuera del tramo": el control del alcance corre solo en la rama `tramo-resguardo`. Antes corría en cualquier rama que no fuera `main`, y en la rama `fase-3` (y en la de la fase 4) fallaba apenas los módulos tocaban `nucleo/`, `interfaz/` o `despliegue/`, que es justamente lo que les pide este contrato.
- `pruebas/playwright.config.ts`: `globalSetup` y `globalTeardown` pasan a ser listas para sumar `pruebas/fase-3/preparar-global.ts` (fija el identificador de la corrida y el nombre de la imagen del espacio) y `pruebas/fase-3/limpieza-global.ts` (borra esa imagen). Lo de las fases anteriores no cambia.
