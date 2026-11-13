# Contrato de la fase 1: identidad, roles y paneles

_Escrito: 2026-11-10. Referencias: `CONVENCIONES.md`, `handoffs/261110_0400_plan-implementacion-plataforma.md`, `prototipo/campus.html`._

Este contrato es la fuente de verdad para implementar la fase 1. Las pruebas de `pruebas/fase-1/` lo verifican. Si algo de acá no coincide con una prueba, manda la prueba y se avisa en el handoff. Las pruebas no se cambian para que pasen.

## 1. Módulos y carpetas

| Módulo | Carpeta | Qué entrega |
|---|---|---|
| Núcleo | `nucleo/` | Binario `campusia-nucleo` en Rust: API, sesiones, mails, Turnstile, auditoría, subcomandos, página provisoria del curso y archivos estáticos de la interfaz |
| Interfaz | `interfaz/` | React con Vite y TypeScript, compilada a `interfaz/dist` |
| Despliegue | `despliegue/` | `campusia-nucleo.service`, `Caddyfile`, `instalar.sh`, `campusia.env.ejemplo` |

Cada módulo toca solo su carpeta. Nadie toca `pruebas/`, `contratos/`, `prototipo/` ni `handoffs/`. El handoff lo escribe el workflow al terminar.

## 2. Compilar, levantar y probar

### Compilar

```bash
. "$HOME/.cargo/env"
cargo build --manifest-path nucleo/Cargo.toml                  # nucleo/target/debug/campusia-nucleo
pnpm --dir interfaz install && pnpm --dir interfaz run build   # interfaz/dist/index.html
```

- `nucleo/Cargo.toml` define un paquete cuyo binario se llama `campusia-nucleo`. Dependencias: axum, tokio, sqlx (sqlite, migraciones embebidas con `sqlx::migrate!`), serde, reqwest con rustls y las que hagan falta. No usa el OpenSSL del sistema.
- Las migraciones viven en `nucleo/migraciones/` (`0001_inicial.sql`, ...) y se embeben en el binario. No se usan las macros `sqlx::query!` que verifican contra una base al compilar, porque al compilar no hay `DATABASE_URL`.
- `interfaz/package.json` tiene el script `build`, que deja `interfaz/dist/index.html` y `interfaz/dist/assets/*`. Se versiona `pnpm-lock.yaml`.

### Levantar en desarrollo

```bash
export DATABASE_URL=sqlite:///tmp/campusia.db DOMINIO_BASE=campusia.prueba ENTORNO=desarrollo \
  PROVEEDOR_EMAIL=archivo ARCHIVO_EMAIL=/tmp/mails.jsonl SESSION_SECRET=$(openssl rand -hex 32) \
  TURNSTILE_SITE_KEY=1x00000000000000000000AA TURNSTILE_SECRET=1x0000000000000000000000000000000AA \
  INTERFAZ_DIR=$PWD/interfaz/dist EMAIL_FROM=no-responder@campusia.prueba
nucleo/target/debug/campusia-nucleo migrar
nucleo/target/debug/campusia-nucleo sembrar pruebas/fase-1/datos.json
nucleo/target/debug/campusia-nucleo crear-owner equipo@campusia.prueba
nucleo/target/debug/campusia-nucleo
```

### Probar

```bash
bash pruebas/correr.sh
```

`pruebas/correr.sh` instala las dependencias de las pruebas (`pnpm install --frozen-lockfile`) y Chromium de Playwright, y después corre `playwright test`. Eso toma todas las carpetas `pruebas/fase-*/`, así que también corre las fases siguientes. El `globalSetup` (`pruebas/comun/compilar.ts`) compila el núcleo y la interfaz desde cero; con `CAMPUSIA_SIN_COMPILAR=1` usa lo ya compilado. Acepta argumentos de Playwright, por ejemplo `bash pruebas/correr.sh fase-1/ataque` o `bash pruebas/correr.sh -g login`. `PRUEBAS_WORKERS` cambia la cantidad de workers (4 por defecto).

Cada worker de las pruebas levanta su propio núcleo en un puerto libre de `127.0.0.1`. Usa una base nueva en un directorio temporal y corre `campusia-nucleo migrar`, `sembrar pruebas/fase-1/datos.json` y `crear-owner equipo@campusia.prueba`. Además levanta servicios falsos de Turnstile y de Brevo. Algunos archivos piden un núcleo con otra configuración: límites reales, vencimientos de pocos segundos, producción, Brevo o Turnstile caído. Las pruebas de despliegue necesitan Docker (imagen `caddy:2.8.4`).

#### Por qué `campusia.prueba` y no `localhost`

Chromium rechaza las cookies con `Domain=localhost`, así que con `localhost` no se puede probar en el navegador una cookie compartida entre subdominios. Por eso las pruebas usan `DOMINIO_BASE=campusia.prueba`, y Chromium resuelve `campusia.prueba` y `*.campusia.prueba` a `127.0.0.1` (`--host-resolver-rules`). Las pruebas de API mandan el encabezado `Host` (`campusia.prueba:<puerto>`, `redes.campusia.prueba:<puerto>`, ...). El núcleo tiene que funcionar igual con cualquier `DOMINIO_BASE`, incluido `localhost`.

## 3. Variables de entorno

