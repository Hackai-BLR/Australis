# Contrato del tramo: acciones del profesor para el agente, sin tokens personales y cupos de tokens

_Escrito: 2026-11-10. Rama `tramo-acciones-y-cupos`, desde `main` con las fases 1 a 4, el tramo inhabilitar y la reautenticación por sesión ya integrados. Referencias: `CONVENCIONES.md`, `handoffs/261110_0400_plan-implementacion-plataforma.md`, `handoffs/261110_1618_integracion-fases-3-e-inhabilitar.md`, `contratos/fase-1.md` a `contratos/fase-4.md`, `contratos/tramo-inhabilitar.md`, `contratos/tramo-plantilla-sdk.md`, `contratos/identidad-cursos.md`, `.orquestacion/tramo-acciones-y-cupos.md` y `prototipo/campus.html`._

Este contrato es la fuente de verdad para implementar el tramo. Las pruebas de `pruebas/tramo-acciones-y-cupos/` lo verifican. Si algo de acá no coincide con una prueba, manda la prueba y se avisa en el handoff. Las pruebas no se cambian para que pasen. Todo lo de los contratos anteriores sigue vigente salvo lo que este contrato cambia explícitamente (en particular: se eliminan los tokens personales, "Cerrar las demás sesiones" y el límite mensual en USD).

## 1. Módulos y carpetas

| Módulo | Carpetas | Qué entrega |
|---|---|---|
| Núcleo | `nucleo/` | Migración `6001_acciones_y_cupos.sql`; acciones del profesor en la API para cursos y en la escucha de espacios (token del agente `cat_`, confirmaciones); eliminación de los tokens personales y de `cerrar-otras`; sesiones de una persona para el owner; cupos de tokens (asignación, reparto, medición, corte en el agente y en el intermediario, aviso del 80 %, proveedor sin uso disponible); `sembrar` con `cupo_tokens` |
| Interfaz | `interfaz/` | Menú de perfil sin "Tokens de API" ni "Cerrar las demás sesiones"; sesiones de una persona en Administración › Personas (owner); confirmaciones y cupo en el panel Editar; pestaña Cupos del owner y del administrador; Configuración del administrador sin el límite en USD |
| Espacio de trabajo, plantilla y SDK | `despliegue/`, `plantilla-curso/`, `sdk/` | `@campusia/sdk` 0.3.0 con los métodos de las acciones y `CAMPUSIA_TOKEN_AGENTE`; plantilla con el SDK nuevo (`vendor/`, `package.json`, `pnpm-lock.yaml`) y `CLAUDE.md` con las acciones; imagen del espacio que deja pasar `CAMPUSIA_TOKEN_AGENTE` a los comandos del agente y trae el mismo texto de las acciones como memoria gestionada (`/etc/claude-code/CLAUDE.md`); `campusia.env.ejemplo` con las variables nuevas |

Cada módulo toca solo sus carpetas. Nadie toca `pruebas/`, `contratos/`, `prototipo/`, `handoffs/` ni `.orquestacion/`, ni crea carpetas nuevas en la raíz. Los módulos se comunican solo por lo que fija este contrato: el núcleo le pasa al espacio `CAMPUSIA_TOKEN_AGENTE` (sección 5.2) y el SDK llama a las rutas de la sección 5.3; la interfaz usa las rutas de las secciones 6 a 8.

Convivencia con otras ramas: la migración usa el prefijo `6xxx` y las anteriores no se modifican. En los archivos compartidos del núcleo (`main.rs`, `servidor.rs`, `auth.rs`, `modelo.rs`, `agente.rs`, `api_cursos.rs`, `espacios.rs`, `admin.rs`, `owner.rs`, `cuenta.rs`) se agregan rutas y llamadas a funciones de módulos nuevos (por ejemplo `acciones.rs`, `cupos.rs`, `sesiones_owner.rs`), sin reordenar lo existente. Se borra el código de los tokens personales y de `cerrar-otras`.

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

### Levantar en desarrollo

Igual que la fase 3 (sección 2 de `contratos/fase-3.md`), con `RAIZ_ARCHIVOS` y `DIR_RESPALDOS` de la fase 4 y, si se quiere, las variables nuevas de la sección 3:

```bash
nucleo/target/debug/campusia-nucleo migrar
nucleo/target/debug/campusia-nucleo sembrar pruebas/tramo-inhabilitar/datos.json
nucleo/target/debug/campusia-nucleo crear-owner equipo@campusia.prueba
nucleo/target/debug/campusia-nucleo
```

### Probar

```bash
bash pruebas/tramo-acciones-y-cupos/correr.sh
```

Corre, desde cero y sin pasos manuales, y sigue aunque una parte falle (termina con código distinto de 0 si alguna falló):

1. Las pruebas del SDK del tramo (`node --test pruebas/tramo-acciones-y-cupos/sdk.test.mjs`, después de instalar y compilar `sdk/`): sin red ni Docker.
2. Las pruebas del tramo con Playwright (`pruebas/tramo-acciones-y-cupos/playwright.config.ts`): compila núcleo, interfaz y SDK (`comun/compilar.ts`), construye una vez por corrida la imagen del espacio (`fase-3/preparar-global.ts` y `fase-3/lib/imagen.ts`) y la borra al terminar (`fase-3/limpieza-global.ts`).
3. `pruebas/tramo-inhabilitar/correr.sh`, que corre el tramo inhabilitar y `pruebas/fase-4/correr.sh` (tramos de plantilla y SDK y de resguardo y Playwright de las fases 1 a 4).

Con argumentos (`bash pruebas/tramo-acciones-y-cupos/correr.sh ataque/cupos.spec.ts`) o con `SOLO_TRAMO=1` corre solo las pruebas del tramo (1 y 2, con esos argumentos para Playwright). `CAMPUSIA_SIN_COMPILAR=1` y `PRUEBAS_WORKERS` funcionan como antes.

Requisitos de la máquina: los de la fase 3 y la fase 4 (Docker sin sudo, Node 22, pnpm, Rust, red hacia `registry.npmjs.org` y los registros de imágenes para construir la imagen del espacio). Las pruebas con Docker usan un prefijo `cia<8 hex>` propio por núcleo y borran solo lo suyo; nunca corren `docker system prune`.

Las pruebas usan los datos de `pruebas/fase-2/datos.json` (las que necesitan Docker, con `crearTestAgente` de la fase 3 y el modelo falso) o de `pruebas/tramo-inhabilitar/datos.json` (las que no). Las que no usan Docker agregan cursos de prueba directamente en la base, como el tramo inhabilitar.

## 3. Variables de entorno nuevas

| Variable | Por defecto | Uso |
|---|---|---|
| `RESERVA_TOKENS_PEDIDO` | `20000` | Tokens que el intermediario reserva por cada petición en vuelo al decidir si un pedido entra en el cupo (sección 8.4). Entero de 0 a 10 000 000; otro valor: el núcleo no arranca |
| `ESPERA_SIN_USO_SEG` | `300` | Con `PROVEEDOR_MODELO=suscripcion`, cuánto se considera que no hay uso disponible después de que el destino responde `429`, si no trae `retry-after` (sección 8.5). Entero de 1 a 86 400 |

