# Contrato: tramo experimento del intermediario del modelo

_Creado: 2026-11-10. Alcance: `/home/n/projects/campusia/.orquestacion/tramo-experimento-intermediario.md`._

## Pregunta que responde

¿Puede Claude Code, corriendo dentro de un contenedor, usar la suscripción del equipo a través de un intermediario en el anfitrión que guarda el token real, sin que el contenedor vea nunca ese token?

El tramo no toca `nucleo/`, `interfaz/`, `plantilla-curso/`, `sdk/` ni `despliegue/`. Todo el código del experimento vive en `pruebas/experimento-intermediario/`, y las pruebas en `pruebas/tramo-experimento-intermediario/`. El intermediario se escribe en Rust (axum o hyper, con reqwest o hyper-util, TLS con rustls) para que su código se pueda llevar después al núcleo como `ProveedorDeModelo`.

## Estructura

| Ruta | Contenido | Módulo |
|---|---|---|
| `pruebas/experimento-intermediario/intermediario/` | Crate de Rust `intermediario-experimento` (binario del mismo nombre) y su `.gitignore` con `target/` | intermediario |
| `pruebas/experimento-intermediario/contenedor/` | `Dockerfile` de la imagen con Node 22 y Claude Code; `plan-b.sh` solo si el plan A no funciona | contenedor |
| `pruebas/experimento-intermediario/RESULTADO.md` | Resultado del experimento con evidencia | contenedor |
| `pruebas/tramo-experimento-intermediario/` | Pruebas de aceptación y de ataque, `correr.sh` | contrato (fijo) |

## Interfaz HTTP del intermediario

No es la API de la plataforma: es el servicio que escucha en el anfitrión y que solo usan los contenedores de los cursos. No hay pantallas del prototipo involucradas en este tramo.

### Credencial de curso

Cada curso tiene un token propio con la forma `curso-[A-Za-z0-9_-]{16,}`. El contenedor lo manda de una de estas dos formas, nunca las dos a la vez:

- `Authorization: Bearer <token de curso>` (lo que manda Claude Code con `ANTHROPIC_AUTH_TOKEN`).
- `x-api-key: <token de curso>` (lo que manda Claude Code con `ANTHROPIC_API_KEY`).

Reglas de validación:
- Comparación exacta y en tiempo constante contra los tokens de `INTERMEDIARIO_CURSOS`. Prefijos, sufijos, otro uso de mayúsculas, `Basic`, el valor sin `Bearer ` o el propio token real se rechazan.
- Si llegan `Authorization` y `x-api-key` juntos, se rechaza aunque uno sea válido.
- El curso se determina solo por el token. Ningún encabezado del cliente (`x-curso`, `x-campus-curso`, etc.) cambia el curso al que se atribuye el uso.

### Rutas

| Método | Ruta | Quién | Cuerpo | Respuesta |
|---|---|---|---|---|
| GET | `/salud` | Cualquiera, sin credencial | — | `200 {"estado":"ok"}`. No se reenvía ni se registra |
| GET, POST | `/v1/<resto>` | Contenedor con token de curso válido | El del cliente, sin cambios, byte a byte | La del destino: mismo estado, mismos encabezados (salvo los de salto y `content-length` si se reescribe el cuerpo), mismo cuerpo, en streaming |

Se reenvía a `INTERMEDIARIO_DESTINO` + ruta + consulta tal como llegaron (por ejemplo `POST /v1/messages?beta=true`, `POST /v1/messages/count_tokens`, `GET /v1/models?limit=5`).

Orden de las comprobaciones y errores (el cuerpo de error usa el formato de Anthropic, `{"type":"error","error":{"type":"...","message":"..."}}`, con mensajes en castellano):