| Variable | Por defecto | Uso |
|---|---|---|
| `PUERTO` | `8080` | Puerto de escucha |
| `DIRECCION` | `127.0.0.1` | Dirección de escucha |
| `ENTORNO` | `produccion` | `produccion` o `desarrollo`. En `desarrollo` la cookie no lleva `Secure`, se aceptan orígenes `http` y se permite `sembrar` |
| `DATABASE_URL` | obligatoria | `sqlite:///ruta/absoluta.db`. El archivo se crea si no existe. Modo WAL |
| `DOMINIO_BASE` | obligatoria | `campusia.tech` en producción |
| `PROVEEDOR_EMAIL` | `brevo` | `archivo` o `brevo`. Con otro valor el núcleo no arranca |
| `ARCHIVO_EMAIL` | obligatoria con `archivo` | Archivo donde se agregan los mails, uno por línea (JSON) |
| `BREVO_API_KEY` | obligatoria con `brevo` | Si falta o está vacía con `brevo`, el núcleo no arranca |
| `BREVO_API_URL` | `https://api.brevo.com/v3/smtp/email` | Solo se cambia en las pruebas |
| `EMAIL_FROM` | `no-responder@campusia.tech` | Remitente |
| `EMAIL_FROM_NAME` | `Campus IA` | Nombre del remitente |
| `TURNSTILE_SITE_KEY` | obligatoria | Clave pública que recibe la interfaz |
| `TURNSTILE_SECRET` | obligatoria | Secreto para `siteverify` |
| `TURNSTILE_VERIFY_URL` | `https://challenges.cloudflare.com/turnstile/v0/siteverify` | Solo se cambia en las pruebas |
| `SESSION_SECRET` | obligatoria, 32 caracteres o más | Clave HMAC de las huellas. Si falta o es más corta, el núcleo no arranca y sale con código distinto de 0 |
| `INTERFAZ_DIR` | `./interfaz/dist` | Carpeta con la interfaz compilada |
| `ENCABEZADO_IP_CLIENTE` | vacío | Si tiene el nombre de un encabezado (en producción `CF-Connecting-IP`), la IP del cliente sale de ahí; si está vacío, de la conexión |
| `CODIGO_VIGENCIA_SEG` | `600` | Vigencia de los códigos |
| `SESION_COMUN_SEG` | `2592000` | Sesión de alumnos y profesores (30 días) |
| `SESION_PRIVILEGIADA_SEG` | `43200` | Sesión de administradores y owners (12 horas) |
| `REAUTENTICACION_SEG` | `600` | Ventana de la reautenticación |
| `VENTANA_LIMITES_SEG` | `900` | Ventana de los límites de envío y de Turnstile |
| `LIMITE_CODIGOS_EMAIL` | `3` | Códigos por mail dentro de la ventana |
| `LIMITE_CODIGOS_IP` | `20` | Pedidos de código por IP dentro de la ventana |
| `UMBRAL_TURNSTILE` | `5` | Pedidos de código o verificaciones fallidas por IP, dentro de la ventana, a partir de los cuales se exige Turnstile |

Los subcomandos `migrar`, `sembrar` y `crear-owner` solo necesitan `DATABASE_URL`, más `ENTORNO` en el caso de `sembrar`. No exigen `SESSION_SECRET` ni la configuración de mails.

## 4. Subcomandos

| Comando | Qué hace |
|---|---|
| `campusia-nucleo` | Corre las migraciones pendientes y levanta el servidor. Termina limpio con SIGTERM |
| `campusia-nucleo migrar` | Corre las migraciones y sale. Idempotente |
| `campusia-nucleo crear-owner <email>` | Normaliza el mail (minúsculas, sin espacios). Si la persona no existe, la crea con `owner=1`, sin universidad y con `pendiente=0`; si existe, le pone `owner=1`. Idempotente. Con un mail inválido sale con código distinto de 0. Registra `owner_creado` en la auditoría |
| `campusia-nucleo sembrar <archivo.json>` | Carga datos de prueba con el formato de `pruebas/fase-1/datos.json`. Funciona solo con `ENTORNO=desarrollo`; si no, sale con código distinto de 0 y no toca nada |

Formato de `sembrar`:
- `universidades[]`: `nombre`, `dominios[]`, `limite_usd`.
- `usuarios[]`: `email`, `nombre`, `universidad` (por nombre), `profesor`, `administrador`, `owner`, `pendiente`. Los booleanos que faltan son `false`.
- `cursos[]`: `id`, `nombre`, `periodo`, `color`, `universidad` (por nombre), `version_publicada` o `null`, `uso_usd_mes` (se guarda en `uso_agente` para el mes actual) e `inscripciones[]` con `email` y `rol`.

## 5. Modelo de datos

Base SQLite con una sola migración inicial, `nucleo/migraciones/0001_inicial.sql`. Las fechas se guardan como texto RFC 3339 en UTC y los booleanos como `INTEGER` 0/1. Las pruebas leen la base directamente, así que los nombres de las tablas y de las columnas marcadas con * son obligatorios.

```sql
universidades(id* INTEGER PK, nombre* TEXT NOT NULL, limite_usd REAL NOT NULL DEFAULT 20, creada_en TEXT NOT NULL)
dominios(dominio* TEXT PK, universidad_id* INTEGER NOT NULL REFERENCES universidades)
usuarios(id INTEGER PK, email* TEXT NOT NULL UNIQUE, nombre TEXT NOT NULL, universidad_id INTEGER NULL REFERENCES universidades,
         profesor INTEGER NOT NULL DEFAULT 0, administrador INTEGER NOT NULL DEFAULT 0, owner* INTEGER NOT NULL DEFAULT 0,
         pendiente INTEGER NOT NULL DEFAULT 0, creado_en TEXT NOT NULL, ultimo_ingreso TEXT NULL)
sesiones(id INTEGER PK, usuario_id INTEGER NOT NULL, huella* TEXT NOT NULL UNIQUE, creada_en TEXT NOT NULL, vence_en TEXT NOT NULL,
         revocada INTEGER NOT NULL DEFAULT 0, reautenticada_en TEXT NULL, ip TEXT, agente TEXT)
codigos_login(id INTEGER PK, email TEXT NOT NULL, proposito TEXT NOT NULL CHECK (proposito IN ('login','reautenticacion')),
              sesion_id INTEGER NULL, huella TEXT NOT NULL, intentos INTEGER NOT NULL DEFAULT 0, vence_en TEXT NOT NULL,
              usado INTEGER NOT NULL DEFAULT 0, anulado INTEGER NOT NULL DEFAULT 0, creado_en TEXT NOT NULL, ip TEXT)
tokens_api(id INTEGER PK, usuario_id INTEGER NOT NULL, nombre TEXT NOT NULL, huella TEXT NOT NULL UNIQUE, permisos TEXT NOT NULL,
           creado_en TEXT NOT NULL, vence_en TEXT NOT NULL, revocado INTEGER NOT NULL DEFAULT 0, ultimo_uso TEXT NULL)
cursos(id TEXT PK, nombre TEXT NOT NULL, periodo TEXT NOT NULL, color TEXT NOT NULL, universidad_id INTEGER NOT NULL,
       version_publicada INTEGER NULL, creado_en TEXT NOT NULL)
inscripciones(curso_id TEXT NOT NULL, usuario_id INTEGER NOT NULL, rol TEXT NOT NULL CHECK (rol IN ('dueño','profesor','alumno')),
              creada_en TEXT NOT NULL, PRIMARY KEY (curso_id, usuario_id))
uso_agente(curso_id TEXT NOT NULL, mes TEXT NOT NULL, usd REAL NOT NULL DEFAULT 0, PRIMARY KEY (curso_id, mes))
auditoria(id* INTEGER PK, fecha TEXT NOT NULL, universidad_id INTEGER NULL, actor_id INTEGER NULL, accion* TEXT NOT NULL,
          detalle TEXT NOT NULL, ip TEXT NULL)
configuracion(clave TEXT PK, valor TEXT NOT NULL)
limites(id INTEGER PK, tipo TEXT NOT NULL, clave TEXT NOT NULL, fecha TEXT NOT NULL)
emails_enviados(id INTEGER PK, tipo TEXT NOT NULL, fecha TEXT NOT NULL)
```

