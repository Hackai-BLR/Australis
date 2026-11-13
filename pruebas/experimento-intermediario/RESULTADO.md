# Resultado del experimento del intermediario del modelo

_Corrida: 2026-11-10. Claude Code 2.1.322 en `campusia-experimento-claude:prueba` (`node:22-bookworm-slim`, Node v22.23.4). Intermediario `intermediario-experimento` contra `https://api.anthropic.com` con el token de desarrollo leído solo por el intermediario en el anfitrión._

Respuesta a la pregunta del tramo: **sí**. Claude Code, corriendo dentro de un contenedor sin ninguna credencial de Anthropic, usa la suscripción del equipo a través del intermediario del anfitrión, y el token real no aparece en la imagen, en los contenedores, en sus salidas, en el registro ni en el repo.

## Qué funcionó

Funcionó el **plan A** en la primera variante, sin cambios. No hizo falta el plan B, así que no se dejó `contenedor/plan-b.sh`.

Variables de entorno del contenedor:

| Variable | Valor |
|---|---|
| `HOME` | `/tmp` (el contenedor corre con `--user <uid>:<gid>` del anfitrión) |
| `ANTHROPIC_BASE_URL` | `http://host.docker.internal:<puerto>` (con `--add-host=host.docker.internal:host-gateway`) |
| `ANTHROPIC_AUTH_TOKEN` | Token de curso `curso-...` generado en cada corrida |
| `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` (vienen en la imagen) |

Corridas (de `aceptacion/03-claude-real.test.mjs`):

- `claude -p "Respondé solo: ok" --model haiku`: código 0, salida `ok`.
- `claude -p "En el archivo saludo.txt reemplazá la palabra hola por chau. No hagas nada más." --model haiku --permission-mode acceptEdits --allowedTools Read,Edit,Write` sobre un repo de git montado en `/repo`: código 0, `saludo.txt` quedó con `chau`, salida `Listo: en saludo.txt reemplacé "hola" por "chau". No hice nada más.`

El intermediario usó `INTERMEDIARIO_BETA` por defecto (`oauth-2025-04-20`) y `INTERMEDIARIO_DESTINO` por defecto.

Pruebas que pasaron en esa corrida: `aceptacion/03` (4 de 4) y `ataque/03` (8 de 8), incluidas `docker inspect`, `docker save` de la imagen, `docker export` de los dos contenedores, `docker logs`, el registro, la salida del intermediario y los archivos versionables del repo. Con un token de curso inventado Claude Code no obtiene respuesta, el intermediario registra `401` y no reenvía nada.

## Encabezados y rutas

Lo que exige el acceso por suscripción en `api.anthropic.com`, y que agrega el intermediario:

- `authorization: Bearer <token real>` (uno solo; se quitan el `authorization` y el `x-api-key` del contenedor).
- `anthropic-beta` con `oauth-2025-04-20` agregado a los valores que manda Claude Code. Claude Code 2.1.322 configurado con `ANTHROPIC_AUTH_TOKEN` o `ANTHROPIC_API_KEY` **no** manda `oauth-2025-04-20` por su cuenta, así que el intermediario es el que lo pone. No se probó la API real sin ese valor para no gastar uso; la documentación del acceso por suscripción lo exige junto con `authorization: Bearer`.

Lo que manda Claude Code 2.1.322 en cada consulta (capturado contra un servidor local que solo registra encabezados, sin gastar uso):

| Encabezado | Valor |
|---|---|
| Ruta | `POST /v1/messages?beta=true` |
| `authorization` | `Bearer <token de curso>` con `ANTHROPIC_AUTH_TOKEN`; con `ANTHROPIC_API_KEY` en cambio manda `x-api-key: <token de curso>` y no manda `authorization` |
| `anthropic-version` | `2023-06-01` |
| `anthropic-beta` | `interleaved-thinking-2025-05-14,context-management-2025-06-27,claude-code-20250219,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,thinking-token-count-2026-05-13,advanced-tool-use-2025-11-20,effort-2025-11-24` (el conjunto varía un poco entre consultas) |
| `anthropic-dangerous-direct-browser-access` | `true` |
| `user-agent` | `claude-cli/2.1.322 (external, sdk-cli)` |
| `x-app` | `cli` |
| `x-claude-code-session-id` | UUID de la sesión |
| `x-stainless-*` | `arch`, `lang`, `os`, `package-version`, `retry-count`, `runtime`, `runtime-version`, `timeout` |
| `accept`, `content-type` | `application/json` |

Rutas que usó Claude Code, según el registro del intermediario en las corridas reales:

| Método y ruta | Estado | Veces |
|---|---|---|
| `POST /v1/messages` (con consulta `?beta=true`) | `200` | 4 |

No hubo rutas rechazadas: con `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` Claude Code no consulta `/api/oauth/*`, `/api/organizations`, `/v1/models` ni `/v1/messages/count_tokens` al arrancar ni durante las dos corridas. Tampoco hizo falta reenviar nada fuera de `/v1/`.

## Uso registrado

Resumen que imprimió la prueba de consumo (`uso.json`):

