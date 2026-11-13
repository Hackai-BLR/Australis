# Contrato del tramo: plantilla de curso y SDK

_Rama `tramo-plantilla-sdk`. Corre en paralelo con la fase 1 del núcleo. Solo se crean y modifican `sdk/`, `plantilla-curso/`, `contratos/tramo-plantilla-sdk.md` y `pruebas/tramo-plantilla-sdk/`. No se toca `nucleo/`, `interfaz/` ni `despliegue/`._

El contrato de identidad y entorno (`identidad.md` del orquestador) es fijo. Se transcribe en la sección 1 y todo lo demás se apoya en él.

## 1. Identidad y entorno (fijo)

Encabezado `X-Campus-Identidad: <carga>.<firma>`:

- `carga`: JSON UTF-8 en base64url sin relleno.
- `firma`: Ed25519 sobre los bytes ASCII de la cadena `<carga>` (no sobre el JSON), en base64url sin relleno (64 bytes).
- JSON: `{"v":1,"curso":"<id>","usuario":"<id>","email":"<mail>","nombre":"<nombre>","rol":"dueño"|"profesor"|"alumno","emitido":<epoch s>,"vence":<epoch s>}`.
- El núcleo borra `X-Campus-Identidad` y `Cookie` del navegador antes de reenviar al curso.

Variables del contenedor: `PORT` (3000), `CAMPUSIA_CURSO`, `CAMPUSIA_CLAVE_PUBLICA` (32 bytes en base64url sin relleno), `CAMPUSIA_API`, `CAMPUSIA_TOKEN_CURSO`, `CAMPUSIA_DATOS` (`/datos`). El curso no lee ninguna otra variable de la plataforma.

API de la plataforma para cursos, con `Authorization: Bearer $CAMPUSIA_TOKEN_CURSO`. `CAMPUSIA_API` es un origen con prefijo opcional (`http://nucleo:8080` o `http://host/plataforma`); las rutas se agregan al final, ignorando una barra final repetida:

| Método y ruta | Respuesta 200 |
|---|---|
| `GET {CAMPUSIA_API}/api/curso/yo` | `{"id":"redes","nombre":"Redes de Computadoras","periodo":"2.º cuatrimestre 2026"}` |
| `GET {CAMPUSIA_API}/api/curso/inscriptos` | `[{"id":"u-duenio","nombre":"Lucía Fernández","email":"lucia.fernandez@austral.edu.ar","rol":"dueño"}, ...]` (arreglo JSON plano) |

Errores de la plataforma: 401 token ausente o inválido, 403 sin permiso, 404, 5xx. El núcleo implementa estas dos rutas en la fase 2 con exactamente estos formatos.

## 2. Reglas de verificación de identidad

Se aplican en este orden. La primera que falla define el código de error.

| Orden | Condición de rechazo | `codigo` |
|---|---|---|
| 0 | `clavePublica` no decodifica a exactamente 32 bytes, o `curso` vacío | `configuracion` |
| 1 | Encabezado ausente, `null` o cadena vacía | `ausente` |
| 2 | Más de 4096 caracteres; no son exactamente dos partes separadas por un punto; caracteres fuera de `[A-Za-z0-9_-]`; firma que no decodifica a 64 bytes | `formato` |
| 3 | La firma Ed25519 no verifica con `clavePublica` | `firma` |
| 4 | La carga no es un objeto JSON; falta un campo; `curso`, `usuario`, `email`, `nombre` no son cadenas; `emitido` o `vence` no son enteros; `rol` no es exactamente `dueño`, `profesor` o `alumno` | `formato` |
| 5 | `v !== 1` | `version` (o `formato` si `v` no es número) |
| 6 | `curso !== CAMPUSIA_CURSO` (comparación exacta) | `curso` |
| 7 | `vence - emitido > 120` o `vence <= emitido` | `vigencia` |
| 8 | `ahora >= vence` | `vencido` |
| 9 | `emitido > ahora + 30` | `futuro` |