Se eliminan: ninguna variable (los tokens personales no tenían variables propias).

## 4. Modelo de datos

Migración nueva `nucleo/migraciones/6001_acciones_y_cupos.sql`. Las anteriores no se modifican. Las columnas marcadas con * las leen o escriben las pruebas. Las fechas, como siempre, en RFC 3339 UTC.

```sql
ALTER TABLE universidades ADD COLUMN cupo_tokens* INTEGER NOT NULL DEFAULT 20000000;
UPDATE universidades SET cupo_tokens = CAST(ROUND(limite_usd * 1000000) AS INTEGER);
ALTER TABLE universidades ADD COLUMN cupo_profesor_predeterminado* INTEGER NULL;

cupos_profesor(usuario_id* INTEGER PK REFERENCES usuarios, universidad_id* INTEGER NOT NULL REFERENCES universidades,
               tokens* INTEGER NOT NULL, actualizado_en TEXT NOT NULL, actualizado_por INTEGER NULL)

ALTER TABLE uso_modelo ADD COLUMN usuario_id* INTEGER NULL;
ALTER TABLE uso_modelo ADD COLUMN tokens* INTEGER NOT NULL DEFAULT 0;

tokens_agente(id INTEGER PK, huella TEXT NOT NULL UNIQUE, curso_id* TEXT NOT NULL, usuario_id* INTEGER NOT NULL,
              mensaje_id INTEGER NULL, creado_en TEXT NOT NULL, vence_en TEXT NOT NULL, revocado* INTEGER NOT NULL DEFAULT 0)

confirmaciones_agente(id* INTEGER PK, curso_id* TEXT NOT NULL, tipo* TEXT NOT NULL CHECK (tipo IN ('quitar','rol')),
                      usuario_id* INTEGER NOT NULL, rol* TEXT NULL CHECK (rol IN ('alumno','profesor')),
                      pedida_por* INTEGER NOT NULL, mensaje_id INTEGER NULL,
                      estado* TEXT NOT NULL CHECK (estado IN ('pendiente','aprobada','rechazada','fallida')),
                      error TEXT NULL, creada_en TEXT NOT NULL, resuelta_en TEXT NULL, resuelta_por INTEGER NULL)

ALTER TABLE auditoria ADD COLUMN agente* INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sesiones ADD COLUMN ultimo_uso* TEXT NULL;
```

- **Migración del límite en USD**: cada universidad queda con `cupo_tokens = limite_usd × 1 000 000` (1 USD de límite = 1 millón de tokens por mes). `limite_usd` se conserva en la base y en las respuestas que ya lo tenían (`Universidad`, `UniversidadOwner`, `Uso` de la fase 3) solo como dato histórico: ya no se usa para cortar ni se puede cambiar.
- `sembrar`: cada universidad acepta `cupo_tokens` (entero). Si falta, queda `limite_usd × 1 000 000`; si tampoco hay `limite_usd`, `20 000 000`. Con los datos de las pruebas: Universidad Austral 40 000 000 y Universidad de Prueba 20 000 000.
- `POST /api/owner/universidades` acepta `cupo_tokens` opcional (entero de 0 a 10^12; si falta, 20 000 000).
- `tokens_api` queda en la base, sin uso (no se borra historia). Ninguna ruta la lee para autenticar. Las acciones que antes revocaban tokens (suspender, dar de baja, quitar administrador, quitar owner) siguen marcando `revocado = 1` en las filas de esa persona (`tramo-inhabilitar/aceptacion/cuentas.spec.ts` lo verifica).
- `tokens_agente.huella` y los tokens de curso y de modelo: solo la huella `HMAC-SHA256(SESSION_SECRET, valor)`; el valor nunca se guarda en claro.
- `uso_modelo.tokens` = `tokens_entrada + tokens_cache_creacion + tokens_cache_lectura + tokens_salida` de esa fila (sección 8.1). `uso_modelo.usuario_id` es el profesor al que se le descuenta.
- `auditoria.agente = 1` en los eventos que pidió el agente (sección 5.5). La auditoría sigue siendo de solo agregado.
- `sesiones.ultimo_uso`: hora de la última petición autenticada con esa sesión (se puede actualizar como mucho una vez por minuto). Al crear la sesión es igual a `creada_en`.

## 5. Acciones del profesor para el agente

### 5.1 Qué son

Un conjunto **fijo** de acciones, las mismas que un docente hace desde el panel Inscriptos: listar inscriptos, inscribir por mails, importar el listado del SIU, ver, generar y activar o desactivar el código de inscripción, quitar personas y cambiar roles. No es extensible: el código del curso y el agente solo pueden usar estas rutas (sección 5.3). Transferir, archivar, entregas, notas, publicar y todo lo demás no están.

### 5.2 Tokens

| Token | Dónde vive | Qué puede |
|---|---|---|
| `cct_` del curso publicado (fase 2) | variable `CAMPUSIA_TOKEN_CURSO` del contenedor del curso | Solo las **lecturas** de la sección 5.3 (en la escucha de la API para cursos) |
| `cct_` del espacio (fase 3) | variable `CAMPUSIA_TOKEN_CURSO` del espacio | Solo las **lecturas** de la sección 5.3 (en la escucha de espacios) |
| `cat_` del agente (nuevo) | variable `CAMPUSIA_TOKEN_AGENTE` de cada ejecución del agente | Lecturas y **escrituras** de la sección 5.3, con los permisos de su profesor en su curso, solo en la escucha de espacios |

Token del agente:
- Valor `cat_` seguido de 32 bytes aleatorios en base64url (43 caracteres). Uno nuevo por cada ejecución del agente (`POST /api/cursos/{id}/agente`), atado al curso y a la persona que hizo el pedido. Se guarda solo la huella en `tokens_agente`.
- Vale mientras dura esa ejecución: se revoca al terminar (bien, con error, por tiempo o por el cupo) y vence a los `AGENTE_MAX_SEG` aunque el núcleo no llegue a revocarlo. Después: `401`.
- El núcleo se lo pasa al proceso del agente sin escribirlo en el repo, en la base, en el registro ni en un argumento de línea de comandos: `docker exec -e CAMPUSIA_TOKEN_AGENTE ...` con el valor en el entorno del proceso del CLI (no `-e CAMPUSIA_TOKEN_AGENTE=<valor>`). No aparece en `docker inspect` del espacio.
- En la imagen del espacio, `campusia-agente` y el shell del agente (`/usr/local/lib/campusia/bash`) **conservan** `CAMPUSIA_TOKEN_AGENTE` y `CAMPUSIA_API` (siguen borrando `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`, `CAMPUSIA_TOKEN_CURSO` y `CAMPUSIA_CLAVE_PUBLICA`). Los hooks siguen rechazando los comandos que nombran variables (`CAMPUSIA_`, `process.env`, ...): el token lo usa el SDK por dentro, desde un script que el agente escribe y ejecuta con `node`.
- Si el profesor deja de ser docente del curso o queda inhabilitado, o el curso queda fuera de servicio (archivado o universidad deshabilitada), el token deja de servir en la petición siguiente (`401`, o `403 prohibido` si sigue la sesión del token pero ya no es docente).
- En la escucha de la API para cursos (la de los cursos publicados), en la escucha principal y en el intermediario del modelo, un `cat_` responde `401`.