```json
{
  "consultas": 4,
  "modelos": ["claude-haiku-5-5"],
  "tokens_entrada": 8,
  "tokens_salida": 264,
  "tokens_cache_creacion": 23735,
  "tokens_cache_lectura": 45530,
  "rutas": ["POST /v1/messages 200"]
}
```

Detalle por consulta (registro del intermediario, curso `experimento`):

| Corrida | Modelo | Entrada | Salida | Caché creación | Caché lectura |
|---|---|---|---|---|---|
| `ok` | `claude-haiku-5-5` | 2 | 4 | 17047 | 0 |
| edición | `claude-haiku-5-5` | 2 | 118 | 6357 | 10888 |
| edición | `claude-haiku-5-5` | 2 | 106 | 152 | 17245 |
| edición | `claude-haiku-5-5` | 2 | 36 | 179 | 17397 |

El alias `haiku` de Claude Code se resolvió a `claude-haiku-5-5`. Casi todo el costo es el prompt de sistema y las herramientas de Claude Code (unos 17 000 tokens por consulta), que se cachean: la primera consulta de una sesión los escribe en caché y las siguientes los leen. La salida total fue de 264 tokens.

## Variantes probadas

| Variante | Cómo | Resultado |
|---|---|---|
| Plan A, `ANTHROPIC_AUTH_TOKEN`, `anthropic-beta` del cliente + `oauth-2025-04-20` | Contra la API real | `200` en las 4 consultas; las dos corridas terminaron bien |
| Plan A, `ANTHROPIC_API_KEY` en lugar de `ANTHROPIC_AUTH_TOKEN` | Contra un servidor local de captura (sin gastar uso) | Claude Code manda `x-api-key: <token de curso>` y ningún `authorization`; el resto de los encabezados, la ruta y el cuerpo son iguales. El intermediario quita `x-api-key` y pone el mismo `authorization: Bearer <token real>`, así que hacia la API la petición es idéntica a la variante anterior. No se corrió contra la API real para no gastar |
| Token de curso inventado | Contra la API real a través del intermediario (`ataque/03`) | El intermediario responde `401` (`authentication_error`) sin reenviar; Claude Code reintenta y no produce respuesta. Nada llega a la API |
| Otros valores de `INTERMEDIARIO_BETA` | — | No hizo falta: el valor por defecto funcionó |
| Rutas de arranque rechazadas | — | No hubo: el registro solo tiene `POST /v1/messages` |
| Plan B (`CLAUDE_CODE_OAUTH_TOKEN` dentro del contenedor) | — | No hizo falta y no se implementó |

## Recomendación para la fase 3

Llevar el intermediario al núcleo como implementación de `ProveedorDeModelo`, con el plan A:

- **Servicio**: el mismo binario del núcleo escucha en una dirección accesible solo desde la red de los contenedores de cursos (no expuesta por Caddy). Los contenedores reciben `ANTHROPIC_BASE_URL` apuntando a esa dirección y `ANTHROPIC_AUTH_TOKEN` con el token propio del curso, más las cuatro variables `DISABLE_*` y `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Fijar la versión de Claude Code en la imagen y actualizarla a mano, verificando antes que solo use `/v1/messages`.
- **Token por curso**: generarlo al crear el contenedor, guardarlo hasheado en SQLite (no en claro) y comparar en tiempo constante; rotarlo en cada recreación del contenedor y revocarlo al archivar el curso. El curso se determina solo por el token.
- **Lista permitida de rutas**: mantener solo `POST /v1/messages` y `POST /v1/messages/count_tokens` (más `GET /v1/models` si se necesita), y rechazar el resto con el mismo orden de comprobaciones del contrato.
- **Límites**: con el registro por curso ya se tienen tokens de entrada, salida y caché por consulta. Agregar cuota diaria y mensual por curso (en tokens de salida y en tokens totales ponderados por precio, contando la creación de caché), límite de consultas concurrentes y por minuto, tamaño máximo de cuerpo, y forzar o restringir el modelo leyendo `model` del cuerpo (por ejemplo, solo haiku y sonnet). Responder `429` con `rate_limit_error` al pasar la cuota, para que Claude Code lo muestre bien.
- **Registro**: pasar el JSON Lines a una tabla `uso_modelo` (curso, momento, ruta, estado, modelo, tokens) y mostrarlo en el panel del owner y del administrador. Mantener que no se registran encabezados ni tokens.
- **Seguridad**: conservar el reemplazo de `[token-oculto]` en respuestas, incluso partido entre trozos del stream, y el arranque que falla si el archivo del token tiene permisos abiertos.
- **Clave de API de producción**: con una clave `sk-ant-api...` en lugar del token de suscripción, el intermediario manda `x-api-key: <clave>` en lugar de `authorization: Bearer` y no agrega `oauth-2025-04-20` (`INTERMEDIARIO_BETA` vacío o un modo `clave_api` en la configuración). Los contenedores no cambian: siguen usando su token de curso con `ANTHROPIC_AUTH_TOKEN`. Conviene que el tipo de credencial sea una variable de entorno del núcleo (`MODELO_CREDENCIAL=suscripcion|clave_api`) y que el resto del flujo sea el mismo.