`ahora` es epoch en segundos. La identidad nunca se toma de cookies, de parámetros de consulta, de `Authorization` ni de otros encabezados (`X-Campus-Rol`, `X-Forwarded-User`, etc.).

## 3. SDK (`sdk/`, paquete `@campusia/sdk`)

- TypeScript compilado a ESM en `sdk/dist/`. `package.json`: `"name": "@campusia/sdk"`, `"type": "module"`, versión semver fija (empieza en `0.1.0`), `exports` con `"."` → `dist/index.js` (+ tipos) y `"./hono"` → `dist/hono.js` (+ tipos). Sin `dependencies`; `hono` va como `peerDependencies` (>=4) y en `devDependencies`. Ed25519 con `node:crypto`.
- Scripts: `build` (tsc), `test` (pruebas unitarias propias, por ejemplo `node --test` sobre `dist` o `vitest`), ambos sin red ni Docker.

### `@campusia/sdk`

```ts
export type Rol = 'dueño' | 'profesor' | 'alumno';
export interface Identidad { v: 1; curso: string; usuario: string; email: string; nombre: string; rol: Rol; emitido: number; vence: number }
export type CodigoErrorIdentidad = 'configuracion' | 'ausente' | 'formato' | 'firma' | 'version' | 'curso' | 'vigencia' | 'vencido' | 'futuro';
export class ErrorIdentidad extends Error { readonly codigo: CodigoErrorIdentidad }
export function verificarIdentidad(encabezado: string | null | undefined, opciones: { clavePublica: string; curso: string; ahora?: number }): Identidad;

export interface DatosCurso { id: string; nombre: string; periodo: string }
export interface Inscripto { id: string; nombre: string; email: string; rol: Rol }
export type CodigoErrorApi = 'configuracion' | 'no_autorizado' | 'prohibido' | 'no_encontrado' | 'servidor' | 'red' | 'respuesta_invalida';
export class ErrorApi extends Error { readonly codigo: CodigoErrorApi; readonly estado?: number }
export class ClienteCampus {
  constructor(opciones: { api: string; token: string; fetch?: typeof fetch });
  yo(): Promise<DatosCurso>;
  inscriptos(): Promise<Inscripto[]>;
}
export function clienteDesdeEntorno(env?: Record<string, string | undefined>): ClienteCampus;
```

- `verificarIdentidad` es sincrónica y lanza `ErrorIdentidad` según la sección 2. Devuelve los 8 campos de la carga.
- `ClienteCampus`: el constructor lanza `ErrorApi('configuracion')` si falta `api` o `token`. Cada pedido manda `Authorization: Bearer <token>` y `Accept: application/json`, con `redirect: 'manual'` (o `'error'`): una redirección es `respuesta_invalida` y el token nunca llega a otro servidor. Mapeo: 401 → `no_autorizado`, 403 → `prohibido`, 404 → `no_encontrado`, 5xx → `servidor` (con `estado`), fallo de conexión → `red`, 2xx con cuerpo que no es JSON o 3xx → `respuesta_invalida`. Nunca reenvía la identidad ni cookies.
- `clienteDesdeEntorno(env = process.env)` usa `CAMPUSIA_API` y `CAMPUSIA_TOKEN_CURSO`.

### `@campusia/sdk/hono`

```ts
export function identidadCampus(opciones?: { clavePublica?: string; curso?: string; ahora?: () => number }): MiddlewareHandler;
export function requiereRol(...roles: Rol[]): MiddlewareHandler;
export function obtenerIdentidad(c: Context): Identidad;
```

- `identidadCampus` lee `X-Campus-Identidad`; por defecto toma `CAMPUSIA_CLAVE_PUBLICA` y `CAMPUSIA_CURSO` del entorno. Si verifica, hace `c.set('identidad', identidad)`. Si no, responde `401 {"error":"identidad_invalida","codigo":"<codigo>"}`. Con configuración inválida también niega el acceso (401 con `codigo: "configuracion"` o 500); nunca deja pasar.
- `requiereRol(...roles)`: sin identidad en el contexto responde 401 `identidad_invalida`; si el rol no está en la lista responde `403 {"error":"prohibido"}`. El dueño cumple `'profesor'` (tiene todo lo del profesor); fuera de eso la comparación es exacta (`requiereRol('dueño')` no admite profesores, `requiereRol('alumno')` no admite docentes).
- `obtenerIdentidad(c)` devuelve la identidad del contexto o lanza si no hay.

