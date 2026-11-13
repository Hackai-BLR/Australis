# Contrato del tramo: inhabilitar cuentas, universidades y cursos

_Escrito: 2026-11-10. Referencias: `CONVENCIONES.md`, `handoffs/261110_0400_plan-implementacion-plataforma.md`, `contratos/fase-1.md`, `contratos/fase-2.md`, `contratos/fase-4.md`, `contratos/identidad-cursos.md`, `.orquestacion/tramo-inhabilitar.md` y `prototipo/campus.html`._

Este contrato es la fuente de verdad para implementar el tramo. Las pruebas de `pruebas/tramo-inhabilitar/` lo verifican. Si algo de acá no coincide con una prueba, manda la prueba y se avisa en el handoff. Las pruebas no se cambian para que pasen. Todo lo de las fases 1, 2 y 4 sigue vigente salvo lo que este contrato cambia explícitamente.

Principio: nada se borra. Las cuentas se suspenden, las universidades se deshabilitan y los cursos se archivan; todo se puede revertir y se conservan la historia, las inscripciones quitadas, las entregas, las notas, los archivos, las versiones y la auditoría.

## 1. Módulos y carpetas

| Módulo | Carpetas | Qué entrega |
|---|---|---|
| Núcleo | `nucleo/` | Migración `5001_inhabilitar.sql`; módulo nuevo `inhabilitar.rs` (rutas de suspender, reactivar, dar de baja, deshabilitar, rehabilitar, archivar, desarchivar y transferir por el administrador); controles de estado en la autenticación, el login, el enrutador, la API para cursos, el supervisor y las rutas que modifican un curso; campos nuevos en las respuestas existentes |
| Interfaz | `interfaz/` | Estado y acciones en Administrador › Personas y › Cursos, en Owner › Universidades, archivar desde el menú del curso, cursos archivados en Mis cursos y en la barra, modal de confirmación |

Cada módulo toca solo sus carpetas. Nadie toca `pruebas/`, `contratos/`, `prototipo/`, `handoffs/`, `.orquestacion/`, `sdk/`, `plantilla-curso/` ni `despliegue/`. El handoff lo escribe el workflow al terminar.

Convivencia con la fase 3 (corre al mismo tiempo en otra rama sobre núcleo e interfaz):
- La migración nueva usa el prefijo `5xxx`. Las anteriores no se modifican.
- El código nuevo del núcleo va en módulos propios (`inhabilitar.rs` y, si hace falta, `estado_cuenta.rs`). En los archivos compartidos (`main.rs`, `servidor.rs`, `auth.rs`, `login.rs`, `enrutador.rs`, `supervisor.rs`, `cursos.rs`, `admin.rs`, `owner.rs`, `cuenta.rs`, `api_cursos.rs`, `archivos.rs`, `registros.rs`) solo se agregan las rutas, una llamada a una función de control y los campos nuevos de las respuestas, sin reordenar ni reescribir lo existente.
- Los controles de "curso archivado" y "universidad deshabilitada" se exponen como funciones (por ejemplo `inhabilitar::curso_modificable(&db, id) -> Result<(), Error>` y `inhabilitar::curso_servible(&db, id)`) para que las rutas de la fase 3 (editar con el agente, publicar, versiones, `-prueba`) las llamen al unirse.
- En la interfaz, los componentes nuevos van en archivos propios (`Inhabilitar.tsx`, `Confirmar.tsx`) y en las pantallas existentes solo se agregan columnas, botones y el ítem del menú.
- Las pruebas no corren `docker system prune` ni borran imágenes, contenedores o redes que no sean de sus propios prefijos.

## 2. Compilar, levantar y probar

### Compilar

Igual que la fase 4:

```bash
. "$HOME/.cargo/env"
cargo build --manifest-path nucleo/Cargo.toml
pnpm --dir interfaz install && pnpm --dir interfaz run build
pnpm --dir sdk install && pnpm --dir sdk run build
rm -f plantilla-curso/vendor/campusia-sdk-*.tgz && pnpm --dir sdk pack --pack-destination plantilla-curso/vendor
```

### Levantar en desarrollo

Igual que la fase 4, con los datos del tramo:

```bash
export DATABASE_URL=sqlite:///tmp/campusia/datos/campusia.db DOMINIO_BASE=campusia.prueba ENTORNO=desarrollo \
  PROVEEDOR_EMAIL=archivo ARCHIVO_EMAIL=/tmp/campusia/mails.jsonl SESSION_SECRET=$(openssl rand -hex 32) \
  TURNSTILE_SITE_KEY=1x00000000000000000000AA TURNSTILE_SECRET=1x0000000000000000000000000000000AA \
  INTERFAZ_DIR=$PWD/interfaz/dist EMAIL_FROM=no-responder@campusia.prueba \
  PROVEEDOR_CONTENEDORES=docker RAIZ_CURSOS=/tmp/campusia/cursos PLANTILLA_CURSO_DIR=$PWD/plantilla-curso SDK_DIR=$PWD/sdk \
  RAIZ_ARCHIVOS=/tmp/campusia/archivos DIR_RESPALDOS=/tmp/campusia/respaldos
mkdir -p /tmp/campusia/datos
nucleo/target/debug/campusia-nucleo migrar
nucleo/target/debug/campusia-nucleo sembrar pruebas/tramo-inhabilitar/datos.json
nucleo/target/debug/campusia-nucleo crear-owner equipo@campusia.prueba
nucleo/target/debug/campusia-nucleo
```