1. Credencial ausente, desconocida, doble o mal formada: `401`, `error.type = "authentication_error"`. No se reenvía.
2. Ruta que no empieza con `/v1/`, o que contiene `..`, `//`, `\`, `%2e`, `%2f` o `%5c` (en cualquier combinación de mayúsculas): `404` (`not_found_error`) o `400` (`invalid_request_error`). No se reenvía. Esto deja afuera, entre otras, `/api/oauth/*`, `/api/organizations` y `/`.
3. Método distinto de `GET` o `POST` sobre `/v1/`: `405` (`invalid_request_error`). No se reenvía.
4. Cuerpo de más de 32 MiB: `413`. No se reenvía.
5. Destino inalcanzable o error de TLS: `502` (`api_error`).

Las peticiones en forma absoluta (`POST http://otro-host/v1/messages`) y cualquier `Host` del cliente se ignoran: el destino es siempre `INTERMEDIARIO_DESTINO`.

### Encabezados hacia el destino

- Se quitan: `authorization`, `x-api-key`, `cookie`, `host`, los de salto (`connection`, `keep-alive`, `proxy-*`, `te`, `trailer`, `transfer-encoding`, `upgrade`) y cualquier encabezado de curso del cliente.
- Se agrega exactamente un `authorization: Bearer <token real>`.
- `anthropic-beta`: se conservan los valores del cliente y se agrega `INTERMEDIARIO_BETA` (por defecto `oauth-2025-04-20`) si no está, sin duplicarlo.
- Se conservan sin cambios `anthropic-version`, `user-agent`, `x-app`, `content-type`, `accept` y los `x-stainless-*`.
- `host` es el del destino.

### Respuesta hacia el contenedor

- Streaming real: cada trozo del destino se manda apenas llega (Server-Sent Events de `/v1/messages` con `"stream": true`). No se acumula la respuesta.
- Cualquier aparición del token real en encabezados o en el cuerpo de la respuesta se reemplaza por `[token-oculto]`, incluso cuando el token llega partido entre dos trozos del stream (se retiene una ventana de `largo del token - 1` bytes). Cuando hay que reescribir, se quita `content-length`.
- Los errores propios del intermediario nunca incluyen el token real ni el de curso.

## Registro de uso

`INTERMEDIARIO_REGISTRO` es un archivo JSON Lines al que se agrega una línea por petición (salvo `/salud`), escrita cuando la respuesta terminó de enviarse:

```json
{"momento":"2026-11-10T05:00:00.123Z","curso":"experimento","metodo":"POST","ruta":"/v1/messages","estado":200,"reenviada":true,"modelo":"claude-haiku-4-5-20251001","tokens_entrada":12,"tokens_salida":3,"tokens_cache_creacion":0,"tokens_cache_lectura":15000}
```

| Campo | Contenido |
|---|---|
| `momento` | ISO 8601 en UTC |
| `curso` | Id del curso del token, o `null` si la credencial no fue válida |
| `metodo`, `ruta` | Método y ruta sin la consulta |
| `estado` | Estado devuelto al contenedor |
| `reenviada` | `true` si se mandó al destino |
| `modelo` | `message.model` de la respuesta; si no viene, `model` del cuerpo pedido; si no, `null` |
| `tokens_*` | De `usage` en respuestas JSON; en SSE, de `message_start.message.usage` y del último `message_delta.usage`. `0` si no hay |

Ni el registro ni la salida estándar o de errores del intermediario contienen el token real, los tokens de curso ni los encabezados de las peticiones.

## Variables de entorno del intermediario

| Variable | Obligatoria | Por defecto | Contenido |
|---|---|---|---|
| `INTERMEDIARIO_DIRECCION` | No | `127.0.0.1:8790` | Dirección de escucha. Las pruebas usan `127.0.0.1:<puerto>` y, para los contenedores, `0.0.0.0:<puerto>` |
| `INTERMEDIARIO_DESTINO` | No | `https://api.anthropic.com` | Base del destino. Las pruebas usan un destino falso en `http://127.0.0.1:<puerto>` |
| `INTERMEDIARIO_TOKEN_ARCHIVO` | Sí | — | Archivo con el token real. Se recorta el espacio en blanco |
| `INTERMEDIARIO_CURSOS` | Sí | — | Archivo con una línea por curso: `<id> <token>`, separados por un espacio. Id con `[a-z0-9][a-z0-9-]{0,62}` |
| `INTERMEDIARIO_REGISTRO` | Sí | — | Archivo JSON Lines del registro de uso |
| `INTERMEDIARIO_BETA` | No | `oauth-2025-04-20` | Valor que se agrega a `anthropic-beta`. Sirve para probar variantes |

El intermediario no arranca (termina con código distinto de 0 antes de escuchar) si:
- falta el archivo del token real, está vacío, o tiene permisos para el grupo u otros (cualquier bit de `0o077`);
- falta el archivo de cursos, alguna línea no cumple el formato, un token no cumple `curso-[A-Za-z0-9_-]{16,}`, dos cursos comparten token, o un token de curso es igual al token real;
- `INTERMEDIARIO_REGISTRO` no está definida o está vacía.

## Contenedor

Imagen `campusia-experimento-claude:prueba` construida desde `pruebas/experimento-intermediario/contenedor/Dockerfile`:
- Base Node 22 (`node:22-slim` o `node:22-bookworm-slim`), `git` instalado, Claude Code con versión fija (`npm i -g @anthropic-ai/claude-code@<versión>`).
- `ENV DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`, `DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- Sin ninguna credencial: ni `CLAUDE_CODE_OAUTH_TOKEN`, ni `ANTHROPIC_API_KEY`, ni `~/.claude/.credentials.json`, ni nada con `sk-ant-`.
- Funciona con cualquier uid: las pruebas corren `--user <uid>:<gid>` con `HOME=/tmp`.

Las pruebas lo corren así (no hace falta otro script):

```
docker run --add-host=host.docker.internal:host-gateway --user <uid>:<gid> -e HOME=/tmp \
  -e ANTHROPIC_BASE_URL=http://host.docker.internal:<puerto> -e ANTHROPIC_AUTH_TOKEN=<token de curso> \
  [-v <repo>:/repo -w /repo] campusia-experimento-claude:prueba \
  claude -p "Respondé solo: ok" --model haiku
```

y para la edición: `claude -p "En el archivo saludo.txt reemplazá la palabra hola por chau. No hagas nada más." --model haiku --permission-mode acceptEdits --allowedTools Read,Edit,Write`.

## Reglas de permisos

| Actor | Puede | No puede |
|---|---|---|
| Contenedor de un curso | Llamar a `/v1/*` con `GET` o `POST` usando su token de curso; `/salud` | Ver el token real; usar otra ruta, otro método u otro destino; atribuir uso a otro curso; pasar su propia credencial de Anthropic |
| Intermediario | Leer el token real y el archivo de cursos en el anfitrión | Escribir el token en registros, respuestas o archivos |
| Repo | — | Contener el token real en ningún archivo versionable |

## Token real

- Está en `/home/n/.config/campusia/claude-oauth-token` (permisos `600`). Solo lo lee el intermediario en el anfitrión, por `INTERMEDIARIO_TOKEN_ARCHIVO`. Las pruebas lo leen solo para buscarlo (sin imprimirlo) en la imagen, los contenedores, sus salidas, el registro y el repo. Se puede cambiar la ruta con `CAMPUSIA_TOKEN_ARCHIVO`.
- Nunca se copia al repo, a la imagen, a un contenedor, a un argumento de línea de comandos ni a un registro.
- Las pruebas con destino falso usan un token real falso generado en cada corrida (`sk-ant-oat01-PRUEBA-...`), así que no gastan uso ni exponen nada.

## Plan B

Si con el plan A Claude Code no logra respuestas `200` por ninguna variante razonable (`anthropic-beta` distintos con `INTERMEDIARIO_BETA`, `ANTHROPIC_AUTH_TOKEN` versus `ANTHROPIC_API_KEY`, rutas que Claude Code consulte al arrancar y que aparezcan rechazadas en el registro), el módulo contenedor:
- documenta en `RESULTADO.md` exactamente qué respondió el destino en cada variante (estado, `error.type`, mensaje, encabezados relevantes, sin el token);
- deja `pruebas/experimento-intermediario/contenedor/plan-b.sh`, que corre el contenedor con `CLAUDE_CODE_OAUTH_TOKEN` leído del archivo en el momento (pasado con `--env-file` desde un archivo temporal `600` que se borra al terminar) y la red limitada a `api.anthropic.com` y `registry.npmjs.org` (por ejemplo, red interna de Docker con un proxy de salida con lista permitida). `plan-b.sh` no forma parte de `correr.sh` y no se ejecuta en las pruebas.

En ese caso las pruebas de aceptación de Claude real quedan fallando, y esa falla es la evidencia.

## Resultado

`pruebas/experimento-intermediario/RESULTADO.md` (lo escribe el módulo contenedor después de correr el experimento) con estas secciones, sin el token ni fragmentos de él:

- `## Qué funcionó`: plan A o plan B, con qué variables de entorno de Claude Code y qué versión.
- `## Encabezados y rutas`: encabezados que exige el acceso por suscripción (`authorization: Bearer`, `anthropic-beta: oauth-2025-04-20`) y rutas que usó Claude Code (del registro), incluidas las rechazadas.
- `## Uso registrado`: consultas, modelos y tokens de las dos corridas (lo que imprime la prueba de consumo en `uso.json`).
- `## Variantes probadas`: cada variante y su resultado.
- `## Recomendación para la fase 3`: cómo llevar el intermediario al núcleo (`ProveedorDeModelo`, token por curso, límites, registro) y qué cambiar para la clave de API de producción.

## Pruebas

`pruebas/tramo-experimento-intermediario/`, con el corredor de Node (`node --test`), sin dependencias externas:

| Archivo | Tipo | Qué comprueba |
|---|---|---|
| `aceptacion/01-reenvio.test.mjs` | Aceptación | `/salud`; reemplazo de credencial por `Bearer` y por `x-api-key`; `anthropic-beta`; cuerpo, ruta y consulta intactos; streaming sin acumular; estados de error del destino; `/v1/models`; `count_tokens`; `Host` |
| `aceptacion/02-registro-uso.test.mjs` | Aceptación | Línea de registro por petición con tokens de JSON y de SSE, errores del destino, campos del contrato |
| `aceptacion/03-claude-real.test.mjs` | Aceptación | Imagen con Node 22 y Claude Code; `claude -p "Respondé solo: ok" --model haiku` contra la API real a través del intermediario; edición de `saludo.txt` en un repo montado; consumo acotado (entre 2 y 20 consultas a `/v1/messages`, todas con un modelo haiku, a lo sumo 5000 tokens de salida) |
| `aceptacion/04-resultado.test.mjs` | Aceptación | `RESULTADO.md` con sus secciones |
| `ataque/01-credenciales.test.mjs` | Ataque | Sin credencial, inventada, variantes de una válida, el token real como credencial, claves ajenas, dos credenciales, cookies, curso falsificado por encabezado, token real reflejado por el destino (entero y partido en un stream), tokens en el registro y en la salida |
| `ataque/02-rutas-y-arranque.test.mjs` | Ataque | Rutas fuera de `/v1/`, recorridos de ruta codificados, URL absoluta y `Host` hacia otro servidor, métodos `DELETE`/`PUT`/`PATCH`, registro de rechazos, destino caído; no arranca con configuración insegura |
| `ataque/03-token-real-fuera-del-contenedor.test.mjs` | Ataque | El token real no está en `docker inspect` de la imagen ni de los contenedores, ni en las capas (`docker save`), ni en el sistema de archivos después de correr (`docker export`), ni en su salida, ni en el registro, ni en archivos versionables del repo; con un token de curso inventado Claude Code falla y nada se reenvía |

Las pruebas de `ataque/03` revisan los contenedores que deja `aceptacion/03`; por eso se corren juntas con `correr.sh`, que además borra esos contenedores al terminar.

Para depurar las pruebas con otro binario se puede definir `EXPERIMENTO_BINARIO=<ruta>`; en ese caso no se compila el crate.

## Cómo se compila, se levanta y se prueba

Compilar:

```
. "$HOME/.cargo/env"
cargo build --release --manifest-path pruebas/experimento-intermediario/intermediario/Cargo.toml
docker build -t campusia-experimento-claude:prueba pruebas/experimento-intermediario/contenedor
```

Levantar a mano:

```
INTERMEDIARIO_DIRECCION=0.0.0.0:8790 \
INTERMEDIARIO_TOKEN_ARCHIVO=$HOME/.config/campusia/claude-oauth-token \
INTERMEDIARIO_CURSOS=/ruta/a/cursos \
INTERMEDIARIO_REGISTRO=/ruta/a/registro.jsonl \
pruebas/experimento-intermediario/intermediario/target/release/intermediario-experimento
```

Probar todo desde cero (compila, construye la imagen, levanta destinos falsos e intermediarios en puertos libres, corre las dos consultas reales y limpia):

```
bash pruebas/tramo-experimento-intermediario/correr.sh
```

El comando corre también los `pruebas/*/correr.sh` de fases anteriores si existen. Requiere `cargo`, `node` 22, `docker` sin sudo y el archivo del token de desarrollo. Gasta dos corridas cortas de Claude Code con haiku; una tercera, con un token de curso inventado, no llega al destino.