## 4. Plantilla de curso (`plantilla-curso/`)

Proyecto autocontenido: es lo que el núcleo copia como repo inicial de cada curso, por eso la imagen se construye con `plantilla-curso/` como único contexto.

### Estructura obligatoria

| Archivo | Contenido |
|---|---|
| `package.json` | Node 22, Hono, better-sqlite3, React, Vite, TypeScript. Scripts `build` (frontend con Vite + servidor con tsc), `start` (`node` sobre el servidor compilado), `test`. Dependencia `"@campusia/sdk": "file:vendor/campusia-sdk-<versión del SDK>.tgz"` |
| `vendor/campusia-sdk-<versión>.tgz` | El SDK empaquetado con `pnpm pack`. Lo genera `pruebas/tramo-plantilla-sdk/correr.sh` (y el implementador con el mismo comando) desde `sdk/`. Versión fija: no se usan rangos ni `latest` |
| `Containerfile` | Multi-etapa (al menos dos `FROM`), ver más abajo |
| `.containerignore` y `.dockerignore` | Excluyen `node_modules`, `dist` y datos locales |
| `CLAUDE.md` | Reglas para el agente del curso (ver más abajo) |
| Código | Libre en su organización (por ejemplo `servidor/`, `web/`), con pruebas propias `*.test.ts` |

### Rutas del curso

Un solo proceso Node escucha en `PORT` y sirve API y frontend compilado. Todas las rutas, salvo `/salud`, pasan por `identidadCampus()` del SDK, incluidos `index.html` y los archivos estáticos.

| Método y ruta | Quién | Cuerpo | Respuesta | Errores |
|---|---|---|---|---|
| `GET /salud` | Cualquiera, sin identidad | — | `200 {"estado":"ok"}` | — |
| `GET /api/yo` | Todo inscripto | — | `200 {"usuario","email","nombre","rol"}` de la identidad | 401 |
| `GET /api/portada` | Todo inscripto | — | `200 {"curso":{"id","nombre","periodo"},"profesores":[{"nombre","rol"}],"clases":[Clase],"yo":{"nombre","rol"}}` | 401; `502 {"error":"plataforma_no_disponible"}` si `yo()` o `inscriptos()` fallan |
| `GET /api/clases` | Todo inscripto | — | `200 [Clase]` ordenadas por `numero` y luego `id` | 401 |
| `POST /api/clases` | Dueño y profesores (`requiereRol('profesor')`) | JSON `{"titulo","fecha"?,"contenido"?,"numero"?}` | `201 Clase` | 401; 403 `prohibido`; 415 `{"error":"tipo_no_admitido"}` si `Content-Type` no es `application/json`; 400 `{"error":"datos_invalidos"}`; 413 o 400 si el cuerpo supera 100 KB |
| `GET /api/*` otra | Todo inscripto | — | — | 401; `404 {"error":"no_encontrado"}` |
| `GET /*` otra | Todo inscripto | — | `200 text/html` (`index.html` de la SPA) o el archivo estático pedido | 401 |