- `auditoria` es de solo agregado. Dos triggers, `BEFORE UPDATE` y `BEFORE DELETE`, hacen `RAISE(ABORT, 'auditoria de solo agregado')`.
- Huellas: `HMAC-SHA256(SESSION_SECRET, valor)` en hexadecimal. Para los códigos, el valor es `email:proposito:codigo`. El token de sesión, el código y el token de API nunca se guardan en claro: ni en una tabla ni en la auditoría.
- `configuracion` guarda `proveedor_modelo` (`api` o `suscripcion`, por defecto `api`) y `proveedor_email` (`brevo` o `resend`, por defecto `brevo`).
- `limites` registra los eventos que cuentan para los límites (`codigo_email`, `codigo_ip`, `fallo_ip`). Los vencidos se pueden borrar.
- Cada persona queda en la universidad del dominio de su mail en el momento en que se crea su cuenta. Cada dominio pertenece a una sola universidad.

## 6. Reglas generales de la API

- Todo va bajo `/api`, en JSON con `Content-Type: application/json`. Si una ruta espera JSON y el cuerpo no lo es, responde `400 datos_invalidos` o `415`.
- Los errores tienen la forma `{"error": "<codigo>", "mensaje": "<texto en castellano>"}`. Códigos posibles:
  - 400: `datos_invalidos`, `email_invalido`, `codigo_invalido`, `dominio_no_habilitado`, `permisos_invalidos`.
  - 401: `no_autenticado`.
  - 403: `prohibido`, `origen_invalido`, `reautenticacion_requerida`, `requiere_sesion`, `permiso_del_token`, `turnstile_requerido` (agrega `site_key`), `turnstile_invalido`.
  - 404: `no_encontrado`.
  - 409: `dominio_en_uso`, `email_en_uso`, `ultimo_dominio`.
  - 429: `demasiados_intentos`.
  - 503: `servicio_no_disponible`.
- Las respuestas JSON llevan `Cache-Control: no-store`. No hay CORS: nunca se responde `Access-Control-Allow-Origin`.
- `GET /salud` responde `200 {"ok": true}` en cualquier host. Lo usa `instalar.sh`.

### Hosts

| Host | Qué sirve |
|---|---|
| `DOMINIO_BASE` | API e interfaz |
| `<id>.DOMINIO_BASE`, donde `<id>` es una sola etiqueta `[a-z0-9-]+` que no termina en `-curso` ni en `-prueba` | API e interfaz (la barra del curso), exista o no el curso |
| `<id>-curso.DOMINIO_BASE` | Página provisoria del curso (sección 9). `/api/*` responde 404 |
| `<id>-prueba.DOMINIO_BASE` | 404 en todo (llega en la fase 3) |
| Cualquier otro (`evil.com`, `a.b.DOMINIO_BASE`, `DOMINIO_BASE.evil.com`) | 404, salvo `/salud` |

Para reconocer el host se ignora el puerto del encabezado `Host`.

### Orden de los controles

1. Host válido. Si no, 404.
2. Origen, en los `POST`, `PUT`, `PATCH` y `DELETE` que no traen `Authorization: Bearer`. El encabezado `Origin` tiene que ser exactamente `<esquema>://<valor del encabezado Host>`, con esquema `https` (o `http`, solo con `ENTORNO=desarrollo`), y el pedido tiene que traer `X-Campusia: 1`. Si no, `403 origen_invalido`. Esto también vale para el login y la verificación. Desde `redes.campusia.tech` solo sirve `Origin: https://redes.campusia.tech`. Se rechaza un `Origin` de `-curso`, de `-prueba`, de otro subdominio, `null` o ausente.
3. Autenticación. Si viene `Authorization: Bearer`, solo cuenta el token: si no es válido, responde 401 aunque haya una cookie buena. Si no viene, se usa la cookie `campusia_sesion`. Una sesión o un token inexistente, vencido o revocado responde `401 no_autenticado`.
4. Una ruta solo para sesión llamada con token: `403 requiere_sesion`.
5. Un token sin el permiso de la ruta: `403 permiso_del_token`.
6. Rol: `403 prohibido`.
7. Reautenticación: `403 reautenticacion_requerida`.
8. Validación del cuerpo: `400`.
9. Alcance y existencia, por ejemplo una persona de otra universidad: `404 no_encontrado`.
10. Conflictos: `409`.

### Sesión

- Token: 32 bytes aleatorios en base64url. Cookie: `campusia_sesion=<token>; Domain=<DOMINIO_BASE>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<segundos>`, más `Secure` salvo con `ENTORNO=desarrollo`.
- Duración: `SESION_PRIVILEGIADA_SEG` si la persona es administrador u owner al entrar; si no, `SESION_COMUN_SEG`. `Max-Age` es igual a esa duración. La sesión se valida contra la base en cada petición: huella, `revocada` y `vence_en`.
- Cada login crea una sesión nueva. Si el pedido de verificación traía la cookie de una sesión válida, esa sesión se revoca. Una cookie que no corresponde a ninguna sesión se ignora y se reemplaza.
- Logout revoca la sesión y manda la cookie con `Max-Age=0`.
- Reautenticación: se guarda en `reautenticada_en` de la sesión y vale `REAUTENTICACION_SEG`. Es de esa sesión, no de la persona. Volver a entrar no cuenta como reautenticación.

### Códigos

- 6 dígitos aleatorios generados con un CSPRNG. Vencen a los `CODIGO_VIGENCIA_SEG`. Se usan una sola vez.
- Pedir un código nuevo anula los anteriores sin usar del mismo mail y propósito.
- Cada verificación fallida suma un intento al código vigente de ese mail y propósito. Al quinto fallo el código se anula.
- Responden `400 codigo_invalido`, igual que un código equivocado: un código anulado, vencido, usado, de otro mail, de otro propósito o de otra sesión, y cualquier valor que no sea de 6 dígitos.
- Turnstile se controla antes que el código. Un pedido rechazado por Turnstile no gasta intentos del código.
- La cuenta nunca se bloquea: después de un código anulado se puede pedir otro.
- Los códigos de reautenticación quedan atados a la sesión que los pidió.