### Probar

```bash
bash pruebas/tramo-inhabilitar/correr.sh
```

Corre, desde cero y sin pasos manuales, y sigue aunque una parte falle (termina con código distinto de 0 si alguna falló):

1. Las pruebas del tramo con Playwright (`pruebas/tramo-inhabilitar/playwright.config.ts`, que reusa la configuración común, el `globalSetup` que compila núcleo, interfaz y SDK y el `globalTeardown` que borra las imágenes de los prefijos de la corrida).
2. `pruebas/fase-4/correr.sh`, que corre los tramos de plantilla y SDK y de resguardo y todas las carpetas `pruebas/fase-*/` (fases 1, 2 y 4, y la 3 cuando se una).

Con argumentos (`bash pruebas/tramo-inhabilitar/correr.sh ataque/permisos.spec.ts`) o con `SOLO_TRAMO=1`, corre solo las pruebas del tramo con esos argumentos de Playwright. `CAMPUSIA_SIN_COMPILAR=1` y `PRUEBAS_WORKERS` funcionan como en las fases anteriores.

Requisitos de la máquina: los de la fase 4 (Docker sin sudo, `node:22-alpine`, `caddy:2.8.4`, `git`, Node 22, pnpm, Rust, `sqlite3`, `tar`, `gzip`, `sha256sum`, `flock`).

Cada worker levanta su propio núcleo con `pruebas/tramo-inhabilitar/datos.json`. Las pruebas sin contenedores usan `PROVEEDOR_CONTENEDORES=ninguno`; las que necesitan un curso real (`aceptacion/contenedores.spec.ts` y `ataque/contenedores.spec.ts`) usan Docker con un prefijo propio por núcleo, como la fase 2. Para no depender de Docker, algunas pruebas agregan cursos de prueba directamente en la base (`INSERT INTO cursos (id, nombre, periodo, color, universidad_id, version_publicada, creado_en)` e `INSERT INTO inscripciones`): esos cursos quedan con `estado = 'sin_repo'` y sirven la página provisoria. Por eso toda columna nueva de `cursos`, `usuarios`, `universidades` o `inscripciones` tiene que ser `NULL` o tener valor por defecto.

## 3. Variables de entorno

No hay variables nuevas. Agregada en la integración con la fase 3: `ESPERA_CODIGO_INICIAL_MS` (ver "Cambios").

## 4. Modelo de datos

Migración nueva `nucleo/migraciones/5001_inhabilitar.sql`. Las columnas marcadas con * las leen o escriben las pruebas.

```sql
ALTER TABLE usuarios ADD COLUMN suspendida_en* TEXT NULL;          -- RFC 3339 UTC; NULL = no suspendida
ALTER TABLE usuarios ADD COLUMN suspendida_por INTEGER NULL REFERENCES usuarios(id);
ALTER TABLE usuarios ADD COLUMN baja_en* TEXT NULL;                -- dada de baja de la universidad
ALTER TABLE universidades ADD COLUMN deshabilitada_en* TEXT NULL;
ALTER TABLE cursos ADD COLUMN archivado_en* TEXT NULL;
ALTER TABLE cursos ADD COLUMN archivado_por INTEGER NULL REFERENCES usuarios(id);

inscripciones_historia(id* INTEGER PK,
                       curso_id* TEXT NOT NULL,
                       usuario_id* INTEGER NOT NULL,
                       rol* TEXT NOT NULL,
                       creada_en TEXT NOT NULL,            -- la de la inscripción original
                       quitada_en TEXT NOT NULL,
                       motivo* TEXT NOT NULL CHECK (motivo IN ('baja','desinscripcion')),
                       actor_id INTEGER NULL)
```

- `inscripciones_historia` es de solo agregado: triggers `BEFORE UPDATE` y `BEFORE DELETE` con `RAISE(ABORT, ...)`, como `auditoria`.
- Dar de baja copia cada inscripción de la persona a `inscripciones_historia` con `motivo = 'baja'` y la borra de `inscripciones`, en una sola transacción. La desinscripción de la fase 2 puede (no está obligada) copiar con `motivo = 'desinscripcion'`.
- Reactivar pone `suspendida_en`, `suspendida_por` y `baja_en` en `NULL`. No devuelve las inscripciones ni los tokens revocados.
- Nada de este tramo borra filas de `usuarios`, `universidades`, `cursos`, `entregas`, `notas`, `archivos` ni `auditoria`.

Estado de una cuenta (derivado):
- `suspendida` si `suspendida_en` no es `NULL`;
- si no, `pendiente` si `pendiente = 1`;
- si no, `activa`.

Una cuenta está **inhabilitada** si está suspendida, o si no es owner (`owner = 0`) y su universidad tiene `deshabilitada_en` no `NULL`. Un owner nunca queda inhabilitado por su universidad (sí por una suspensión).

Un curso está **archivado** si `archivado_en` no es `NULL`. Un curso está **fuera de servicio** si está archivado o si su universidad está deshabilitada.

## 5. Reglas generales

Siguen las de la fase 1: JSON, errores `{"error","mensaje"}`, `Cache-Control: no-store`, `Origin` y `X-Campusia: 1` en las modificaciones con cookie, y el orden de los controles (host, origen, autenticación, `requiere_sesion`, `permiso_del_token`, rol, reautenticación, validación, alcance, conflictos).