- `Clase`: `{"id": entero, "numero": entero, "titulo": cadena, "fecha": "AAAA-MM-DD" | null, "contenido": cadena}`.
- Validación de `POST /api/clases`: `titulo` cadena de 1 a 200 caracteres sin contar espacios de los bordes (se guarda recortado); `fecha` opcional, `null` o fecha real `AAAA-MM-DD`; `contenido` opcional, cadena de hasta 20000 caracteres (por defecto `""`); `numero` opcional, entero `>= 0` (por defecto máximo actual + 1, o 1 si no hay clases).
- `profesores` en la portada: inscriptos con rol `dueño` o `profesor`, en el orden en que los da la plataforma, solo `nombre` y `rol`. La portada nunca incluye mails, ids ni alumnos.
- El curso puede cachear `yo()` hasta 60 segundos. Nunca reenvía `X-Campus-Identidad` ni cookies a la plataforma.
- Los 401 llevan el cuerpo JSON del middleware (`identidad_invalida`), también en rutas de HTML.
- Los archivos estáticos se sirven solo desde la carpeta compilada; rutas con `..` codificado no salen de ella.
- Nada de lo que se sirve contiene `CAMPUSIA_TOKEN_CURSO`, `CAMPUSIA_CLAVE_PUBLICA` ni `CAMPUSIA_API`.
- Sin `CAMPUSIA_CLAVE_PUBLICA` válida el proceso termina al arrancar o niega todo salvo `/salud`.

### Modelo de datos y migraciones

Base `${CAMPUSIA_DATOS}/curso.sqlite` (better-sqlite3, `journal_mode=WAL`). Las migraciones se aplican al arrancar, en orden, dentro de una transacción, y son idempotentes entre reinicios.

```sql
CREATE TABLE IF NOT EXISTS migraciones (version INTEGER PRIMARY KEY, aplicada TEXT NOT NULL);

-- versión 1
CREATE TABLE clases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero INTEGER NOT NULL,
  titulo TEXT NOT NULL,
  fecha TEXT,
  contenido TEXT NOT NULL DEFAULT '',
  creada TEXT NOT NULL
);
CREATE INDEX clases_numero ON clases(numero);
```

`creada` es ISO 8601 UTC y no se expone en la API.

### Interfaz del curso

Referencia: la función `contenido()` de `prototipo/campus.html` (el curso "Redes de Computadoras" con encabezado de color, título en serif Fraunces, lista de clases numeradas en tarjetas, y el estado "Curso nuevo / Todavía sin contenido" sobre fondo crema en Georgia). Es lo que se ve dentro del iframe `#curso` de la pantalla `v-curso`. La plantilla toma esa línea, no la de la plataforma:

- Identidad visual propia: títulos en serif (pila que termine en `serif`, nunca Inter ni una sans), un color de acento propio (por ejemplo el verde `#14402C`/`#2E7D5B` del prototipo). Las fuentes van empaquetadas en la imagen o son del sistema: el curso no pide nada fuera de su origen (sin Google Fonts ni CDN).
- `<html lang="es">`, `<meta name="viewport" ...>`. Responsive: a 375 px de ancho no hay desplazamiento horizontal.
- La SPA carga `/api/portada` y muestra:

| Selector | Contenido |
|---|---|
| `[data-prueba="curso-nombre"]` | `curso.nombre`, en el título principal (`h1`) |
| `[data-prueba="curso-periodo"]` | `curso.periodo` |
| `[data-prueba="curso-profesores"]` | Nombres de dueño y profesores |
| `[data-prueba="clase"]` | Una por clase, en orden, con número, título y fecha |
| `[data-prueba="clases-vacio"]` | Estado vacío, visible solo sin clases |
| `[data-prueba="rol"]` | Solo para dueño (`Dueño`) y profesor (`Profesor`): indicador discreto con ese texto exacto. No existe para alumnos |

- Los textos de la base se muestran como texto (React escapa); nunca `dangerouslySetInnerHTML`.
- Sin errores de JavaScript en la consola de la página.

### Containerfile