### 5.3 Rutas

Se sirven bajo `/api/curso/acciones/` en la escucha de espacios (`URL_ESPACIOS`, fase 3) y en la escucha de la API para cursos (`URL_API_CURSOS`, fase 2), con `Authorization: Bearer <token>`. No hay control de `Origin`. `{curso}` es siempre el curso del token: ningún parámetro, encabezado ni campo del cuerpo lo cambia (`?curso=`, `X-Campus-Curso`, `curso_id`, ... se ignoran). En la escucha principal, `/api/curso/*` sigue respondiendo `404`.

| Método y ruta | Token | Cuerpo | Respuesta | Equivale a |
|---|---|---|---|---|
| `GET /api/curso/acciones/inscriptos` | `cct_` o `cat_` | | `200 {"inscriptos":[InscriptoAccion],"alumnos","profesores"}` | `GET /api/cursos/{curso}/inscriptos` |
| `POST /api/curso/acciones/inscriptos` | `cat_` | `{"emails":[...],"rol":"alumno"\|"profesor"}` | `200 {"agregados","ya_estaban","creados"}` | `POST /api/cursos/{curso}/inscriptos` |
| `POST /api/curso/acciones/inscriptos/siu` | `cat_` | `{"archivo","contenido"}` | `200 {"agregados","ya_estaban","creados","rechazados"}` | `POST /api/cursos/{curso}/inscriptos/siu` |
| `GET /api/curso/acciones/codigo` | `cct_` o `cat_` | | `200 Codigo` | `GET /api/cursos/{curso}/codigo` |
| `POST /api/curso/acciones/codigo` | `cat_` | `{"dias"?}` | `200 Codigo` | `POST /api/cursos/{curso}/codigo` |
| `POST /api/curso/acciones/codigo/activo` | `cat_` | `{"activo": bool}` | `200 Codigo` | `PUT /api/cursos/{curso}/codigo` |
| `POST /api/curso/acciones/quitar` | `cat_` | `{"usuario_id"}` | `202 Confirmacion` (pendiente) | pide `DELETE /api/cursos/{curso}/inscriptos/{usuario_id}` |
| `POST /api/curso/acciones/rol` | `cat_` | `{"usuario_id","rol":"alumno"\|"profesor"}` | `202 Confirmacion` (pendiente) | pide `PUT /api/cursos/{curso}/inscriptos/{usuario_id}` |
| `GET /api/curso/acciones/confirmaciones` | `cct_` o `cat_` | | `200 {"confirmaciones":[Confirmacion]}`, las pendientes del curso, de la más vieja a la más nueva | |

Formatos:
- `InscriptoAccion`: `{"id","nombre","email","rol","pendiente","suspendida"}`, con `id` como cadena. Mismo orden y conteos que en la plataforma.
- `Codigo`: el de la fase 2.
- `Confirmacion`: `{"id","tipo":"quitar"|"rol","persona":{"id","nombre","email"},"rol":"alumno"|"profesor"|null,"estado":"pendiente"|"aprobada"|"rechazada"|"fallida","pedida_por":{"id","nombre"},"creada","resuelta":fecha|null,"error":texto|null}`. En la API para cursos y en la escucha de espacios los `id` de personas son cadenas; en la API de la plataforma (sección 5.4), números. `usuario_id` del cuerpo acepta número o cadena de dígitos.

Mismos cuerpos, validaciones, errores (`400 datos_invalidos`, `email_invalido` con `emails`, `dominio_no_habilitado` con `emails`, `no_es_profesor` con `emails`, `archivo_invalido`, `413`) y efectos que la ruta equivalente de la plataforma, con los permisos que **el profesor del token** tiene en ese momento en ese curso (fase 2 y tramo inhabilitar):
- Inscribir alumnos, importar del SIU y manejar el código: cualquier docente.
- Inscribir profesores: solo el dueño (`403 prohibido` para un profesor).
- Pedir quitar: un alumno, cualquier docente; un profesor, solo el dueño (`403 prohibido`); al dueño, nadie (`409 es_dueno`); un profesor no se pide quitar a sí mismo (`403 prohibido`).
- Pedir cambiar de rol: solo el dueño (`403 prohibido`); al dueño no (`409 es_dueno`); para pasar a `profesor` hace falta la marca (`400 no_es_profesor`).
- Persona no inscripta en este curso (aunque esté en otro) o inexistente: `404 no_encontrado`.

Orden de los controles:
1. Token. Sin token, inventado, revocado, vencido, de otro tipo (`cia_`, `cmt_`, cookie de sesión) o, en la escucha de la API para cursos, un `cat_`: `401 {"error":"no_autenticado"}`. Curso fuera de servicio, profesor del `cat_` inhabilitado: `401`.
2. Límite de frecuencia por token (`LIMITE_API_CURSO_MINUTO`, fase 4): `429 demasiados_intentos`.
3. Ruta: cualquier otra ruta o método bajo `/api/curso/acciones/` responde `404` (en particular `DELETE` y `PUT`, y rutas como `/api/curso/acciones/aprobar`, `/api/curso/acciones/transferir` o `/api/curso/acciones/confirmaciones/{id}/aprobar`).
4. Escritura con un `cct_`: `403 prohibido`. No cambia nada.
5. Profesor del `cat_` que ya no es docente del curso: `403 prohibido`.
6. Rol, validación del cuerpo, alcance y conflictos, como la ruta equivalente.

### 5.4 Confirmaciones

Quitar personas y cambiar roles pedidos por el agente **no se ejecutan**: `POST /api/curso/acciones/quitar` y `.../rol` validan y crean una fila `pendiente` en `confirmaciones_agente` (con `pedida_por` = el profesor del token y `mensaje_id` de la ejecución). Nada cambia en `inscripciones` hasta que el profesor la aprueba desde el panel Editar.

Rutas de la plataforma (escucha principal, solo con la sesión de la interfaz; reglas generales de la sección 6):

| Método y ruta | Quién | Reaut | Cuerpo | Respuesta |
|---|---|---|---|---|
| `GET /api/cursos/{id}/confirmaciones` | docente | | | `200 {"confirmaciones":[Confirmacion]}`: las pendientes del curso, de la más vieja a la más nueva |
| `POST /api/cursos/{id}/confirmaciones/{cid}/aprobar` | quien la pidió | sí | `{}` | `200 Confirmacion` (`aprobada`) |
| `POST /api/cursos/{id}/confirmaciones/{cid}/rechazar` | quien la pidió | | `{}` | `200 Confirmacion` (`rechazada`) |