### Límites y Turnstile

- Por mail: como mucho `LIMITE_CODIGOS_EMAIL` códigos dentro de la ventana, sumando login y reautenticación, desde cualquier IP. El siguiente responde `429 demasiados_intentos` y no manda mail. Se cuenta por mail pedido, exista o no la cuenta y esté o no habilitado el dominio.
- Por IP: como mucho `LIMITE_CODIGOS_IP` pedidos de código de login aceptados dentro de la ventana. El siguiente responde `429`, aunque traiga un Turnstile válido.
- Turnstile:
  - Se exige cuando la IP ya hizo, dentro de la ventana, `UMBRAL_TURNSTILE` pedidos de código aceptados o `UMBRAL_TURNSTILE` verificaciones fallidas. Desde ahí, `POST /api/login/codigo` y `POST /api/login/verificar` necesitan el campo `turnstile`.
  - Sin ese campo: `403 turnstile_requerido`, con `site_key`.
  - Se verifica con `POST TURNSTILE_VERIFY_URL` (formulario con `secret`, `response` y `remoteip`). Si responde `success: false`: `403 turnstile_invalido`.
  - Si `siteverify` no responde o falla: `503 servicio_no_disponible`, y no se manda nada.
  - La reautenticación no usa Turnstile.
- Si falla el envío del mail: `503 servicio_no_disponible`. El código que no se pudo mandar queda anulado.

### Mails

Contrato `ProveedorDeEmail`: un trait con `async fn enviar(&self, mail: &Mail) -> Result<()>`, donde `Mail { para, asunto, texto, html }`.

- `archivo`: agrega a `ARCHIVO_EMAIL` una línea JSON `{"para","asunto","texto","html","fecha"}`, antes de responder la petición.
- `brevo`: `POST BREVO_API_URL` con el encabezado `api-key: <BREVO_API_KEY>` y el cuerpo `{"sender":{"email":EMAIL_FROM,"name":EMAIL_FROM_NAME},"to":[{"email":para}],"subject":asunto,"textContent":texto,"htmlContent":html}`. Cualquier respuesta que no sea 2xx es una falla.
- Mail de código: el texto tiene el código como 6 dígitos seguidos y ningún otro número de 6 dígitos o más.
- Mail de invitación: el asunto empieza con `Invitación`. El texto dice quién invita, a qué universidad, con qué marca, y da la dirección `https://<DOMINIO_BASE>`.
- Cada envío se registra en `emails_enviados`.

### Tokens personales

- Valor: `cia_` seguido de 32 bytes aleatorios en base64url (43 caracteres). Se muestra una sola vez, al crearlo. En la base solo queda la huella.
- Permisos: `cursos:leer` (cualquiera), `admin:leer` y `admin:escribir` (solo administradores), `owner:leer` y `owner:escribir` (solo owners). Una lista vacía, un permiso desconocido o uno que el rol no tiene: `400 permisos_invalidos`.
- `dias`: entero de 1 a 365, 90 por defecto. Otro valor: `400 datos_invalidos`.
- Con `Authorization: Bearer`, la petición tiene los permisos que la persona tiene en ese momento, limitados a los del token. No hace falta `Origin` ni `X-Campusia`. Las rutas "solo sesión" responden `403 requiere_sesion`.
- Cada uso actualiza `ultimo_uso`.

## 7. Rutas de la API

En las tablas: **Quién** es el rol requerido, **Token** es el permiso que necesita un token (o "solo sesión"), **Reaut** indica si exige reautenticación.

### Públicas

| Método y ruta | Cuerpo | Respuesta | Errores |
|---|---|---|---|
| `GET /salud` | | `200 {"ok":true}` | |
| `GET /api/config` | | `200 {"dominio_base","turnstile_site_key"}` | |
| `POST /api/login/codigo` | `{"email","turnstile"?}` | `200 {"ok":true}` | 400 `email_invalido`; 403 `origen_invalido`, `turnstile_requerido`, `turnstile_invalido`; 429; 503 |
| `POST /api/login/verificar` | `{"email","codigo","turnstile"?}` | `200 {"usuario": Usuario}` y `Set-Cookie` | 400 `codigo_invalido`; 403 como arriba; 503 |

`POST /api/login/codigo`:
- Responde exactamente lo mismo (estado y cuerpo, sin cookies) para una cuenta existente, una inexistente de un dominio habilitado y un mail de un dominio no habilitado.
- Solo manda el código si el dominio del mail es de alguna universidad, o si la cuenta existe y es owner.
- Normaliza el mail (recorta espacios, pasa a minúsculas) y lo valida: `local@dominio.tld`, una sola arroba, sin espacios.
- Compara el dominio completo: `austral.edu.ar.evil.com` o `evilaustral.edu.ar` no son `austral.edu.ar`.

`POST /api/login/verificar` con el código correcto:
- Si la cuenta no existe, la crea en la universidad del dominio. El nombre sale de la parte local del mail: `.`, `_` y `-` pasan a ser espacios y cada palabra empieza con mayúscula.
- Si la cuenta estaba `pendiente`, deja de estarlo.
- Actualiza `ultimo_ingreso` y registra `login` en la auditoría con la IP.
- Ignora cualquier campo de más en el cuerpo.

### Sesión y cuenta

| Método y ruta | Quién | Token | Reaut | Cuerpo | Respuesta |
|---|---|---|---|---|---|
| `GET /api/yo` | cualquiera | cualquier token | | | `200 {"usuario": Usuario, "sesion": {"tipo":"cookie","vence","reautenticada_hasta"} \| null}` (`null` con token) |
| `GET /api/mis-cursos` | cualquiera | `cursos:leer` | | | `200 {"cursos":[{"id","nombre","periodo","color","rol","version_publicada"}]}`, ordenados por nombre |
| `POST /api/logout` | cualquiera | solo sesión | | | `204` y la cookie con `Max-Age=0` |
| `POST /api/sesiones/cerrar-otras` | cualquiera | solo sesión | | | `200 {"cerradas": n}`. Revoca las demás sesiones de la persona. Auditoría `sesiones_cerradas` |
| `POST /api/reautenticacion/codigo` | cualquiera | solo sesión | | | `200 {"ok":true}`. Manda un código al mail de la persona. 429 si se pasa del límite por mail |
| `POST /api/reautenticacion/verificar` | cualquiera | solo sesión | | `{"codigo"}` | `200 {"reautenticada_hasta"}`. 400 `codigo_invalido` |
| `GET /api/tokens` | cualquiera | solo sesión | | | `200 {"tokens":[{"id","nombre","permisos","creado","vence","ultimo_uso","revocado"}]}`, solo los propios y sin el valor |
| `POST /api/tokens` | cualquiera | solo sesión | sí | `{"nombre","permisos":[...],"dias"?}` | `201 {"id","nombre","permisos","creado","vence","token"}`. Auditoría `token_creado` |
| `DELETE /api/tokens/{id}` | dueño del token | solo sesión | | | `204`. 404 si el token no es propio. Auditoría `token_revocado` |