- Etapa de compilación (por ejemplo `node:22-alpine` o `node:22-slim` con pnpm vía corepack y lo necesario para better-sqlite3) y etapa final solo con Node, `node_modules` de producción y lo compilado.
- `WORKDIR /app`. Archivos de `/app` de root y no escribibles por el usuario del curso.
- Usuario sin privilegios (por ejemplo `node`, uid 1000), con `USER` explícito no root. Ni uid ni gid 0.
- `/datos` creado en la imagen y propiedad del usuario del curso, para que un volumen nuevo herede el dueño.
- Sin `gcc`, `g++`, `cc`, `make`, `python3`, `clang` en la imagen final, ni `typescript`, `vite`, `tsx`, `node-gyp`, `@vitejs/plugin-react` en `/app/node_modules`.
- Menos de 350 MB.
- Sin `ENV` de `CAMPUSIA_TOKEN_CURSO`, `CAMPUSIA_CLAVE_PUBLICA`, `CAMPUSIA_API` ni `CAMPUSIA_CURSO`. `ENV PORT=3000` y `CAMPUSIA_DATOS=/datos` como valores por defecto están permitidos.
- `EXPOSE 3000`. `HEALTHCHECK` sobre `/salud` con Node (sin curl ni wget), por ejemplo `--interval=10s --timeout=3s --start-period=5s`.
- Funciona con `--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --memory 256m`, escribiendo solo en `/datos` y `/tmp`.
- Construible con Docker y con Podman (`docker build -f plantilla-curso/Containerfile plantilla-curso`).

### CLAUDE.md de la plantilla

En castellano. Tiene que decir, como mínimo y con estas palabras clave: qué carpetas puede tocar el agente (el código del curso, no `vendor/` ni `Containerfile` salvo pedido); que la identidad y los datos de la plataforma se obtienen solo con `@campusia/sdk`; que el curso no maneja logins ni contraseñas; que no sale a internet; que no lee variables de entorno de la plataforma salvo las del contrato (`PORT`, `CAMPUSIA_CURSO`, `CAMPUSIA_CLAVE_PUBLICA`, `CAMPUSIA_API`, `CAMPUSIA_TOKEN_CURSO`, `CAMPUSIA_DATOS`); que los datos van en SQLite dentro de `CAMPUSIA_DATOS` con migraciones; que mantiene `/salud` sin identidad; que corre `pnpm test` (y `pnpm build`) antes de terminar; y el estilo: castellano, sin comentarios en el código.

## 5. Permisos

| Acción | Sin identidad | Alumno | Profesor | Dueño |
|---|---|---|---|---|
| `/salud` | Sí | Sí | Sí | Sí |
| Ver portada, clases, `/api/yo` | No (401) | Sí | Sí | Sí |
| Crear clases | No (401) | No (403) | Sí | Sí |
| Ver mails o datos de otros inscriptos | No | No | No (en esta plantilla) | No (en esta plantilla) |

## 6. Variables de entorno

Solo las de la sección 1. En pruebas: `CAMPUSIA_CURSO=redes`, `CAMPUSIA_TOKEN_CURSO=token-prueba-redes`, `CAMPUSIA_API=http://host.docker.internal:<puerto de la plataforma falsa>` (con `--add-host host.docker.internal:host-gateway`), `CAMPUSIA_CLAVE_PUBLICA` generada en cada corrida, `CAMPUSIA_DATOS=/datos` sobre un volumen nombrado. Ninguna clave real.

## 7. Compilar, levantar y probar

```bash
pnpm --dir sdk install && pnpm --dir sdk run build && pnpm --dir sdk test
rm -f plantilla-curso/vendor/campusia-sdk-*.tgz && pnpm --dir sdk pack --pack-destination plantilla-curso/vendor
pnpm --dir plantilla-curso install && pnpm --dir plantilla-curso run build && pnpm --dir plantilla-curso test
docker build -t campusia-curso:dev -f plantilla-curso/Containerfile plantilla-curso
docker run --rm -p 3000:3000 -v campusia-dev:/datos -e CAMPUSIA_CURSO=redes -e CAMPUSIA_CLAVE_PUBLICA=<clave> \
  -e CAMPUSIA_API=http://host.docker.internal:8080 -e CAMPUSIA_TOKEN_CURSO=token-prueba \
  --add-host host.docker.internal:host-gateway campusia-curso:dev
```

Todas las pruebas, desde cero y sin pasos manuales:

```bash
bash pruebas/tramo-plantilla-sdk/correr.sh
```

