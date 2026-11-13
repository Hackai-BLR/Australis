# Tramo experimento del intermediario del modelo

_Creado: 2026-11-10 05:32. Rama `tramo-experimento-intermediario`. Alcance: `.orquestacion/tramo-experimento-intermediario.md`. Contrato: `contratos/tramo-experimento-intermediario.md`. Resultado con evidencia: `pruebas/experimento-intermediario/RESULTADO.md`._

## Respuesta del tramo

Sí: Claude Code corriendo en un contenedor sin ninguna credencial de Anthropic usa la suscripción del equipo a través de un intermediario en el anfitrión que guarda el token real, y el token no aparece en la imagen, los contenedores, sus salidas, el registro ni el repo. Funcionó el plan A en la primera variante; el plan B no hizo falta y no se implementó.

## Qué se hizo

| Ruta | Contenido |
|---|---|
| `contratos/tramo-experimento-intermediario.md` | Interfaz HTTP del intermediario, validación de credenciales, orden de errores, encabezados, registro de uso, variables de entorno, contenedor, permisos, plan B y pruebas |
| `pruebas/experimento-intermediario/intermediario/` | Crate `intermediario-experimento` en Rust con hyper 1, hyper-util y hyper-rustls (ring, webpki-roots). Módulos: `config` (arranque y validación de archivos), `censura` (reemplazo del token real por `[token-oculto]`, también partido entre trozos del stream), `uso` (tokens de JSON y de SSE), `registro` (JSON Lines), `main` (servidor, validación en tiempo constante, lista permitida de rutas y métodos, reenvío en streaming) |
| `pruebas/experimento-intermediario/contenedor/Dockerfile` | `node:22-bookworm-slim`, `git`, Claude Code `2.1.322` fijo, `DISABLE_*` y `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `HOME=/tmp`, sin credenciales |
| `pruebas/experimento-intermediario/RESULTADO.md` | Qué funcionó, encabezados y rutas, uso registrado, variantes probadas y recomendación para la fase 3 |
| `pruebas/tramo-experimento-intermediario/` | Pruebas de aceptación y de ataque con `node --test`, sin dependencias, y `correr.sh` |

## Cómo se compila

```
. "$HOME/.cargo/env"
cargo build --release --manifest-path pruebas/experimento-intermediario/intermediario/Cargo.toml
docker build -t campusia-experimento-claude:prueba pruebas/experimento-intermediario/contenedor
```

## Cómo se levanta

```
INTERMEDIARIO_DIRECCION=0.0.0.0:8790 \
INTERMEDIARIO_TOKEN_ARCHIVO=$HOME/.config/campusia/claude-oauth-token \
INTERMEDIARIO_CURSOS=/ruta/a/cursos \
INTERMEDIARIO_REGISTRO=/ruta/a/registro.jsonl \
pruebas/experimento-intermediario/intermediario/target/release/intermediario-experimento
```

El archivo de cursos tiene una línea `<id> curso-<16 o más caracteres>` por curso. El archivo del token tiene que tener permisos `600`; si no, el intermediario no arranca. Para usarlo desde un contenedor:

```
docker run --add-host=host.docker.internal:host-gateway --user $(id -u):$(id -g) -e HOME=/tmp \
  -e ANTHROPIC_BASE_URL=http://host.docker.internal:8790 -e ANTHROPIC_AUTH_TOKEN=<token de curso> \
  campusia-experimento-claude:prueba claude -p "Respondé solo: ok" --model haiku
```

## Cómo se prueba

```
bash pruebas/tramo-experimento-intermediario/correr.sh
```

Compila el crate, construye la imagen, levanta destinos falsos e intermediarios en puertos libres, corre las dos consultas reales con haiku y borra los contenedores al terminar. Requiere `cargo`, Node 22, Docker sin sudo y el token de desarrollo en `~/.config/campusia/claude-oauth-token` (otra ruta con `CAMPUSIA_TOKEN_ARCHIVO`). Con `EXPERIMENTO_BINARIO=<ruta>` usa un binario ya compilado.

Resultado de la última corrida completa:

| Grupo | Resultado |
|---|---|
| Aceptación | 18/18 |
| Ataque | 34/34 |

Consumo de las dos corridas reales: 4 consultas a `POST /v1/messages`, todas `claude-haiku-5-5`, 8 tokens de entrada, 264 de salida, 23 735 de creación de caché y 45 530 de lectura de caché.

## Cómo se despliega

No se despliega: es un experimento que vive en `pruebas/`. Lo que se lleva a producción es la recomendación de `RESULTADO.md`, a implementar en la fase 3 dentro del núcleo.

## Decisiones tomadas

- Plan A: el contenedor usa `ANTHROPIC_BASE_URL` y `ANTHROPIC_AUTH_TOKEN` con un token de curso; el intermediario lo cambia por `authorization: Bearer <token real>` y agrega `anthropic-beta: oauth-2025-04-20`, que Claude Code no manda cuando usa `ANTHROPIC_AUTH_TOKEN` o `ANTHROPIC_API_KEY`.
- hyper directo en lugar de axum, para controlar el streaming trozo a trozo y la censura con ventana; el código se lleva igual al núcleo.
- Lista permitida: solo `GET` y `POST` sobre `/v1/`, con rechazo de recorridos codificados; el destino es siempre `INTERMEDIARIO_DESTINO`, sin importar `Host` ni URL absoluta.
- El curso se determina solo por el token; dos credenciales juntas se rechazan.
- Las pruebas con destino falso usan un token real falso generado en cada corrida, así que no gastan uso ni exponen el verdadero.
- La variante `ANTHROPIC_API_KEY` se verificó contra un servidor local de captura para no gastar: la petición hacia la API queda idéntica.

## Desvíos del plan

- El alias `haiku` de Claude Code 2.1.322 se resuelve a `claude-haiku-5-5`, no a un modelo haiku 4.x; la prueba de consumo acepta cualquier modelo haiku.
- No hizo falta probar otros valores de `INTERMEDIARIO_BETA` ni el plan B, así que no existe `contenedor/plan-b.sh`.
- Se agregó un `.gitignore` en la raíz para `target/`, `node_modules/`, `dist/`, bases de datos, registros JSON Lines y archivos `.env`.
- No se tocó `nucleo/` ni ninguna carpeta fuera de las del alcance, salvo ese `.gitignore`.

## Pendientes conocidos

- No se probó la API real sin `oauth-2025-04-20` para confirmar que es obligatorio; se asume por la documentación del acceso por suscripción.
- Claude Code con `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` solo usó `POST /v1/messages`. Al actualizar la versión fija hay que volver a correr las pruebas por si consulta rutas nuevas.
- Los tokens de curso del experimento están en claro en un archivo; en el núcleo van hasheados en SQLite, con rotación y revocación.
- Faltan cuotas por curso, límite de concurrencia y restricción de modelo (`429` con `rate_limit_error`), previstos para la fase 3.
- El modo con clave de API de producción (`x-api-key`, sin `oauth-2025-04-20`) está descripto pero no implementado.
- `correr.sh` gasta dos corridas cortas reales con haiku cada vez que se ejecuta.