Códigos de error nuevos:
- 409: `propia_cuenta` (actuar sobre la propia cuenta), `curso_archivado` (modificar un curso archivado), `universidad_deshabilitada` (invitar o crear cuentas en una universidad deshabilitada), `cuenta_suspendida` (transferir un curso a una cuenta inhabilitada).
- Se reusan `es_dueno` (409, agrega `cursos`: lista de ids), `no_es_profesor`, `datos_invalidos`, `prohibido`, `no_encontrado`, `reautenticacion_requerida`, `requiere_sesion`.

### Autenticación con una cuenta inhabilitada

- Toda sesión (cookie) o token personal cuya persona está inhabilitada se trata como inválida: `401 no_autenticado` en todas las rutas de `/api/*`, aunque la sesión no figure como revocada en la base o el token no esté revocado. El control se hace contra la base en cada petición.
- El enrutador `-curso` y la barra no emiten identidad para una cuenta inhabilitada (sección 8).

### Login

- `POST /api/login/codigo` responde exactamente lo mismo (estado, cuerpo, sin cookies) para una cuenta suspendida, una cuenta de una universidad deshabilitada, un mail nuevo de un dominio de una universidad deshabilitada, una cuenta activa y un mail inexistente. Para las cuentas inhabilitadas y los mails nuevos de universidades deshabilitadas no manda mail, no crea código válido y no crea cuentas. Cuenta igual para los límites por mail y por IP.
- Un owner siempre recibe su código, aunque su universidad esté deshabilitada (no si está suspendido).
- La respuesta tampoco se distingue por el tiempo ni por la caída del proveedor de mails: cuando no se emite código, el núcleo espera lo que tarda en promedio una emisión real (con una variación al azar) y, si el último envío real falló, responde `503 servicio_no_disponible` igual que para una cuenta activa.
- `POST /api/login/verificar` con cualquier código de una cuenta inhabilitada responde `400 codigo_invalido` y no crea sesión. Al suspender una cuenta o deshabilitar una universidad, los códigos vigentes (login y reautenticación) de esas cuentas quedan anulados.

## 6. Rutas de la API

En las tablas: **Token** es el permiso que necesita un token personal (o "solo sesión"), **Reaut** si exige reautenticación. Todas las rutas nuevas son solo sesión y con reautenticación: con un token responden `403 requiere_sesion`; sin reautenticación, `403 reautenticacion_requerida`, sin cambiar nada.

### Cuentas

| Método y ruta | Quién | Token | Reaut | Cuerpo | Respuesta |
|---|---|---|---|---|---|
| `POST /api/admin/personas/{id}/suspender` | administrador, sobre su universidad | solo sesión | sí | `{}` | `200 Persona` |
| `POST /api/admin/personas/{id}/reactivar` | administrador, sobre su universidad | solo sesión | sí | `{}` | `200 Persona` |
| `POST /api/admin/personas/{id}/baja` | administrador, sobre su universidad | solo sesión | sí | `{"confirmar": true}` | `200 Persona` |
| `POST /api/owner/personas/{id}/suspender` | owner, sobre cualquiera | solo sesión | sí | `{}` | `200 Persona` |
| `POST /api/owner/personas/{id}/reactivar` | owner, sobre cualquiera | solo sesión | sí | `{}` | `200 Persona` |
| `POST /api/owner/personas/{id}/baja` | owner, sobre cualquiera con universidad | solo sesión | sí | `{"confirmar": true}` | `200 Persona` |

Orden de los controles, además de los generales:
1. Rol: las rutas `/api/admin/...` solo para `administrador = 1`, o para un owner que indica la universidad con `?universidad=<id>` (sección 6.1); sin ese parámetro un owner que no es administrador recibe `403 prohibido`, como el resto. Las `/api/owner/...` solo para `owner = 1` (resto `403 prohibido`).
2. Reautenticación.
3. Cuerpo: en `baja`, `confirmar` tiene que ser exactamente `true`; si no, `400 datos_invalidos`.
4. Alcance: la persona no existe, o (administrador) no es de su universidad: `404 no_encontrado`. Un `id` que no es un entero: `404` o `400`.
5. Propia cuenta: `409 propia_cuenta`.
6. Destino protegido (solo administrador que no es owner): si la persona es owner o administrador, `403 prohibido`. Eso lo hace el owner.
7. Conflictos: en `baja`, si la persona es dueña de algún curso, `409 es_dueno` con `cursos` (los ids) y no cambia nada; hay que transferirlos antes.

Efectos de **suspender** (idempotente: suspender una cuenta ya suspendida responde 200 y no cambia `suspendida_en`):
- `suspendida_en` = ahora, `suspendida_por` = quien suspende.
- Revoca todas sus sesiones (`sesiones.revocada = 1`) y todos sus tokens personales (`tokens_api.revocado = 1`). Anula sus códigos vigentes.
- No puede pedir ni usar códigos (sección 5).
- El enrutador no le emite identidad para ningún curso.
- Deja de contar como inscripto activo (sección 7). Sus inscripciones se conservan.
- Si es dueña de cursos, esos cursos siguen funcionando para los demás, y el administrador de su universidad (o el dueño, si vuelve) puede transferirlos.
- Auditoría `cuenta_suspendida`.