Hace: instala, compila y prueba el SDK; lo empaqueta en `plantilla-curso/vendor/`; instala, compila y prueba la plantilla; construye la imagen `campusia-curso:tramo-prueba` (sobreescribible con `IMAGEN_CURSO`) con `plantilla-curso/` como contexto; instala las dependencias de las pruebas (`hono`, `playwright-core` con el Chromium ya instalado en `~/.cache/ms-playwright`); corre con `node --test` en serie:

| Archivo | Tipo | Cubre |
|---|---|---|
| `sdk.aceptacion.test.mjs` | Aceptación | Paquete, `verificarIdentidad` válida (UTF-8, tolerancia, `ahora`), middleware, `requiereRol`, cliente `yo()`/`inscriptos()` contra una plataforma falsa, prefijo y entorno |
| `sdk.ataque.test.mjs` | Ataque | Ausente, otra clave, clave equivocada, carga alterada, firmas rotas, firma sobre el JSON, formatos, campos faltantes o de otro tipo, rol desconocido, versión, otro curso, vencido, futuro, vigencia larga, configuración inválida; middleware con cookie, `Authorization` o consulta; 403 de roles; errores tipados del cliente, token equivocado, JSON inválido, red caída, redirección que intenta llevarse el token |
| `repo.test.mjs` | Aceptación | `CLAUDE.md`, `Containerfile` multi-etapa con `USER` y `HEALTHCHECK`, pruebas propias, código sin comentarios |
| `curso.aceptacion.test.mjs` | Aceptación | Contenedor endurecido con volumen: `/salud`, portada HTML, `/api/yo` por rol, `/api/portada` desde la plataforma, token correcto y sin reenviar identidad, clases vacías, crear como profesor y dueño, orden, persistencia al recrear el contenedor con el mismo volumen |
| `curso.ataque.test.mjs` | Ataque | En todas las rutas: sin encabezado, firma inválida, carga alterada, otro curso, vencido, futuro, vigencia larga, versión, rol inventado, clave pública equivocada, cookie, consulta, `Authorization`, encabezados inventados; alumno creando clases; formularios no JSON (415); datos inválidos; cuerpo enorme; 404 de API; alumno sin acceso a mails de otros; sin fugas de token, clave ni URL; recorrido de carpetas; plataforma caída (502); sin clave pública |
| `imagen.ataque.test.mjs` | Ataque | `USER` no root, procesos sin root, `/app` no escribible, `/datos` escribible con `curso.sqlite`, sin herramientas de compilación ni dependencias de desarrollo, menos de 350 MB, sin secretos en `ENV`, `HEALTHCHECK` sano, SDK de versión fija igual a `sdk/package.json`, escucha en `PORT` |
| `interfaz.aceptacion.test.mjs` | Aceptación | Con Chromium: portada del alumno (nombre, período, docentes, estado vacío, sin indicador de rol, sin pedidos externos, sin errores, `lang="es"`), clases en orden y texto con HTML sin ejecutarse, indicador `Dueño`/`Profesor`, serif propia, 375 px sin desplazamiento horizontal, 401 sin identidad |

No hay pruebas de fases anteriores en esta rama: la fase 1 corre en paralelo en otra rama. Al integrar, el verificador corre también `pruebas/<fase>/correr.sh` de cada fase.

## 8. Criterio de terminado

`bash pruebas/tramo-plantilla-sdk/correr.sh` termina con código 0 desde un árbol limpio (sin `node_modules`, sin `dist`, sin imagen previa), y las pruebas propias de `sdk/` y `plantilla-curso/` pasan.

## Cambios en las pruebas

- 2026-11-10: `imagen.ataque.test.mjs`, prueba «el proceso del curso no corre como root». Llamaba a `docker top <contenedor> -o user`, que Docker siempre rechaza («Couldn't find PID field in ps output») porque exige la columna PID; ninguna imagen que cumpla la sección de imagen podía pasarla, lo que contradice el contrato. Se cambió a `-o pid,user` y se lee la segunda columna de cada proceso. La aserción es la misma: ningún proceso del contenedor corre como root.