`Usuario`: `{"id","email","nombre","universidad":{"id","nombre"} | null,"profesor","administrador","owner"}`.

### Administrador (siempre sobre su propia universidad)

| Método y ruta | Token | Reaut | Cuerpo | Respuesta |
|---|---|---|---|---|
| `GET /api/admin/universidad` | `admin:leer` | | | `200 Universidad` |
| `GET /api/admin/personas?buscar=&filtro=todos\|profesores\|administradores` | `admin:leer` | | | `200 {"personas":[Persona]}`, ordenadas por nombre. `buscar` busca en nombre y mail sin distinguir mayúsculas ni acentos |
| `PUT /api/admin/personas/{id}/profesor` | solo sesión | sí | `{"profesor": bool}` | `200 Persona`. 404 si no es de su universidad. Auditoría `marca_profesor` o `quita_profesor` |
| `POST /api/admin/invitaciones` | solo sesión | sí | `{"email","tipo":"profesor"\|"administrador"}` | `201 Persona` si crea la cuenta (pendiente); `200 Persona` si ya existía y solo le pone la marca. En los dos casos manda el mail de invitación. 400 `dominio_no_habilitado` si el dominio no es de su universidad; 400 `datos_invalidos` si el tipo no existe. Auditoría `invitacion_profesor` o `invitacion_administrador` |
| `GET /api/admin/cursos` | `admin:leer` | | | `200 {"cursos":[{"id","nombre","periodo","color","dueno":{"id","nombre","email"},"profesores","alumnos","version_publicada","uso_usd_mes"}]}`. `profesores` cuenta al dueño y a los profesores |
| `POST /api/admin/dominios` | `admin:escribir` | | `{"dominio"}` | `201 Universidad`. Acepta una `@` al principio y mayúsculas. 400 si no es un dominio válido (etiquetas `[a-z0-9-]`, al menos un punto, sin punto final). 409 `dominio_en_uso` si ya es de alguna universidad. Auditoría `dominio_agregado` |
| `DELETE /api/admin/dominios/{dominio}` | solo sesión | sí | | `200 Universidad`. 404 si no es de su universidad. 409 `ultimo_dominio`. Auditoría `dominio_quitado`. Las cuentas de ese dominio conservan su universidad, pero dejan de recibir códigos |
| `PUT /api/admin/limite` | `admin:escribir` | | `{"limite_usd": número entre 0 y 100000}` | `200 Universidad`. Auditoría `limite_cambiado` |
| `GET /api/admin/auditoria?limite=100` | `admin:leer` | | | `200 {"eventos":[{"id","fecha","actor":{"id","nombre","email"}\|null,"accion","detalle","ip"}]}` de su universidad, del más nuevo al más viejo. `limite` va de 1 a 1000 |

`Universidad`: `{"id","nombre","dominios":[...],"limite_usd"}`.
`Persona`: `{"id","email","nombre","profesor","administrador","pendiente","cursos","ultimo_ingreso"}`, donde `cursos` es la cantidad de inscripciones.

Quién: solo las personas con `administrador=1`. Todas las demás reciben `403 prohibido`, incluido el owner, que no tiene universidad.

### Owner

| Método y ruta | Token | Reaut | Cuerpo | Respuesta |
|---|---|---|---|---|
| `GET /api/owner/universidades` | `owner:leer` | | | `200 {"universidades":[UniversidadOwner]}` |
| `POST /api/owner/universidades` | solo sesión | sí | `{"nombre","dominio","email_administrador","limite_usd"?}` | `201 UniversidadOwner`. Crea la universidad, su dominio y el administrador pendiente, y le manda la invitación. 409 `dominio_en_uso`; 400 `dominio_no_habilitado` si el mail no es de ese dominio; 409 `email_en_uso`. Auditoría `universidad_creada` e `invitacion_administrador`, con esa universidad |
| `POST /api/owner/universidades/{id}/administradores` | solo sesión | sí | `{"email"}` | `201` o `200 Persona`, igual que la invitación del administrador. 404 si la universidad no existe |
| `GET /api/owner/uso` | `owner:leer` | | | `200 {"personas","cursos","agente_usd_mes","mails_hoy","universidades":[{"id","nombre","cursos","agente_usd_mes"}]}` |
| `GET /api/owner/proveedores` | `owner:leer` | | | `200 {"modelo":"api"\|"suscripcion","email":"brevo"\|"resend"}` |
| `PUT /api/owner/proveedores` | `owner:escribir` | | igual que la respuesta | `200` con lo guardado. 400 `datos_invalidos`. Auditoría `proveedores_cambiados`. Solo se guarda: el núcleo sigue usando `PROVEEDOR_EMAIL` |

`UniversidadOwner`: `{"id","nombre","dominios","limite_usd","administradores":[{"id","nombre","email","pendiente"}],"profesores","personas","cursos"}`. `personas` no cuenta al owner. `agente_usd_mes` suma `uso_agente` del mes actual (`AAAA-MM`, UTC).

Quién: solo `owner=1`. El resto recibe `403 prohibido`.

### Auditoría

- Acciones: `login`, `sesiones_cerradas`, `token_creado`, `token_revocado`, `marca_profesor`, `quita_profesor`, `invitacion_profesor`, `invitacion_administrador`, `dominio_agregado`, `dominio_quitado`, `limite_cambiado`, `universidad_creada`, `proveedores_cambiados`, `owner_creado`.
- `universidad_id` es la universidad afectada; en los logins, la de quien entra.
- `detalle` es texto legible y menciona el mail de la persona afectada o el dominio.
- `ip` es la IP del cliente.
- Ningún detalle incluye códigos ni tokens.