- No inscripto o curso inexistente: `404`. Alumno: `403 prohibido`. Confirmación de otro curso o inexistente: `404`. Docente que no es quien la pidió: `403 prohibido`.
- Ya resuelta (aprobada, rechazada o fallida): `409 confirmacion_resuelta`, sin cambios.
- Curso archivado: `409 curso_archivado` (después del rol y la reautenticación).
- Aprobar ejecuta la acción con los controles de la ruta equivalente hechos sobre quien aprueba y el estado de ese momento. Si alguno falla (la persona ya no está, ahora es el dueño, ya no tiene la marca, ...) responde ese error (`404`, `409 es_dueno`, `400 no_es_profesor`, `403 prohibido`) y la confirmación queda `fallida` con el motivo en `error`. Si sale bien, el efecto es el mismo que la acción de la web (por ejemplo, quitar copia la inscripción a `inscripciones_historia`).
- Una confirmación se aprueba una sola vez: dos aprobaciones simultáneas ejecutan la acción una vez y la otra recibe `409 confirmacion_resuelta`.

### 5.5 Auditoría

Todo lo que modifica el agente queda en `auditoria` con `actor_id` = el profesor del token, `agente = 1` y el `detalle` habitual más el texto "pedido por el agente". `universidad_id` es la del curso. Acciones:
- `inscripcion` (una por persona), `importacion_siu`, `codigo_curso_generado`, `codigo_curso_cambiado`: como en la fase 2, con `agente = 1`.
- `confirmacion_pedida` (nueva): al crear una confirmación; `detalle` con el id del curso, el mail de la persona afectada y `quitar` o el rol pedido.
- Al aprobar: `desinscripcion` o `rol_en_curso`, con `actor_id` = quien aprueba y `agente = 1`.
- `confirmacion_rechazada` (nueva): al rechazar, con `agente = 1`.

Las lecturas no se auditan. `GET /api/admin/auditoria` agrega a cada evento `"agente": bool`.

### 5.6 SDK (`@campusia/sdk` 0.3.0)

Se agregan a `ClienteCampus`, sin cambiar lo existente (mismo manejo de errores, `redirect: 'manual'`, `Accept: application/json`, `Authorization: Bearer <token>`, tiempo máximo y JSON en el cuerpo con `Content-Type: application/json`):

| Método | Ruta | Devuelve |
|---|---|---|
| `listarInscriptos()` | `GET /api/curso/acciones/inscriptos` | `ListaInscriptos` (`{ inscriptos: InscriptoAccion[], alumnos, profesores }`) |
| `inscribir(emails, rol = 'alumno')` | `POST /api/curso/acciones/inscriptos` con `{ emails, rol }` | `ResultadoInscripcion` (`{ agregados, ya_estaban, creados }`) |
| `importarSiu(archivo, contenido)` | `POST /api/curso/acciones/inscriptos/siu` con `{ archivo, contenido }` (`contenido` es `Uint8Array`, `ArrayBuffer` o `Buffer`; el SDK lo manda en base64 estándar) | `ResultadoSiu` (agrega `rechazados`) |
| `codigoInscripcion()` | `GET /api/curso/acciones/codigo` | `CodigoCurso` (`{ codigo, activo, vence }`) |
| `generarCodigo(dias?)` | `POST /api/curso/acciones/codigo` con `{ dias }` o `{}` | `CodigoCurso` |
| `activarCodigo(activo)` | `POST /api/curso/acciones/codigo/activo` con `{ activo }` | `CodigoCurso` |
| `pedirQuitar(usuarioId)` | `POST /api/curso/acciones/quitar` con `{ usuario_id: String(usuarioId) }` | `Confirmacion` |
| `pedirCambioDeRol(usuarioId, rol)` | `POST /api/curso/acciones/rol` con `{ usuario_id: String(usuarioId), rol }` | `Confirmacion` |
| `confirmaciones()` | `GET /api/curso/acciones/confirmaciones` | `Confirmacion[]` (el arreglo de `confirmaciones`) |

- `clienteDesdeEntorno(env = process.env)` usa `CAMPUSIA_API` y, como token, `CAMPUSIA_TOKEN_AGENTE` si no está vacío; si no, `CAMPUSIA_TOKEN_CURSO`.
- `CodigoErrorApi` agrega `email_invalido`, `dominio_no_habilitado`, `no_es_profesor`, `es_dueno` y `archivo_invalido`, con la misma regla de la fase 4 (si la plataforma responde un error con uno de los códigos conocidos en `error`, `ErrorApi.codigo` es ese código; si no, la regla por estado). `ErrorApi` agrega `emails?: string[]` cuando la respuesta trae `emails`. Un `202` es éxito.
- Se exportan los tipos `InscriptoAccion`, `ListaInscriptos`, `ResultadoInscripcion`, `ResultadoSiu`, `CodigoCurso` y `Confirmacion`.
- La versión pasa a `0.3.0` y la plantilla depende de `file:vendor/campusia-sdk-0.3.0.tgz` (con `pnpm-lock.yaml` actualizado: el espacio instala con `--frozen-lockfile`).

### 5.7 Instrucciones para el agente

`plantilla-curso/CLAUDE.md` agrega una sección "Acciones del profesor" y la imagen del espacio instala el mismo texto como memoria gestionada en `/etc/claude-code/CLAUDE.md` (de root, no escribible por el usuario del contenedor), para que también lo tengan los cursos creados antes. El texto:
- nombra cada método de la sección 5.6 (`listarInscriptos`, `inscribir`, `importarSiu`, `codigoInscripcion`, `generarCodigo`, `activarCodigo`, `pedirQuitar`, `pedirCambioDeRol`, `confirmaciones`) y dice que se usan con `clienteDesdeEntorno()` de `@campusia/sdk` desde un script (`.mjs`) que se corre con `node`;
- dice que actúa con los permisos del profesor que está hablando, que quitar personas y cambiar roles quedan pendientes hasta que el profesor confirme en el panel Editar, y que no hay otras acciones.

## 6. Sin tokens personales

Reglas generales de la API pública (escucha principal) desde este tramo:
- La API pública solo se usa con la sesión de la interfaz (cookie `campusia_sesion`).
- Una petición a `/api/*` con un encabezado `Authorization` (cualquier esquema y valor, incluido un token `cia_` que exista en `tokens_api` y no esté revocado) responde `401 {"error":"no_autenticado"}`, aunque traiga una cookie válida. Nunca cae a la cookie. (En las modificaciones, el control de origen va antes, como siempre.)
- El control de `Origin` y `X-Campusia: 1` se aplica a **todas** las modificaciones (`POST`, `PUT`, `PATCH`, `DELETE`), sin excepción por `Authorization`.
- Rutas eliminadas (responden `404 no_encontrado` con una sesión válida, sin `Authorization`): `GET /api/tokens`, `POST /api/tokens`, `DELETE /api/tokens/{id}`, `POST /api/sesiones/cerrar-otras` y `PUT /api/admin/limite`.
- Los códigos `requiere_sesion` y `permiso_del_token` dejan de producirse en la API pública. `GET /api/yo` siempre trae `sesion` (objeto).
- No se generan más `token_creado`, `token_revocado` ni `sesiones_cerradas` (por la persona); las filas viejas de la auditoría quedan.
- `/salud` sigue igual. El enrutador de `-curso` y `-prueba` sigue borrando `Authorization` antes de reenviar.