Efectos de **reactivar** (idempotente): `suspendida_en`, `suspendida_por` y `baja_en` vuelven a `NULL`. Puede volver a entrar con un código nuevo; sus inscripciones que se conservaron vuelven a contar. Los tokens y las sesiones revocadas siguen revocados. Auditoría `cuenta_reactivada`.

Efectos de **dar de baja**: suspende (todo lo de arriba), pone `baja_en` = ahora y quita todas sus inscripciones, copiándolas a `inscripciones_historia` con `motivo = 'baja'`. Auditoría `baja_universidad` (y no hace falta registrar además `cuenta_suspendida`).

`Persona` (de la fase 1) agrega `"estado": "activa"|"suspendida"|"pendiente"` y `"baja": bool`.

`GET /api/admin/personas` acepta además `estado=todas|activas|suspendidas|pendientes` (por defecto `todas`; otro valor: `400 datos_invalidos`), combinable con `buscar` y `filtro`.

### Transferir el curso de otra persona

| Método y ruta | Quién | Token | Reaut | Cuerpo | Respuesta |
|---|---|---|---|---|---|
| `POST /api/admin/cursos/{id}/transferir` | administrador de la universidad del curso | solo sesión | sí | `{"usuario_id"}` | `200 {"dueno":{"id","nombre","email"}}` |

- El curso tiene que ser de su universidad (`404`). `usuario_id` tiene que ser una persona de esa universidad (`404`), con marca de profesor (`400 no_es_profesor`) y no inhabilitada (`409 cuenta_suspendida`).
- Si la persona no estaba inscripta, queda inscripta como `dueño`; si estaba (con cualquier rol), su inscripción pasa a `dueño`. El dueño anterior queda `profesor`, aunque esté suspendido.
- Funciona también con el curso archivado. Auditoría `curso_transferido`.

### Universidades

| Método y ruta | Quién | Token | Reaut | Cuerpo | Respuesta |
|---|---|---|---|---|---|
| `POST /api/owner/universidades/{id}/deshabilitar` | owner | solo sesión | sí | `{}` | `200 UniversidadOwner` |
| `POST /api/owner/universidades/{id}/rehabilitar` | owner | solo sesión | sí | `{}` | `200 UniversidadOwner` |

`404` si la universidad no existe. Las dos son idempotentes.

Efectos de **deshabilitar**:
- `deshabilitada_en` = ahora.
- Todas sus cuentas que no son owner quedan inhabilitadas: se revocan sus sesiones y se anulan sus códigos. Sus tokens personales no se revocan, pero responden `401` mientras la universidad esté deshabilitada.
- No se crean cuentas nuevas con sus dominios: ni por login, ni por invitación, ni por inscripción. `POST /api/owner/universidades/{id}/administradores` responde `409 universidad_deshabilitada`.
- Sus cursos quedan fuera de servicio: el núcleo detiene sus contenedores (en segundo plano, en menos de 30 s), no los vuelve a encender por visitas ni al arrancar, y el enrutador no sirve su contenido. La API para cursos rechaza sus tokens de curso (`401`).
- Auditoría `universidad_deshabilitada`.

Efectos de **rehabilitar**: `deshabilitada_en` vuelve a `NULL`. Las cuentas que no estaban suspendidas pueden volver a entrar con un código nuevo (las sesiones revocadas siguen revocadas) y sus tokens no revocados vuelven a funcionar. Los cursos que no están archivados se vuelven a encender con la primera visita. Auditoría `universidad_rehabilitada`.

`UniversidadOwner` (de la fase 1) agrega `"deshabilitada": bool`.

### Cursos

| Método y ruta | Quién | Token | Reaut | Cuerpo | Respuesta |
|---|---|---|---|---|---|
| `POST /api/cursos/{id}/archivar` | dueño del curso | solo sesión | sí | `{}` | `200 Curso` |
| `POST /api/cursos/{id}/desarchivar` | dueño del curso | solo sesión | sí | `{}` | `200 Curso` |
| `POST /api/admin/cursos/{id}/archivar` | administrador de la universidad del curso | solo sesión | sí | `{}` | `200 CursoAdmin` |
| `POST /api/admin/cursos/{id}/desarchivar` | administrador de la universidad del curso | solo sesión | sí | `{}` | `200 CursoAdmin` |

- En `/api/cursos/{id}/...`: no inscripto (aunque sea administrador u owner) o curso inexistente, `404`; profesor o alumno del curso, `403 prohibido` (antes de la reautenticación). Un dueño suspendido no llega acá (`401`).
- En `/api/admin/cursos/{id}/...`: no administrador, `403 prohibido`; curso de otra universidad o inexistente, `404`.
- Las dos son idempotentes.