## 8. Permisos

| Acción | Owner | Administrador | Profesor | Cuenta común | Token |
|---|---|---|---|---|---|
| Entrar, ver su perfil y Mis cursos | sí | sí | sí | sí | `cursos:leer` |
| Tokens propios, logout, cerrar las demás sesiones, reautenticarse | sí | sí | sí | sí | no |
| Ver personas, cursos, configuración y auditoría | no | sí, solo de su universidad | no | no | `admin:leer` |
| Agregar dominios y cambiar el límite | no | sí, solo en su universidad | no | no | `admin:escribir` |
| Marcar profesor, invitar y quitar dominios | no | sí, con reautenticación | no | no | no |
| Ver universidades, uso y proveedores | sí | no | no | no | `owner:leer` |
| Elegir proveedores | sí | no | no | no | `owner:escribir` |
| Crear universidades e invitar administradores | sí, con reautenticación | no | no | no | no |
| Ver la página provisoria de un curso | solo si está inscripto | solo si está inscripto | solo si está inscripto | solo si está inscripto | no |

Reglas:
- Un administrador nunca ve ni toca personas, cursos, dominios o eventos de otra universidad: esas rutas responden 404 y esos datos no aparecen en los listados.
- Las marcas, la universidad y el dueño de un token nunca salen del cuerpo de una petición. Los campos de más se ignoran.
- Las acciones con reautenticación (cambiar roles, invitar, quitar dominios, crear universidades y crear tokens) solo se hacen desde una sesión reautenticada. Con un token responden `requiere_sesion`. Quitar personas llega en fases siguientes, con la misma regla.
- Ningún mensaje revela si una cuenta existe.

## 9. Archivos estáticos y página provisoria

- En el dominio base y en los subdominios de la barra, toda ruta que no sea `/api/*` ni `/salud` sirve `INTERFAZ_DIR/<ruta>` si existe; si no, sirve `INTERFAZ_DIR/index.html` (aplicación de una sola página). `index.html` contiene `<div id="raiz"></div>`.
- Las páginas de la plataforma llevan `Content-Security-Policy` con `frame-ancestors 'none'`.
- `GET /` en `<id>-curso.DOMINIO_BASE`:
  - Si el curso no existe: 404.
  - Sin sesión: 401, en HTML.
  - Con la sesión de alguien que no está inscripto, aunque sea administrador: 403, en HTML y sin el nombre del curso.
  - Con la sesión de alguien inscripto: 200, en HTML, con el nombre del curso y el texto "Curso en preparación", y con `Content-Security-Policy: frame-ancestors <esquema>://<id>.<DOMINIO_BASE>[:puerto]` (el host de la barra).
  - En la fase 2 esto lo reemplaza el enrutador a contenedores.

## 10. Interfaz

La interfaz reproduce `prototipo/campus.html`: la paleta (`#001D9C`, `#1E4FD6` y grises), Inter, la barra blanca de 48 px, los componentes y los textos. No incluye la sección "cuentas de prueba" del login. El `<title>` contiene "Campus IA". Al cargar llama a `GET /api/config` y a `GET /api/yo`. Todas las modificaciones mandan `X-Campusia: 1` y usan `credentials: 'same-origin'`.

Los selectores que se nombran en esta sección son parte del contrato, porque las pruebas los usan.

### Rutas de la interfaz

| Host y ruta | Sin sesión | Con sesión |
|---|---|---|
| base `/` | Login | Mis cursos. El owner va a `/owner` |
| base `/administracion` | Login | Panel de administrador. Si la persona no es administrador, vuelve a `/` |
| base `/owner` | Login | Panel de owner. Si la persona no es owner, vuelve a `/` |
| `<id>.base` `/` | Login; después de entrar se queda en el curso | La barra del curso, si la persona está inscripta. Si no, el aviso "No tenés acceso a este curso" con un enlace a Mis cursos, sin iframe y sin el nombre del curso |

### Pantallas

Las del prototipo son `#v-login`, `#v-cursos`, `#v-curso`, `#v-admin` y `#v-owner`.

**Login** (`#v-login`):
- `#paso-mail` tiene `#mail`, `#enviar` ("Enviar código"; también se envía con Enter) y `#err-mail`. Un mail con formato inválido se avisa en `#err-mail` sin llamar a la API.
- `#paso-codigo` tiene `#mail-enviado`, `#digitos` (6 `input`), `#verificar`, `#err-codigo`, `#otro-mail` (vuelve a `#paso-mail`) y `#reenviar` (pide otro código).
- Las casillas aceptan solo dígitos, avanzan solas y retroceden con Backspace. Al pegar, el código se reparte en las 6. Cuando se completan las 6, se verifica solo.
- Si la API responde `turnstile_requerido`, la interfaz carga `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`, llama a `turnstile.render('#turnstile', {sitekey, callback})` sobre un `<div id="turnstile">` y manda el token en el campo `turnstile`. Puede reintentar sola o cuando se vuelve a tocar el botón.

**Mis cursos** (`#v-cursos`):
- Cabecera con la marca, el título `h2` "Mis cursos" y el avatar del perfil.
- `#grilla` tiene una tarjeta `[data-curso="<id>"]` por curso, con la franja de color, el nombre, el período y una pastilla "Dueño" o "Profesor" (nada para los alumnos).
- Sin cursos: `.vacio` con "Todavía no estás en ningún curso".
- Tocar una tarjeta navega a `<esquema>://<id>.<base>[:puerto]/`.
- Los botones "Unirme con código" y "Crear curso" se completan en la fase 2.

**Barra del curso** (`#v-curso`):
- `.barra` mide 48 px de alto.
- `.marca` (title "Mis cursos") vuelve a la base.
- `[data-menu="m-cursos"]` muestra el punto de color y el nombre, y abre `#m-cursos`, con un `[data-curso]` por curso propio que navega a ese subdominio.
- Para dueños y profesores se ven `[data-modo="publicado"]`, `[data-modo="prueba"]`, `[data-panel="p-agente"]` (Editar), `[data-panel="p-inscriptos"]`, `[data-panel="p-versiones"]` y `#publicar`. Sus paneles se completan en fases siguientes. A los alumnos no se les muestran.
- `iframe#curso` lleva el `sandbox` del prototipo y `src` `<esquema>://<id>-curso.<base>[:puerto]/`.