### 6.1 Sesiones de una persona (owner)

| Método y ruta | Quién | Reaut | Cuerpo | Respuesta |
|---|---|---|---|---|
| `GET /api/owner/personas/{id}/sesiones` | owner | | | `200 {"sesiones":[SesionActiva]}`: las no revocadas y no vencidas de esa persona, de la más reciente (por `ultimo_uso`) a la más vieja |
| `DELETE /api/owner/personas/{id}/sesiones/{sid}` | owner | sí | | `204`. Revoca esa sesión |
| `POST /api/owner/personas/{id}/sesiones/cerrar` | owner | sí | `{}` | `200 {"cerradas": n}`. Revoca todas las sesiones activas de esa persona |

- `SesionActiva`: `{"id","dispositivo","agente","ip","creada","ultimo_uso","vence"}`. `agente` es el `User-Agent` con el que se entró (hasta 300 caracteres, o `null`); `dispositivo` es un texto corto derivado de él, "<navegador> en <sistema>" cuando se reconocen (por ejemplo "Chrome en Linux", "Firefox en Windows", "Safari en iPhone"), o "Dispositivo desconocido". `ip` es la IP del cliente al entrar.
- No owner (administrador, profesor, cuenta común): `403 prohibido`. Persona inexistente o `id` no entero: `404`. Sesión que no es de esa persona, inexistente o ya revocada: `404`.
- Auditoría `sesion_cerrada` (una sesión) y `sesiones_cerradas` (todas), con el owner como actor, la universidad de la persona y su mail en el `detalle`. Nunca incluye el valor ni la huella de la sesión.
- Se puede usar sobre la propia cuenta; cerrar la sesión con la que se hace el pedido deja al owner afuera en la petición siguiente.

## 7. Cupos de tokens del modelo

### 7.1 Definiciones

- **Tokens de un pedido**: los que devuelve la respuesta del modelo, `input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens` (0 los que falten), y se guardan en `uso_modelo.tokens`. Igual con `suscripcion` que con `api`.
- **Mes**: calendario, `AAAA-MM` en UTC (el de `uso_modelo.mes`).
- **Usado de un profesor**: suma de `uso_modelo.tokens` del mes con su `usuario_id` en cursos de su universidad. **Usado de una universidad**: suma de `uso_modelo.tokens` del mes con su `universidad_id`.
- **Cupo de la universidad**: `universidades.cupo_tokens`, lo asigna el owner.
- **Cupo de un profesor**: su valor propio en `cupos_profesor` si existe; si no, `cupo_profesor_predeterminado` de su universidad si no es `NULL`; si no, **sin tope propio** (solo lo limita el cupo de la universidad).
- **Profesores de una universidad** (para el reparto): cuentas con `profesor = 1` de esa universidad que no están suspendidas ni dadas de baja (incluidas las pendientes).
- **Repartido**: suma de los cupos de los profesores de la universidad que tienen tope (los sin tope no suman). **Reserva**: `max(0, cupo de la universidad − repartido)`.
- **Porcentaje**: `floor(usado × 100 / cupo)` (con cupo 0 y algo usado, 100; con cupo 0 y nada usado, 0). **Aviso**: porcentaje ≥ 80.

### 7.2 Rutas

Reglas generales de la sección 6. Las de administrador aceptan `?universidad=<id>` como en el tramo inhabilitar (el owner sobre cualquiera; un administrador con otro id: `404`, sin cambios).

| Método y ruta | Quién | Cuerpo | Respuesta |
|---|---|---|---|
| `GET /api/owner/cupos` | owner | | `200 {"mes","universidades":[CupoUniversidad]}`, ordenadas por nombre |
| `PUT /api/owner/universidades/{id}/cupo` | owner | `{"tokens": entero}` | `200 CupoUniversidad`. Auditoría `cupo_universidad` |
| `GET /api/admin/cupos` | administrador (u owner con `?universidad=`) | | `200 CuposAdmin` |
| `PUT /api/admin/cupos/predeterminado` | administrador (u owner con `?universidad=`) | `{"tokens": entero \| null}` | `200 CuposAdmin`. Auditoría `cupo_predeterminado` |
| `PUT /api/admin/cupos/profesores/{usuario_id}` | administrador (u owner con `?universidad=`) | `{"tokens": entero \| null}` | `200 CuposAdmin`. `null` quita el valor propio (vuelve al predeterminado). Auditoría `cupo_profesor` |
| `GET /api/cursos/{id}/cupo` | docente del curso | | `200 CupoProfesor` de quien pregunta |

Formatos:
- `CupoUniversidad`: `{"id","nombre","cupo","usado","porcentaje","aviso","repartido","reserva","deshabilitada"}`.
- `CuposAdmin`: `{"mes","universidad": CupoUniversidad,"predeterminado": n|null,"profesores":[CupoDeProfesor]}`, con `profesores` ordenados por nombre.
- `CupoDeProfesor`: `{"id","nombre","email","cupo": n|null,"propio": bool,"usado","porcentaje": n|null,"aviso": bool}`. `cupo` es el efectivo (`null` si no tiene tope); `propio` dice si es un valor propio; `porcentaje` es `null` sin tope.
- `CupoProfesor`: `{"mes","cupo": n|null,"usado","restante","porcentaje": n|null,"universidad":{"cupo","usado","restante","porcentaje"},"aviso": bool,"agotado": null|"profesor"|"universidad","modelo_disponible": bool}`. `restante` = el menor entre lo que le queda al profesor (si tiene tope) y lo que le queda a la universidad, nunca negativo. `aviso` si el profesor o la universidad llegaron al 80 %. `agotado` dice qué cupo está agotado (primero el del profesor). `modelo_disponible` es `false` mientras el proveedor no tiene uso disponible (sección 7.5).