Efectos de **archivar**:
- `archivado_en` = ahora, `archivado_por` = quien archiva.
- El contenedor del curso se detiene (en segundo plano, en menos de 30 s) y no se vuelve a encender: ni por visitas, ni por la revisión de inactividad, ni al arrancar el núcleo, ni por `reintentar`. Lo mismo para el espacio de trabajo y la versión de prueba de la fase 3.
- La revisión periódica del supervisor (cada `REVISION_INACTIVIDAD_SEG`) detiene cualquier contenedor de un curso fuera de servicio que encuentre corriendo, aunque lo haya encendido alguien desde afuera del núcleo.
- El enrutador no sirve su contenido (sección 8). La API para cursos rechaza su token de curso (`401`).
- No se puede modificar: estas rutas responden `409 curso_archivado` (después de los controles de rol y de reautenticación de cada una, antes de validar el cuerpo) y no cambian nada: `POST /api/cursos/{id}/inscriptos`, `POST /api/cursos/{id}/inscriptos/siu`, `PUT` y `DELETE /api/cursos/{id}/inscriptos/{usuario_id}`, `POST` y `PUT /api/cursos/{id}/codigo`, `POST /api/cursos/{id}/reintentar`, `POST /api/cursos/{id}/archivos`, `POST /api/cursos/{id}/entregas`, `POST /api/cursos/{id}/notas`, y las de la fase 3 (editar, publicar, volver a una versión). `POST /api/unirse` con el código de un curso archivado responde `400 codigo_invalido`, igual que un código inexistente.
- Se puede transferir (fase 2 y la ruta del administrador).
- No aparece en Mis cursos de los alumnos ni en el selector de la barra de los alumnos. Para un alumno, `GET /api/cursos/{id}` y las demás rutas del curso responden `404`. Dueño y profesores lo siguen viendo en Mis cursos y en `GET /api/cursos/{id}`, marcado como archivado, y pueden leer inscriptos, entregas, notas, historial y archivos.
- Auditoría `curso_archivado`.

Efectos de **desarchivar**: `archivado_en` y `archivado_por` vuelven a `NULL`; el curso vuelve a aparecer y se enciende con la primera visita (como un curso apagado). Auditoría `curso_desarchivado`.

### 6.1 Agregados del alcance (10:55, 11:00 y 11:15)

#### El owner como administrador de cualquier universidad

- Todas las rutas `/api/admin/*` (personas, profesores, invitaciones, cursos, dominios, límite, auditoría, suspender, reactivar, dar de baja, archivar, desarchivar y transferir) aceptan el parámetro de consulta `?universidad=<id>`.
- Owner: con `?universidad=<id>` actúa sobre esa universidad con todos los permisos del administrador. Si la universidad no existe o el id no es un entero: `404 no_encontrado`. Sin el parámetro, si además es administrador de su universidad actúa sobre la suya; si no, `403 prohibido`.
- Administrador: sin el parámetro o con el id de su universidad, sobre la suya. Con cualquier otro valor: `404 no_encontrado`, sin cambios.
- Cualquier otra cuenta (común, profesor) con o sin el parámetro: `403 prohibido`.
- Un owner que actúa como administrador puede suspender, reactivar y dar de baja también a administradores y owners de esa universidad (la regla de "destino protegido" es solo para administradores que no son owner). Nadie actúa sobre su propia cuenta (`409 propia_cuenta`).
- Auditoría: igual que la del administrador, con el owner como `actor_id` y la universidad indicada como `universidad_id`.

#### Quitar administradores

| Método y ruta | Quién | Token | Reaut | Cuerpo | Respuesta |
|---|---|---|---|---|---|
| `DELETE /api/owner/universidades/{id}/administradores/{usuario_id}` | owner | solo sesión | sí | — | `200 UniversidadOwner` |

- No owner: `403 prohibido` (incluido cualquier administrador). Universidad inexistente, o persona que no es administradora de esa universidad: `404 no_encontrado`.
- Último administrador: si la universidad está activa y no queda otro administrador no suspendido, `409 ultimo_administrador` y no cambia nada. Con la universidad deshabilitada se puede quitar.
- Efectos: `administrador = 0` (la cuenta sigue activa como cuenta común o profesor); se revocan todas sus sesiones y los tokens personales con permisos `admin:*` u `owner:*`. Auditoría `administrador_quitado` con la universidad y el mail.

#### Poner y quitar owners

| Método y ruta | Quién | Token | Reaut | Cuerpo | Respuesta |
|---|---|---|---|---|---|
| `GET /api/owner/owners` | owner | `owner:leer` | no | — | `200 {"owners": [Owner]}` |
| `POST /api/owner/owners` | owner | solo sesión | sí | `{"email"}` | `201 Owner` (cuenta nueva) o `200 Owner` (cuenta existente o ya owner) |
| `DELETE /api/owner/owners/{id}` | owner | solo sesión | sí | — | `200 {"owners": [Owner]}` |

`Owner`: `{"id","email","nombre","pendiente","estado","universidad"}` (`universidad` es el nombre o `null`).

- No owner: `403 prohibido`. Mail inválido: `400 email_invalido`.
- Dar el rol: a una cuenta existente le pone `owner = 1`; si el mail no tiene cuenta, la crea pendiente con `owner = 1` (con la universidad de su dominio, si hay) y le manda una invitación. Auditoría `owner_agregado`.
- Quitar el rol: persona inexistente o que no es owner, `404`. Si no queda otro owner no suspendido, `409 ultimo_owner` (vale también para quitarse a uno mismo). Efectos: `owner = 0`; se revocan todas sus sesiones y los tokens con permisos `admin:*` u `owner:*`. Auditoría `owner_quitado`.
- Línea de comandos: `campusia-nucleo quitar-owner <email>` con la misma regla del último owner (sale con código distinto de 0 y no cambia nada si es el último o si no es owner). `campusia-nucleo crear-owner <email>` además levanta la suspensión (`suspendida_en`, `suspendida_por` y `baja_en` en `NULL`) para recuperar el acceso desde el servidor.

#### Interfaz de los agregados