**Menú de perfil**: el botón `button[data-menu^="m-perfil"]`, con el avatar, abre un menú con el nombre y el mail y los botones "Mis cursos", "Administración" (si es administrador, con el nombre de la universidad), "Owner" (si es owner) y "Cerrar sesión" (hace logout y vuelve al login).

**Panel de administrador** (`#v-admin`, ruta `/administracion`). La cabecera muestra el nombre de la universidad y `#tabs-admin`, con `[data-tab="personas"]`, `[data-tab="cursos"]`, `[data-tab="config"]` y `[data-tab="actividad"]`.
- Personas:
  - `#busca` filtra mientras se escribe. Hay chips `[data-filtro="todos"]`, `[data-filtro="prof"]` y `[data-filtro="admin"]`.
  - La tabla tiene una fila `tr` por persona: nombre, mail, pastillas "Administrador" e "Invitación enviada", interruptor, cursos y último ingreso.
  - El interruptor es `button[data-marca="<id persona>"]`, con `aria-pressed="true|false"`.
  - `[data-accion="invitar-prof"]` y `[data-accion="invitar-admin"]` abren el modal con `#i-mail`, `#i-err` y el botón `[data-invok]` "Enviar invitación". Al terminar, la persona aparece en la tabla.
- Cursos: una fila `tr` por curso, con nombre, dirección, dueño, profesores, alumnos, estado ("Publicado · v12" o "Sin publicar") y uso ("USD n de límite").
- Configuración: cada dominio se muestra como `@dominio` con su botón `[data-quitardom="<dominio>"]`. Para agregar hay `#nuevo-dom` y `[data-accion="agregar-dom"]`. `#limite` se guarda con Enter o al salir del campo.
- Actividad: cada evento con fecha, actor, la acción en palabras y el `detalle`.

**Panel de owner** (`#v-owner`, ruta `/owner`). `#tabs-owner` tiene `[data-otab="unis"]` y `[data-otab="uso"]`.
- Universidades:
  - La tabla tiene una fila `tr` por universidad: nombre, dominios como `@dominio`, administradores (con "Invitación enviada" si están pendientes), profesores, personas y cursos, y el botón `[data-invadmin="<id>"]`, que abre el modal de invitación.
  - `[data-accion="nueva-uni"]` abre el modal con `#n-nombre`, `#n-dom`, `#n-admin`, `#n-err` y `[data-accion="uni-ok"]`.
- Uso y proveedores:
  - Métricas: personas, cursos, agente este mes y mails hoy.
  - `#op-modelo`, con chips "API" y "Suscripción del equipo", y `#op-mail`, con "Brevo" y "Resend". El elegido lleva la clase `on`, y tocar otro lo guarda.
  - Una tabla por universidad con `USD n` (los enteros, sin decimales).

**Reautenticación**:
- Cuando una llamada responde `reautenticacion_requerida`, se abre un modal "Confirmá que sos vos" que pide el código solo (`POST /api/reautenticacion/codigo`).
- El modal tiene `#reaut-digitos` (6 `input`, con las mismas reglas que el login; verifica solo al completarse), `#reaut-err` y "Reenviar código".
- Al verificar, el modal se cierra y la acción original se reintenta.

**Avisos**: `#aviso`, como en el prototipo, para confirmaciones y errores.

## 11. Despliegue

**`despliegue/campusia-nucleo.service`**:
- `User=campusia`, `EnvironmentFile=/srv/campusia/config/campusia.env`, `Environment=DATABASE_URL=sqlite:///srv/campusia/datos/campusia.db`, `Environment=INTERFAZ_DIR=/srv/campusia/interfaz`, `ExecStart=/usr/local/bin/campusia-nucleo`, `Restart=on-failure`, `WantedBy=multi-user.target`.
- Endurecimiento: `ProtectSystem=strict`, `ReadWritePaths=/srv/campusia`, `PrivateTmp=true` y otras opciones que no rompan Podman sin root.
- No usar `NoNewPrivileges=true`, `PrivateUsers=true`, `RestrictNamespaces=true` ni `ProtectHome=true`.

**`despliegue/Caddyfile`**:
- Sitio `campusia.tech, *.campusia.tech` con `tls /etc/caddy/certs/origen.pem /etc/caddy/certs/origen.key` y `reverse_proxy 127.0.0.1:8080`.
- En las opciones globales, `auto_https disable_certs`.
- Tiene que pasar `caddy adapt` con `caddy:2.8.4`.

**`despliegue/campusia.env.ejemplo`**: todas las variables de la sección 3 con valores de ejemplo, `ENTORNO=produccion`, `DOMINIO_BASE=campusia.tech`, `ENCABEZADO_IP_CLIENTE=CF-Connecting-IP` y `PROVEEDOR_EMAIL=brevo`. En lugar de secretos lleva marcadores (`BREVO_API_KEY=completar`, `SESSION_SECRET=completar`, ...).

**`despliegue/instalar.sh --binario <ruta> --interfaz <carpeta> [--raiz <carpeta>] [--sin-servicios]`**:
- Falla (salida distinta de 0) si falta el binario o la interfaz.
- Copia el binario a `<raiz>/usr/local/bin/campusia-nucleo` (0755) y la interfaz a `<raiz>/srv/campusia/interfaz/`, reemplazando la anterior.
- Copia la unidad a `<raiz>/etc/systemd/system/` y el Caddyfile a `<raiz>/etc/caddy/Caddyfile`, sin cambios.
- Crea `<raiz>/srv/campusia/datos` y `<raiz>/srv/campusia/config`, y corre `campusia-nucleo migrar` con `DATABASE_URL=sqlite://<raiz>/srv/campusia/datos/campusia.db`.
- Nunca crea ni pisa `campusia.env`.
- Sin `--sin-servicios`, además: crea el usuario `campusia` si no existe, ajusta dueños y permisos (`campusia.env` 0600), exige que exista `campusia.env`, corre `systemctl daemon-reload`, `enable` y `restart`, recarga Caddy y verifica `GET http://127.0.0.1:8080/salud` con reintentos.
- Es idempotente: correrlo de nuevo no rompe nada ni borra datos.

## 12. Pruebas

Todas están en `pruebas/fase-1/`, y los ayudantes compartidos en `pruebas/comun/`.