Validación y permisos:
- `tokens`: entero de 0 a 1 000 000 000 000 (o `null` donde se permite). Otro valor (negativo, decimal, cadena, falta): `400 datos_invalidos`.
- `PUT /api/owner/universidades/{id}/cupo`: solo owner (`403 prohibido` para el resto, incluidos los administradores). Universidad inexistente: `404`. El owner puede bajar el cupo por debajo de lo repartido (la reserva queda en 0).
- Rutas `/api/admin/cupos*`: administrador de esa universidad u owner con `?universidad=`. Profesores, alumnos y cuentas comunes: `403 prohibido`. `usuario_id` inexistente o de otra universidad: `404`; sin marca de profesor: `400 no_es_profesor`.
- **No se reparte más que el total**: un cambio del administrador (predeterminado o valor propio) que deja `repartido > cupo de la universidad` y aumenta lo repartido responde `409 cupo_excedido` (mensaje "Lo repartido supera el cupo de la universidad.") y no cambia nada. Un cambio que no aumenta lo repartido siempre se acepta.
- `GET /api/cursos/{id}/cupo`: no inscripto o inexistente `404`, alumno `403 prohibido`.
- Las cantidades nunca salen de otro lado que del cuerpo de estas rutas: campos como `cupo_tokens`, `usado` o `universidad_id` en otras rutas o de más en estas se ignoran (salvo `cupo_tokens` en `POST /api/owner/universidades`).
- Auditoría `cupo_universidad`, `cupo_predeterminado` y `cupo_profesor`, con la universidad, el valor y (en `cupo_profesor`) el mail del profesor en el `detalle`.

### 7.3 A quién se descuenta

Cada pedido al intermediario descuenta, a la vez, del profesor y de la universidad del curso:
- Si hay una ejecución del agente en curso en ese curso, del profesor que la pidió.
- Si no (por ejemplo, el código del curso usando el modelo en la versión de prueba), del dueño del curso.
- El curso sale del token de modelo y el profesor de la base: ningún encabezado ni campo del cliente cambia a quién se descuenta.

`uso_modelo` sigue teniendo una fila por petición reenviada, ahora con `usuario_id` y `tokens`. `uso_agente` (USD) se sigue sumando como antes, como dato informativo.

### 7.4 Corte

- **Antes de ejecutar el agente** (`POST /api/cursos/{id}/agente`, en el lugar del control de límite de la fase 3): si el profesor que pide tiene tope y su usado ≥ su cupo, `429 cupo_agotado` con `"cupo":"profesor"` y el mensaje "Se agotó tu cupo mensual de uso del agente."; si no, si el usado de la universidad ≥ su cupo, `429 cupo_agotado` con `"cupo":"universidad"` y el mensaje "Se agotó el cupo mensual de uso del agente de la universidad.". No se guarda ningún mensaje ni se ejecuta nada. Reemplaza a `429 limite_uso`.
- **En el intermediario**, antes de reenviar cada pedido (en el lugar del control de límite de la fase 3, que deja de existir): con `R` = `RESERVA_TOKENS_PEDIDO` por cada pedido de ese profesor (o de esa universidad) que ya se reenvió y todavía no terminó, si `usado + R × en_vuelo ≥ cupo` para el profesor (si tiene tope) o para la universidad, responde `429 rate_limit_error` con el mensaje de arriba que corresponda y `x-should-retry: false`, sin reenviar ni guardar fila. Así, con pedidos en paralelo el exceso queda acotado.
- Si el corte llega durante una ejecución del agente, el mensaje del agente termina `error` con el texto del corte (que contiene "cupo"), y los cambios que haya dejado se guardan en `prueba`, como en la fase 3.
- Subir el cupo (o quitar el tope, o empezar un mes nuevo) habilita de nuevo en el pedido siguiente.

### 7.5 Proveedor sin uso disponible

Con `PROVEEDOR_MODELO=suscripcion`, si el destino responde `429` a un pedido reenviado:
- El intermediario responde al espacio `429 rate_limit_error` con el mensaje "No hay uso disponible del modelo por el momento." y `x-should-retry: false` (no reenvía el cuerpo del destino). La fila de `uso_modelo` se guarda como cualquier respuesta del destino (con los tokens que traiga, normalmente 0).
- Durante `retry-after` segundos (el del destino, si viene y es un entero de 1 a 86 400) o `ESPERA_SIN_USO_SEG`, el modelo queda **no disponible** para todos: `GET /api/cursos/{id}/cupo` da `"modelo_disponible": false`, `POST /api/cursos/{id}/agente` responde `503 sin_uso_disponible` (mensaje "No hay uso disponible del modelo por el momento.") sin guardar mensajes, y el intermediario responde lo de arriba sin reenviar.
- Una ejecución cortada así termina `error` con un texto que contiene "No hay uso disponible".
- Pasado ese tiempo, todo vuelve a funcionar solo. Con `PROVEEDOR_MODELO=api`, un `429` del destino se devuelve tal cual (como en la fase 3) y no cambia la disponibilidad.

### 7.6 Avisos

Sin mails: el aviso del 80 % solo se ve en la interfaz (sección 9), para el profesor (su cupo o el de la universidad) y para el administrador (la universidad y cada profesor). Ningún aviso de cupo manda mails.

## 8. Intermediario del modelo: cambios

Todo lo de la sección 7 de `contratos/fase-3.md` sigue, salvo:
- Orden de los controles: 1 a 4 iguales; 5 pasa a ser "modelo no disponible" (sección 7.5) y 6 "cupo" (sección 7.4); 7 destino inalcanzable.
- Medición: además de lo de la fase 3, cada fila guarda `usuario_id` (sección 7.3) y `tokens` (sección 7.1).
- El límite en USD (`universidades.limite_usd`) ya no corta nada.
- Un `cat_`, un `cct_` o un `cia_` siguen sin servir en el intermediario (`401`).

## 9. Interfaz

Reproduce el estilo del prototipo (`prototipo/campus.html`): barra, menú de perfil, tablas `.tabla`, pastillas `.pill` (`ambar` para los avisos), pestañas `#tabs-admin` y `#tabs-owner` de `pintarAdmin` y `pintarOwner`, el panel `#p-agente` de `pintarChat` y `#aviso`. Los selectores nombrados son parte del contrato. Las cantidades de tokens se muestran con separador de miles (por ejemplo "1.250.000 tokens"); las pruebas leen los atributos `data-*`.

**Menú de perfil** (todas las cuentas): no tiene "Tokens de API" (`[data-accion="tokens"]`) ni "Cerrar las demás sesiones" (`[data-accion="cerrar-otras"]`). No hay ninguna pantalla de tokens.

**Administración › Personas** (owner, desde `/administracion?universidad=<id>`): cada `tr[data-persona="<id>"]` lleva `[data-sesiones="<id>"]` ("Sesiones"), que abre un panel o modal `#sesiones-persona` con el nombre de la persona y una fila `tr[data-sesion="<sid>"]` por sesión activa con el dispositivo, la IP y el último uso, y `[data-cerrarsesion="<sid>"]` ("Cerrar"). Abajo, `[data-accion="cerrar-sesiones"]` ("Cerrar todas"). Al cerrar, la fila desaparece y `#aviso` lo confirma ("Sesión cerrada", "Se cerraron N sesiones"). Sin sesiones: "No tiene sesiones activas". Los administradores que no son owner no ven `[data-sesiones]`.

**Administración › Configuración**: ya no tiene el bloque "Límite de uso del agente" ni `#limite`.