- Owner › Universidades: en la columna Administradores, cada administrador lleva `[data-quitaradmin="<usuario_id>"]` ("Quitar"), con confirmación (`[data-confirmar]` "Quitar") y reautenticación. Cada fila lleva además `[data-administrar="<id>"]` ("Administrar"), que abre `/administracion?universidad=<id>`.
- Owner › pestaña `[data-otab="owners"]` ("Owners"): tabla con filas `tr[data-owner="<id>"]`, botón `[data-accion="invitar-owner"]` que abre un modal con `#o-mail` y `[data-invok="owner"]`, y por fila `[data-quitarowner="<id>"]` ("Quitar") con confirmación y reautenticación.
- Administración para el owner: arriba del panel, `select#selector-universidad` con todas las universidades; cambiarla recarga el panel sobre la elegida sin salir de la cuenta. El menú de perfil del owner tiene "Administración" (`[data-accion="administracion"]`).
- En Personas, cuando el que mira es owner, las acciones suspender, reactivar y dar de baja aparecen también en las filas de administradores y owners (nunca en la propia) y usan las rutas `/api/owner/personas/...`.
- Administrador › Cursos: además de archivar, cada fila lleva `[data-transferir="<id>"]` ("Transferir"), que abre un modal con `select#transferir-a` (profesores activos de la universidad) y `[data-confirmar]` ("Transferir"); llama a `POST /api/admin/cursos/{id}/transferir`.

### Campos nuevos en respuestas existentes

| Respuesta | Campo nuevo |
|---|---|
| `Curso` (`GET /api/cursos/{id}`, `POST /api/cursos`) | `"archivado": bool` |
| `GET /api/mis-cursos`, cada curso | `"archivado": bool` (los alumnos nunca reciben uno en `true`) |
| `GET /api/admin/cursos`, cada curso (`CursoAdmin`) | `"archivado": bool` |
| `Inscripto` (`GET /api/cursos/{id}/inscriptos`) | `"suspendida": bool` |
| `Persona` | `"estado"`, `"baja"`, `"owner": bool` |
| `UniversidadOwner` | `"deshabilitada": bool` |

## 7. Inscripto activo

Una inscripción cuenta como **activa** si la persona no está inhabilitada. Las inactivas:
- siguen apareciendo en `GET /api/cursos/{id}/inscriptos` con `"suspendida": true`, pero no cuentan en `alumnos` ni en `profesores`;
- no cuentan en `profesores` ni en `alumnos` de `GET /api/admin/cursos`;
- no aparecen en `GET /api/curso/inscriptos` de la API para cursos.

## 8. Enrutador

En `<id>-curso.DOMINIO_BASE`, el orden de la fase 2 queda así:

1. El curso no existe: 404.
2. Sin sesión válida (cookie revocada, vencida o inexistente): `401` en HTML, como en la fase 2.
3. Sesión no revocada de una cuenta inhabilitada (por ejemplo, una sesión que siguiera viva en la base): `403` en HTML, sin el nombre del curso. No se reenvía nada ni se firma identidad.
4. No inscripto: `403`, como en la fase 2.
5. Curso fuera de servicio (archivado o de una universidad deshabilitada): `403` en HTML con el texto "Curso archivado" o "Curso no disponible". No enciende el contenedor y no reenvía nada.
6. Lo demás sigue como en la fase 2 (origen, `preparando`, encendido, reenvío). Esto vale también para los cursos sembrados con la página provisoria.

En la barra (`<id>.DOMINIO_BASE`) la interfaz decide con `GET /api/cursos/{id}` (sección 9).

## 9. Interfaz

Reproduce el estilo del prototipo (`prototipo/campus.html`): las pastillas `.pill` (`verde`, `ambar`, `azul`), los botones `.btn sec chico`, el modal de `#velo`/`#modal` como en `modalInvitar` y `modalUni`, las tablas `.tabla` de `pintarAdmin` y `pintarOwner`, y el menú `#m-cursos` de `abrirCurso`. Los selectores nombrados son parte del contrato.

**Confirmación** (componente común): toda acción de este tramo abre primero un modal con un título que nombra la acción y a quién afecta (por ejemplo "¿Suspender a Tomás García?"), un texto corto con el efecto, `[data-cerrarmodal]` ("Cancelar") y `[data-confirmar]` (el verbo: "Suspender", "Reactivar", "Dar de baja", "Archivar", "Desarchivar", "Deshabilitar", "Rehabilitar"). Recién al confirmar se llama a la API; si responde `reautenticacion_requerida`, se abre el modal de reautenticación de la fase 1 (`#reaut-digitos`) y la acción se reintenta sola. Al terminar, la tabla o la pantalla se actualizan sin recargar la página y `#aviso` confirma la acción. Los errores (`409 es_dueno`, `403 prohibido`, ...) se muestran en `#aviso`.

**Administrador › Personas** (prototipo `pintarAdmin`, pestaña `personas`):
- Cada fila es `tr[data-persona="<id>"]`.
- Columna nueva "Estado" con una celda `td.estado` que tiene una pastilla con el texto "Activa" (`.pill.verde`), "Suspendida" (`.pill`) o "Pendiente" (`.pill.ambar`). Si la persona fue dada de baja, además la pastilla "Baja".
- Chips de estado `[data-estado="todas"]`, `[data-estado="activas"]`, `[data-estado="suspendidas"]` y `[data-estado="pendientes"]`, al lado de los de la fase 1; filtran la tabla (combinados con `#busca` y `[data-filtro]`).
- Acciones por fila, en una celda final: `[data-suspender="<id>"]` ("Suspender") si no está suspendida; `[data-reactivar="<id>"]` ("Reactivar") si está suspendida; `[data-baja="<id>"]` ("Dar de baja") si no fue dada de baja. Ninguna aparece en la fila propia ni en las de administradores u owners.