| Archivo | Qué prueba |
|---|---|
| `aceptacion/login.spec.ts` | Salud y configuración; login completo leyendo el mail; código de un solo uso; cuenta automática; normalización del mail; atributos de la cookie; sesiones de 30 días y de 12 horas; owner de otro dominio; logout; renovación; cerrar las demás sesiones; cuenta pendiente; reautenticación; Mis cursos con roles; interfaz en la base y en los subdominios; página provisoria |
| `aceptacion/administrador.spec.ts` | Universidad; personas con filtros y búsqueda; marcar profesor; invitar profesor y administrador; cursos con conteos y uso; dominios; límite; auditoría |
| `aceptacion/owner.spec.ts` | Universidades; crear una universidad con su primer administrador, que entra y la administra; invitar administrador; uso; proveedores |
| `aceptacion/tokens.spec.ts` | Crear, listar sin el secreto, usar y revocar tokens; token de administrador sin cookie ni Origin; token de owner |
| `aceptacion/brevo.spec.ts` | Envío por la API de Brevo; falla del proveedor |
| `aceptacion/produccion.spec.ts` | Cookie `Secure`; solo orígenes `https`; `sembrar` prohibido |
| `aceptacion/arranque.spec.ts` | `crear-owner`; `migrar`; arranque sin secreto o con el proveedor de mails mal configurado |
| `aceptacion/interfaz.spec.ts` | Login (pegar, tipear, error, reenviar, otro mail, Turnstile); estado vacío; cerrar sesión; barra del curso para profesor y para alumno; curso ajeno; panel de administrador completo con reautenticación; acceso denegado a los paneles; panel de owner completo |
| `ataque/codigos.spec.ts` | Códigos equivocados; quinto intento; código de otra persona; código anterior; 3 por mail; 20 por IP; Turnstile por pedidos y por fallos; dominios no habilitados y parecidos; códigos de reautenticación atados a la sesión y al propósito |
| `ataque/vencimientos.spec.ts` | Código vencido; sesión vencida (común y privilegiada); reautenticación vencida |
| `ataque/turnstile-caido.spec.ts` | Si no se puede verificar Turnstile, se niega el acceso |
| `ataque/enumeracion.spec.ts` | Respuestas idénticas para cuentas existentes, inexistentes y de dominios no habilitados |
| `ataque/sesiones.spec.ts` | Cookies inventadas; solo huellas en la base; la huella usada como cookie o como token; sesiones revocadas; cookie plantada; sesiones robadas; API ausente en `-curso` y `-prueba` |
| `ataque/permisos.spec.ts` | 401 sin sesión; alumnos y profesores contra rutas de administrador y de owner; administrador contra rutas de owner y owner contra rutas de administrador; administrador contra otra universidad (personas, invitaciones, dominios, cursos, auditoría); asignación de marcas por el cuerpo; página provisoria sin inscripción; tokens ajenos |
| `ataque/origen.spec.ts` | Origin ausente, falso, de un curso o de otro subdominio; sin `X-Campusia`; login sin Origin; formularios de otro sitio; CORS; hosts ajenos; `frame-ancestors` |
| `ataque/reautenticacion.spec.ts` | Cada acción sensible sin reautenticación; reautenticación de otra sesión; volver a entrar no reautentica; último dominio |
| `ataque/tokens.spec.ts` | Tokens inventados, mal formados y revocados; Bearer inválido con cookie válida; permisos del token; rutas solo de sesión; permisos que el rol no tiene; vigencia |
| `ataque/auditoria.spec.ts` | La base rechaza modificar o borrar la auditoría; no hay rutas para hacerlo |
| `despliegue/despliegue.spec.ts` | Unidad de systemd; `caddy adapt` del Caddyfile; ejemplo de entorno; `instalar.sh` en una raíz alternativa, idempotente |

Datos de prueba (`pruebas/fase-1/datos.json`):
- Universidad Austral (`austral.edu.ar`, `mail.austral.edu.ar`, límite 40): Ana Morales (administradora), Lucía Fernández y Diego Herrera (profesores), Tomás García (alumno) y Carla Pendiente (profesora invitada, pendiente).
- Universidad de Prueba (`demo.edu.ar`, límite 20): su administrador, un profesor y un alumno.
- Cursos `redes`, `algoritmos` y `etica` (Austral) y `quimica` (Prueba), con inscripciones y uso del mes.
- Owner: `equipo@campusia.prueba`.

## Nota del 2026-11-10: modo de reautenticación

Mandar mails cuesta plata, así que por defecto no se piden códigos de reautenticación a quien ya inició sesión. Esta nota modifica lo anterior donde lo contradiga; el resto del contrato sigue vigente.

Variable nueva:

| Variable | Predeterminado | Uso |
|---|---|---|
| `REAUTENTICACION_MODO` | `sesion` | `sesion` o `codigo`. Cualquier otro valor impide arrancar el núcleo |

Modo `sesion` (predeterminado):
- Al crear una sesión con el login, `reautenticada_en` queda igual a `creada_en`.
- La verificación de reautenticación acepta cualquier sesión válida (huella, `revocada = 0` y `vence_en` futuro). La sesión queda reautenticada por toda su vigencia: `GET /api/yo` devuelve `reautenticada_hasta` igual a `vence`.
- Las acciones marcadas con **Reaut** se hacen sin código desde una sesión. Siguen exigiendo sesión: con un token responden `403 requiere_sesion`. Una sesión revocada, vencida o inventada responde `401 no_autenticado`, como antes.
- `POST /api/reautenticacion/codigo` y `POST /api/reautenticacion/verificar` responden `404 no_encontrado` (después de los controles de sesión, así que con un token siguen respondiendo `requiere_sesion`) y no mandan mails.
- La interfaz no muestra el modal "Confirmá que sos vos".

Modo `codigo`: el comportamiento descrito en las secciones anteriores, sin cambios (reautenticación por código atada a la sesión, válida `REAUTENTICACION_SEG`; volver a entrar no reautentica).

`GET /api/config` agrega `"reautenticacion": "sesion" | "codigo"`; la interfaz monta el modal de reautenticación solo con `codigo`.

Pruebas: las que prueban el mecanismo del código corren con `REAUTENTICACION_MODO=codigo` (`testCodigo` en `pruebas/fase-1/fixtures.ts`, `MODO_CODIGO` en `pruebas/comun/nucleo.ts`). El ayudante `reautenticar` de `pruebas/comun/sesion.ts`, en modo `sesion`, solo comprueba que la sesión ya esté reautenticada. El modo `sesion` se prueba en `aceptacion/reautenticacion-sesion.spec.ts`, `ataque/reautenticacion-sesion.spec.ts` y `ataque/vencimientos-sesion.spec.ts`.