**Administración › Cupos** (pestaña `#tabs-admin [data-tab="cupos"]`, "Cupos"; administrador y owner):
- `#cupo-total` con `data-cupo` y `data-usado` (el cupo y el usado de la universidad en el mes) y `#cupo-reserva` con `data-reserva` y `data-repartido`.
- `#cupo-aviso` visible (con el texto "80 %") cuando la universidad llegó al 80 %; si no, no está o está oculto.
- `input#cupo-predeterminado` (vacío = sin predeterminado). Se guarda con Enter o al salir del campo.
- Una fila `tr[data-cupo-profesor="<id>"]` por profesor con nombre, mail, `input[data-cupo-prof="<id>"]` (vacío = usa el predeterminado; se guarda con Enter o al salir), el usado (`data-usado` en la fila) y, si llegó al 80 %, una `.pill.ambar` con "80 %" o más.
- Los errores (`409 cupo_excedido`, `400`) se muestran en `#aviso` ("Lo repartido supera el cupo de la universidad.") y el campo vuelve al valor guardado. Al guardar bien, `#aviso` dice "Cupo guardado" y se actualizan reserva y filas sin recargar.

**Owner › Cupos** (pestaña `#tabs-owner [data-otab="cupos"]`, "Cupos"): una fila `tr[data-cupo-universidad="<id>"]` por universidad con el nombre, `input[data-cupo="<id>"]` (el asignado; se guarda con Enter o al salir), el consumido (`data-usado` en la fila), el porcentaje y una `.pill.ambar` cuando llegó al 80 %. Al guardar, `#aviso` dice "Cupo guardado". La pestaña "Uso y proveedores" sigue como en la fase 1 (USD informativo).

**Panel Editar** (`#p-agente`, fase 3), para el docente que mira:
- `#cupo` con `data-restante` (el `restante` de `CupoProfesor`) y `data-porcentaje` (vacío sin tope), con el texto "Te quedan N tokens este mes". Con `aviso`, `#cupo` tiene la clase `aviso` y el texto dice "Usaste el N % de tu cupo" (o "La universidad usó el N % de su cupo"). Con `agotado`, el texto del corte ("Se agotó ... cupo ...") y `#enviar-pedido` deshabilitado. Con `modelo_disponible: false`, el texto "No hay uso disponible por el momento" y `#enviar-pedido` deshabilitado. Se actualiza al abrir el panel y al terminar cada pedido.
- Si `POST .../agente` responde `429 cupo_agotado` o `503 sin_uso_disponible`, o la ejecución termina con ese error, `#chat` muestra un `.msg.ag.error` con el mensaje (que contiene "cupo" o "No hay uso disponible").
- `#confirmaciones` (dentro de `#p-agente`) con un `.confirmacion[data-confirmacion="<id>"]` por cada confirmación pendiente del curso: el texto "¿Quitar a <nombre> del curso?" o "¿Pasar a <nombre> a <rol>?", y, solo para quien la pidió, `[data-aprobar="<id>"]` ("Confirmar") y `[data-rechazar="<id>"]` ("Cancelar"). Se cargan al abrir el panel y al terminar cada pedido. Al aprobar o rechazar, la fila desaparece, `#aviso` lo confirma ("Listo: se quitó a <nombre>", "Pedido cancelado") y se actualiza el panel Inscriptos. Si la API pide reautenticación, se usa el modal de la fase 1 y se reintenta solo. Los errores van a `#aviso`.

## 10. Permisos

| Acción | Owner | Administrador | Dueño | Profesor del curso | Alumno | Agente (`cat_`) | Código del curso (`cct_`) |
|---|---|---|---|---|---|---|---|
| Listar inscriptos, ver el código y las confirmaciones (acciones) | | | | | | sí, su curso | sí, su curso |
| Inscribir alumnos, importar del SIU, generar y activar el código (acciones) | | | | | | si su profesor es docente | no (`403`) |
| Inscribir profesores (acciones) | | | | | | solo si su profesor es el dueño | no |
| Pedir quitar un alumno / un profesor (acciones) | | | | | | docente / dueño; nunca al dueño | no |
| Pedir cambiar un rol (acciones) | | | | | | solo si su profesor es el dueño | no |
| Aprobar o rechazar una confirmación | | | quien la pidió | quien la pidió | no | no | no |
| Ver y cerrar sesiones de cualquier persona | sí | no | no | no | no | no | no |
| Asignar el cupo de una universidad | sí | no | no | no | no | no | no |
| Repartir el cupo entre profesores | sí, cualquier universidad | sí, solo la suya y sin pasar el total | no | no | no | no | no |
| Ver asignado y consumido por universidad | sí | no | | | | | |
| Ver el cupo por profesor | sí | sí, su universidad | | | | | |
| Ver lo que le queda (panel Editar) | | | sí | sí | no | | |

Reglas:
- El agente nunca hace más que su profesor: cada acción pasa por los mismos controles que la web, hechos sobre el profesor del token en ese momento.
- El agente y el código del curso solo actúan sobre su curso.
- Ninguna quita ni cambio de rol pedido por el agente se ejecuta sin la aprobación del profesor desde la interfaz, con su sesión.
- Nadie usa tokens personales: no se crean, no se listan y los que quedaron en la base no sirven.
- Las APIs internas (API para cursos y escucha de espacios) no se alcanzan desde fuera del servidor: escuchan solo en las direcciones internas de Docker (fases 2 y 3), nunca en `0.0.0.0` ni en una dirección pública, y Caddy solo reenvía a la escucha principal. En la escucha principal, `/api/curso/*` responde `404` aunque el token de curso sea válido.

## 11. Pruebas

Todas en `pruebas/tramo-acciones-y-cupos/`, con ayudantes en `lib.ts` y `fixtures.ts`, que reusan `pruebas/comun/`, `pruebas/fase-2/lib/`, `pruebas/fase-3/` (núcleo con espacio y modelo falso) y `pruebas/tramo-inhabilitar/` (núcleo sin Docker y sus datos). Las que usan el agente lo hacen con Claude Code real dentro del espacio real y el modelo falso con guiones: el agente escribe un script que usa `@campusia/sdk` y lo corre con `node`, como lo haría con un pedido real.