**Administrador › Cursos** (pestaña `cursos`):
- Cada fila es `tr[data-fila-curso="<id>"]`.
- La columna "Estado" muestra la pastilla "Archivado" si lo está (en lugar de "Publicado · vN" o "Sin publicar").
- Acción por fila: `[data-archivar="<id>"]` ("Archivar") o `[data-desarchivar="<id>"]` ("Desarchivar").

**Owner › Universidades** (prototipo `pintarOwner`, pestaña `unis`):
- Cada fila es `tr[data-universidad="<id>"]`. Si está deshabilitada, la pastilla "Deshabilitada" junto al nombre.
- Acción por fila, junto a `[data-invadmin]`: `[data-deshabilitar="<id>"]` ("Deshabilitar") o `[data-rehabilitar="<id>"]` ("Rehabilitar"). Con la universidad deshabilitada, `[data-invadmin]` no se muestra o está deshabilitado.

**Barra del curso** (prototipo `abrirCurso`, `#v-curso`):
- Para el dueño, `#m-cursos` agrega, después de la lista, `[data-accion="archivar-curso"]` ("Archivar curso") o, si está archivado, `[data-accion="desarchivar-curso"]` ("Desarchivar curso"). Profesores y alumnos no los ven.
- Con el curso archivado, dueño y profesores ven en la barra la pastilla `#curso-archivado` ("Archivado"), y en el lienzo, en lugar de `iframe#curso`, un aviso `.cargando` con "Curso archivado". No hay `iframe#curso`. `#publicar` y `[data-panel="p-agente"]` quedan deshabilitados u ocultos.
- Un alumno que entra a la barra de un curso archivado ve el aviso "No tenés acceso a este curso" de la fase 1 (la API le responde 404), sin iframe y sin el nombre del curso.

**Mis cursos** (prototipo `pintarCursos`): las tarjetas `[data-curso="<id>"]` de cursos archivados (solo dueños y profesores las reciben) llevan además la pastilla "Archivado" y van después de las demás.

## 10. Permisos

| Acción | Owner | Administrador | Dueño del curso | Profesor del curso | Alumno | Token |
|---|---|---|---|---|---|---|
| Suspender, reactivar o dar de baja una cuenta común o un profesor | sí, cualquiera | sí, solo de su universidad | no | no | no | no |
| Suspender, reactivar o dar de baja a un administrador u owner | sí | no (`403`) | no | no | no | no |
| Suspenderse a sí mismo | no (`409`) | no (`409`) | no | no | no | no |
| Deshabilitar o rehabilitar una universidad | sí | no | no | no | no | no |
| Archivar o desarchivar un curso | no | sí, de su universidad | sí | no (`403`) | no (`403`) | no |
| Transferir el curso de otra persona | no | sí, de su universidad, a un profesor activo | (fase 2) | no | no | no |

Reglas:
- Todo exige sesión reautenticada y queda en la auditoría, con `universidad_id` de la persona, universidad o curso afectado y un `detalle` que menciona el mail de la persona afectada, el nombre de la universidad o el id del curso. Acciones nuevas: `cuenta_suspendida`, `cuenta_reactivada`, `baja_universidad`, `universidad_deshabilitada`, `universidad_rehabilitada`, `curso_archivado`, `curso_desarchivado` (y `curso_transferido`, que ya existía).
- El estado nunca sale del cuerpo de una petición: campos como `suspendida`, `estado`, `archivado`, `deshabilitada`, `owner` o `administrador` en el cuerpo de cualquier ruta se ignoran.
- Un administrador no ve ni toca personas ni cursos de otra universidad (`404`).
- Ningún mensaje del login revela si una cuenta está suspendida o si su universidad está deshabilitada.

## 11. Pruebas

Todas en `pruebas/tramo-inhabilitar/`, con ayudantes en `lib.ts` y `fixtures.ts`, que reusan `pruebas/comun/` y `pruebas/fase-2/lib/`. Datos en `pruebas/tramo-inhabilitar/datos.json`: los de la fase 2 más Raúl Admin (`radmin@austral.edu.ar`, segundo administrador de la Austral) y Rocío Rectora (`rectora@austral.edu.ar`, owner con universidad Austral). Las pruebas que suspenden, dan de baja o deshabilitan usan cuentas, universidades y cursos nuevos de cada prueba para no afectar a las demás.