| Archivo | Docker | Qué prueba |
|---|---|---|
| `sdk.test.mjs` | no | Métodos nuevos del SDK con un `fetch` falso: rutas, cuerpos, base64 del SIU, `CAMPUSIA_TOKEN_AGENTE`, errores nuevos con `emails`; versión 0.3.0 en la plantilla y su lockfile; `CLAUDE.md` de la plantilla y del espacio; `campusia-agente` y el shell del agente conservan `CAMPUSIA_TOKEN_AGENTE`; variables nuevas en `campusia.env.ejemplo` |
| `aceptacion/acciones.spec.ts` | sí | El profesor pide inscribir alumnos de un listado (mails y SIU) y quedan inscriptos; código; pide quitar a uno y aparece la confirmación, que se aprueba; cambio de rol por el dueño; rechazo; auditoría con el profesor y la marca del agente; lecturas con el token del curso; instrucciones en `CLAUDE.md` |
| `aceptacion/interfaz-acciones.spec.ts` | sí | Confirmación en el panel Editar (confirmar y cancelar); cupo restante, aviso del 80 % y cupo agotado en el panel Editar |
| `aceptacion/cupos.spec.ts` | no | El owner asigna, el administrador reparte (predeterminado y excepciones) con reserva; vistas del owner y del administrador; migración del límite en USD por `sembrar`; pestañas Cupos de la interfaz |
| `aceptacion/consumo.spec.ts` | sí | Cada pedido descuenta tokens del profesor y de la universidad; el agente descuenta al profesor que pide; vista del profesor; aviso del 80 % sin mails; corte al agotarse (profesor y universidad); subir el cupo habilita; suscripción sin uso disponible |
| `aceptacion/sesiones.spec.ts` | no | Menú de perfil sin tokens ni "Cerrar las demás sesiones"; el owner ve las sesiones de una persona (dispositivo, IP, último uso) y las cierra, por API y por interfaz |
| `ataque/acciones.spec.ts` | sí | El agente de un curso intentando actuar sobre otro; un profesor no dueño agregando profesores o cambiando roles; quitas sin confirmación; aprobar por otro o dos veces; el token del agente fuera de su ejecución, en otras escuchas o en la plataforma; el token del curso escribiendo |
| `ataque/tokens.spec.ts` | no | Tokens personales viejos (en la base) y rutas eliminadas; `Authorization` nunca cae a la cookie ni saltea el origen; sesiones de otra persona para quien no es owner |
| `ataque/cupos.spec.ts` | no | Administrador asignando el cupo de otra universidad, el de la universidad o más del total; valores inválidos; profesores y alumnos en rutas de cupos; campos de más |
| `ataque/consumo.spec.ts` | sí | Superar el cupo del profesor o de la universidad sin reenviar; pedidos en paralelo; encabezados del cliente que intentan atribuir el uso a otro |
| `ataque/red.spec.ts` | sí | La API para cursos y la escucha de espacios no se alcanzan desde las direcciones externas de la máquina; `/api/curso/*` en la escucha principal; Caddy solo reenvía a la escucha principal |

## 12. Cambios en las pruebas anteriores (2026-11-10)

Este tramo elimina los tokens personales, "Cerrar las demás sesiones" y el límite en USD. Las pruebas anteriores que probaban esas funciones se quitan, y las que las usaban de paso se ajustan sin cambiar lo que verifican:

- Se borran `pruebas/fase-1/aceptacion/tokens.spec.ts`, `pruebas/fase-1/ataque/tokens.spec.ts` y `pruebas/fase-3/ataque/limite.spec.ts` (sus reemplazos son `ataque/tokens.spec.ts`, `ataque/cupos.spec.ts` y `ataque/consumo.spec.ts` de este tramo).
- Se quitan las pruebas: fase 1 `aceptacion/administrador.spec.ts` "cambia el límite mensual de uso del agente", `aceptacion/interfaz-cuenta.spec.ts` "crea un token desde el menú de perfil..." y "cierra las demás sesiones desde el menú de perfil...", `aceptacion/login.spec.ts` "cerrar las demás sesiones deja solo la actual", `ataque/dominios.spec.ts` "tampoco con un token de admin:escribir", `ataque/permisos.spec.ts` "los identificadores numéricos de otra persona no dan acceso a sus tokens", `ataque/sesiones.spec.ts` "cerrar las demás sesiones no deja vivas las robadas", el bloque "modo sesion: tokens personales" de `ataque/reautenticacion-sesion.spec.ts`; fase 2 `aceptacion/cursos.spec.ts` "un token con cursos:escribir crea cursos sin cookie ni Origin"; fase 3 `ataque/permisos.spec.ts` "un token personal necesita el permiso justo..."; fase 4 `aceptacion/archivos.spec.ts` "un token personal con cursos:escribir sube...", `aceptacion/entregas-notas.spec.ts` "todo se puede hacer por la API con tokens personales", `aceptacion/estado.spec.ts` "un token de owner con owner:leer lo lee", `ataque/datos-permisos.spec.ts` "los permisos del token se respetan".
- Se ajustan, quitando solo la parte de tokens, de `cerrar-otras` o del límite en USD: `fase-1/rutas.ts` (sin `/api/tokens`, `cerrar-otras` ni `/api/admin/limite`); fase 1 `aceptacion/interfaz.spec.ts` (Configuración sin `#limite`), `aceptacion/produccion.spec.ts`, `ataque/origen.spec.ts`, `ataque/sesiones.spec.ts` (usan `/api/logout` o `/api/admin/dominios` donde usaban `cerrar-otras` o `/api/admin/limite`), `aceptacion/reautenticacion-sesion.spec.ts`, `ataque/reautenticacion-sesion.spec.ts`, `ataque/reautenticacion.spec.ts`, `ataque/permisos.spec.ts`, `ataque/vencimientos-sesion.spec.ts`; fase 2 `aceptacion/cursos.spec.ts`, `ataque/codigos-curso.spec.ts`, `ataque/enrutador.spec.ts`, `ataque/inscripciones.spec.ts`, `ataque/subdominios.spec.ts`, `ataque/token-curso.spec.ts` (los tokens personales de ataque pasan a ser valores `cia_` inventados); fase 3 `aceptacion/interfaz.spec.ts` (el error del chat por cupo agotado en lugar del límite en USD), `ataque/intermediario.spec.ts`, `ataque/permisos.spec.ts`; fase 4 `aceptacion/estado.spec.ts`, `ataque/datos-permisos.spec.ts`, `ataque/endurecimiento.spec.ts`, `lib/datos.ts`.
- Tramo inhabilitar: `lib.ts` `tokenPersonal` ya no crea el token por la API (que no existe) sino que lo deja en `tokens_api` como un token viejo; las pruebas que esperaban que un token sirviera ahora esperan `401`, y las que esperaban `403 requiere_sesion` con un token esperan `401 no_autenticado`; `GET /api/tokens` sale de las rutas de lectura de `ataque/sesiones.spec.ts`; en `ataque/cursos.spec.ts` se quita "inscribir con token" y las lecturas con token de un alumno.

## Cambios en las pruebas (2026-11-10, corrección)

- `pruebas/tramo-inhabilitar/aceptacion/roles.spec.ts` "administra dos universidades distintas desde la misma sesión": usaba `PUT /api/admin/limite?universidad=B`, que la sección 6 elimina (`404`). Se reemplaza ese paso por `PUT /api/admin/cupos/predeterminado?universidad=B` (sección 7.2), que verifica lo mismo: el owner cambia la configuración de la universidad B sin tocar la A.
- `pruebas/tramo-inhabilitar/ataque/roles.spec.ts` "las sesiones viejas de un owner quitado no sirven, ni revividas en la base": la petición con el token personal revivido esperaba `403`; por la sección 6 y la sección 12 (las que usaban tokens esperan `401`) ahora espera `401 no_autenticado`. Las demás peticiones siguen esperando `403`.