| Archivo | Qué prueba |
|---|---|
| `aceptacion/cuentas.spec.ts` | Suspender y reactivar (no entra, no ve cursos, sesiones y tokens revocados, vuelve a entrar); estado y filtro en Personas; inscripto inactivo en los conteos; dar de baja (inscripciones a la historia, `es_dueno`, confirmación); owner sobre un administrador; dueño suspendido con su curso funcionando y transferencia por el administrador; auditoría |
| `aceptacion/universidades.spec.ts` | Deshabilitar (ninguna cuenta entra, tokens rechazados, sin cuentas nuevas, sin invitaciones, contenido no servido, owners sí entran) y rehabilitar (vuelven a entrar, tokens vuelven a funcionar); auditoría |
| `aceptacion/cursos.spec.ts` | Archivar por el dueño y por el administrador; fuera de Mis cursos de los alumnos y marcado para los docentes; contenido no servido; datos conservados y legibles; desarchivar; auditoría |
| `aceptacion/contenedores.spec.ts` (Docker) | El contenedor de un curso archivado se detiene, no se enciende con visitas y vuelve al desarchivar; los cursos de una universidad deshabilitada se detienen y vuelven al rehabilitar; un curso con dueño suspendido sigue funcionando |
| `aceptacion/interfaz.spec.ts` | Personas (estado, filtro, suspender, reactivar y dar de baja con confirmación y reautenticación); Cursos (archivar y desarchivar); Universidades (deshabilitar y rehabilitar); archivar desde el menú del curso; Mis cursos y barra con un curso archivado |
| `ataque/permisos.spec.ts` | Administrador sobre otra universidad, sobre un owner, sobre otro administrador y sobre sí mismo; owner sobre sí mismo; alumno, profesor no dueño, no inscripto, otro administrador y owner archivando; rutas de owner por no owners; estado por el cuerpo; transferencias indebidas |
| `ataque/sesiones.spec.ts` | Sesiones y tokens viejos de una cuenta suspendida (también con la sesión revivida en la base); código pedido antes de suspender; pedido de código idéntico para cuentas suspendidas y de universidades deshabilitadas, sin mail; la identidad no se emite (403) |
| `ataque/reautenticacion.spec.ts` | Cada acción sin reautenticación, con token, sin `Origin` o sin `X-Campusia`: rechazada y sin cambios |
| `ataque/cursos.spec.ts` | Entrar a un curso archivado por su subdominio; modificar un curso archivado (inscribir, código, unirse, entregas, notas, archivos); alumno pidiendo el curso archivado; la historia de inscripciones y la base de solo agregado |
| `aceptacion/roles.spec.ts` | Quitar administradores (último administrador, universidad deshabilitada, sesiones revocadas); poner y quitar owners (invitado por mail, último owner, sesiones revocadas, `quitar-owner` y `crear-owner` que levanta la suspensión); el owner administra dos universidades desde la misma sesión |
| `aceptacion/interfaz-roles.spec.ts` | Quitar administrador, sección Owners, Administrar con selector de universidad, owner suspendiendo a un administrador y transferencia desde Admin › Cursos |
| `ataque/roles.spec.ts` | Administrador o cuenta común quitando administradores o dando y quitando owners; administrador o cuenta común indicando `?universidad=`; sesiones viejas de un administrador o un owner quitados |
| `ataque/login-tiempo.spec.ts` | El pedido de código de una cuenta suspendida tarda lo mismo que el de una activa y da el mismo 503 con el proveedor de mails caído |
| `ataque/contenedores.spec.ts` (Docker) | Visitas simultáneas a un curso archivado no lo encienden; un contenedor encendido a mano se vuelve a detener; token de curso de un curso archivado rechazado por la API para cursos; el enrutador no reenvía nada para una cuenta suspendida con la sesión revivida |

## Cambios

- 2026-11-10: se incorporan los agregados del alcance (10:55, 11:00 y 11:15) en la sección 6.1; la sección 6 deja de negar al owner las rutas `/api/admin/*` cuando indica `?universidad=<id>`.
- 2026-11-10: el pedido de código iguala el tiempo y el 503 del proveedor caído para las cuentas que no reciben código.

- 2026-11-10: `Persona` del administrador suma `"owner": bool` para que la interfaz oculte las acciones en las filas de owners.
- 2026-11-10: `pruebas/fase-1/aceptacion/login.spec.ts` ("cada persona ve sus cursos con su rol") agrega `archivado: false` al curso esperado de `GET /api/mis-cursos`, porque este contrato (sección "Campos nuevos en respuestas existentes") suma ese campo y la prueba compara el objeto completo con `toEqual`.
- 2026-11-10 (integración con la fase 3): la media del tiempo de emisión de códigos y el estado de la última emisión (falló o no) se guardan en la tabla `envios_codigo` (migración `5002_envios_codigo.sql`) y se cargan al arrancar. Sin mediciones guardadas se parte de `ESPERA_CODIGO_INICIAL_MS` (predeterminado 800 con Brevo y 10 con `archivo`, máximo 20000). Así, tras reiniciar el núcleo, el pedido de código de una cuenta suspendida sigue tardando lo mismo que el de una activa y repite el 503 si el último envío real falló. Pruebas nuevas en `ataque/login-tiempo.spec.ts`.
- 2026-11-10 (integración con la fase 3): las rutas de la fase 3 que modifican el curso (`POST /api/cursos/{id}/espacio`, `/agente`, `/publicar` y `/versiones/{n}/volver`) responden `409 curso_archivado` si el curso está archivado y `409 universidad_deshabilitada` si su universidad está deshabilitada. El subdominio `<id>-prueba` aplica el mismo bloqueo que el enrutador (403 "Curso archivado" o "Curso no disponible"). Los tokens de modelo y de curso de los espacios de cursos fuera de servicio no sirven, y los espacios de esos cursos se detienen. Pruebas en `ataque/fase-3.spec.ts`.
