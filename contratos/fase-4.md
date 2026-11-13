# Contrato de la fase 4: datos de la plataforma, resguardo y endurecimiento

_Escrito: 2026-11-10. Referencias: `CONVENCIONES.md`, `handoffs/261110_0400_plan-implementacion-plataforma.md`, `contratos/fase-1.md`, `contratos/fase-2.md`, `contratos/identidad-cursos.md`, `contratos/tramo-plantilla-sdk.md`, `contratos/tramo-resguardo.md`, `.orquestacion/fase-4.md` y `prototipo/campus.html`._

Este contrato es la fuente de verdad para implementar la fase 4. Las pruebas de `pruebas/fase-4/` lo verifican. Si algo de acá no coincide con una prueba, manda la prueba y se avisa en el handoff. Las pruebas no se cambian para que pasen. Todo lo de `contratos/fase-1.md` y `contratos/fase-2.md` sigue vigente salvo lo que este contrato cambia explícitamente.

## 1. Módulos y carpetas

| Módulo | Carpetas | Qué entrega |
|---|---|---|
| Núcleo | `nucleo/` | Migración `4001_datos.sql`; archivos, registro de entregas y registro de notas en la API de la plataforma y en la API para cursos (con identidad delegada); `GET /api/owner/estado`; endurecimiento (encabezados de seguridad, límites de cuerpo, tiempos de espera, límites de frecuencia, registros sin secretos) y revisión de seguridad del núcleo |
| Plantilla y SDK | `sdk/`, `plantilla-curso/` | Métodos nuevos de `ClienteCampus` y `encabezadoIdentidad` en `@campusia/sdk/hono` (versión `0.2.0`); ejemplo mínimo de entrega y de nota en la plantilla (rutas del servidor y sección "Entregas" de la SPA) |
| Interfaz y despliegue | `interfaz/`, `despliegue/` | Pestaña "Estado" del panel de owner; variables nuevas en la unidad y en el ejemplo de entorno; `instalar.sh` crea `archivos/` y `respaldos/`; `request_body` en el Caddyfile; `respaldar.sh` omite `archivos/.subiendo/` |

Cada módulo toca solo sus carpetas. Nadie toca `pruebas/`, `contratos/`, `prototipo/`, `handoffs/` ni `.orquestacion/`. La interfaz tiene que seguir funcionando con los encabezados de seguridad de la sección 11 (los pone el núcleo): no usa scripts en línea, `eval` ni recursos de otros orígenes salvo Turnstile.

Convivencia con la fase 3 (corre al mismo tiempo en otra rama): la migración nueva usa el prefijo `4xxx`; el código nuevo del núcleo va en módulos propios (por ejemplo `archivos.rs`, `registros.rs`, `estado.rs`, `endurecimiento.rs`) y en los archivos compartidos (`main.rs`, `config.rs`, `servidor.rs`, `api_cursos.rs`) solo se agregan las rutas, las variables y las capas; el SDK y la plantilla se extienden sin cambiar lo que ya existe (`yo()`, `inscriptos()`, `identidadCampus`, `requiereRol`, `obtenerIdentidad`, la línea `  app.get('/salud', (c) => c.json({ estado: 'ok' }));` de `servidor/app.ts` que usan las pruebas espía).

## 2. Compilar, levantar y probar

### Compilar

```bash
. "$HOME/.cargo/env"
cargo build --manifest-path nucleo/Cargo.toml
pnpm --dir interfaz install && pnpm --dir interfaz run build
pnpm --dir sdk install && pnpm --dir sdk run build
rm -f plantilla-curso/vendor/campusia-sdk-*.tgz && pnpm --dir sdk pack --pack-destination plantilla-curso/vendor
pnpm --dir plantilla-curso install && pnpm --dir plantilla-curso run build
```

### Levantar en desarrollo

Igual que en la fase 2, más las carpetas de esta fase:

```bash
export DATABASE_URL=sqlite:///tmp/campusia/datos/campusia.db DOMINIO_BASE=campusia.prueba ENTORNO=desarrollo \
  PROVEEDOR_EMAIL=archivo ARCHIVO_EMAIL=/tmp/campusia/mails.jsonl SESSION_SECRET=$(openssl rand -hex 32) \
  TURNSTILE_SITE_KEY=1x00000000000000000000AA TURNSTILE_SECRET=1x0000000000000000000000000000000AA \
  INTERFAZ_DIR=$PWD/interfaz/dist EMAIL_FROM=no-responder@campusia.prueba \
  PROVEEDOR_CONTENEDORES=docker RAIZ_CURSOS=/tmp/campusia/cursos PLANTILLA_CURSO_DIR=$PWD/plantilla-curso SDK_DIR=$PWD/sdk \
  RAIZ_ARCHIVOS=/tmp/campusia/archivos DIR_RESPALDOS=/tmp/campusia/respaldos
mkdir -p /tmp/campusia/datos
nucleo/target/debug/campusia-nucleo migrar
nucleo/target/debug/campusia-nucleo sembrar pruebas/fase-4/datos.json
nucleo/target/debug/campusia-nucleo crear-owner equipo@campusia.prueba
nucleo/target/debug/campusia-nucleo
```

Respaldo y restauración de prueba sobre esa carpeta:

```bash
CAMPUSIA_RAIZ=/tmp/campusia bash despliegue/respaldo/respaldar.sh
CAMPUSIA_RAIZ=/tmp/campusia CAMPUSIA_USUARIO=$(id -un) CAMPUSIA_GRUPO=$(id -gn) \
  bash despliegue/respaldo/restaurar.sh --destino /tmp/campusia-restaurado /tmp/campusia/respaldos/<AAAAMMDD-HHMMSS>
```

### Probar

```bash
bash pruebas/fase-4/correr.sh
```

Corre, en este orden y desde cero, sin pasos manuales, y sigue aunque una parte falle (termina con código distinto de 0 si alguna falló):

1. `pruebas/tramo-plantilla-sdk/correr.sh` (SDK, plantilla e imagen del curso, con una etiqueta de imagen propia de la corrida en `IMAGEN_CURSO` que se borra al final).
2. `pruebas/tramo-resguardo/correr.sh`.
3. `pruebas/correr.sh` (Playwright): compila el núcleo, la interfaz y el SDK (y lo empaqueta en `plantilla-curso/vendor/`), y corre todas las carpetas `pruebas/fase-*/`: las pruebas de aceptación, ataque y despliegue de las fases 1, 2 y 4, y las de la fase 3 cuando se una su rama.

Con argumentos (`bash pruebas/fase-4/correr.sh fase-4/ataque`) o con `SOLO_PLAYWRIGHT=1` corre solo Playwright con esos argumentos. `CAMPUSIA_SIN_COMPILAR=1` y `PRUEBAS_WORKERS` funcionan como en las fases anteriores.

Requisitos: los de la fase 2 (Docker sin sudo, `node:22-alpine` y `caddy:2.8.4` o red para bajarlas, `git`, Node 22, pnpm y Rust) más `sqlite3`, `tar`, `gzip`, `sha256sum` y `flock` para el resguardo.

Cada worker levanta su propio núcleo (`pruebas/comun/nucleo.ts`) con `RAIZ_ARCHIVOS` y `DIR_RESPALDOS` en su carpeta temporal. Las pruebas que necesitan un curso con contenedor (`aceptacion/curso-sdk.spec.ts` y `ataque/api-curso.spec.ts`) usan el núcleo con Docker de la fase 2 y fijan `IDENTIDAD_CLAVE_PRIVADA` para poder firmar identidades de prueba. Las demás corren con `PROVEEDOR_CONTENEDORES=ninguno` sobre los cursos sembrados: los servicios de esta fase funcionan para cualquier curso que exista, tenga o no repo y contenedor.

## 3. Variables de entorno nuevas

| Variable | Por defecto | Uso |
|---|---|---|
| `RAIZ_ARCHIVOS` | `/srv/campusia/archivos` | Carpeta de los archivos de los cursos. El núcleo la crea (modo `0700`) si no existe, al arrancar o en la primera subida |
| `DIR_RESPALDOS` | `/srv/campusia/respaldos` | Carpeta donde `respaldar.sh` deja los respaldos. El núcleo solo la lee para la página de estado; si no existe, no hay respaldos |
| `ARCHIVOS_CUOTA_CURSO` | `1073741824` | Bytes máximos que pueden sumar los archivos de un curso |
| `ARCHIVOS_MAX_BYTES` | `26214400` | Tamaño máximo de un archivo |
| `ARCHIVOS_TIPOS` | `pdf,txt,md,csv,json,png,jpg,jpeg,gif,webp,zip,docx,xlsx,pptx,odt,ods,odp,ipynb,py,c,cpp,h,java,ts,sql` | Extensiones permitidas, separadas por comas, sin distinguir mayúsculas |
| `LIMITE_CUERPO_JSON` | `262144` | Bytes máximos de un cuerpo en las rutas JSON (salvo la importación del SIU, que sigue en 4 MB) |
| `LIMITE_API_MINUTO` | `1000` | Pedidos a `/api/*` por minuto por sesión o por token personal |
| `LIMITE_API_CURSO_MINUTO` | `6000` | Pedidos por minuto por token de curso en la escucha para cursos |
| `TIEMPO_ESPERA_ENCABEZADOS_SEG` | `15` | Tiempo máximo para recibir los encabezados de un pedido, en las dos escuchas |
| `TIEMPO_ESPERA_CUERPO_SEG` | `120` | Tiempo máximo para recibir el cuerpo de un pedido |

Un valor que no es un entero positivo hace que el núcleo no arranque, con un mensaje claro.

## 4. Modelo de datos

Migración nueva `nucleo/migraciones/4001_datos.sql`. Las anteriores no se modifican. Las columnas marcadas con * las leen o escriben las pruebas.

```sql
archivos(id* TEXT PK,                         -- 32 caracteres hexadecimales en minúscula, de un CSPRNG
         curso_id* TEXT NOT NULL REFERENCES cursos(id),
         usuario_id INTEGER NOT NULL REFERENCES usuarios(id),   -- quien lo subió
         nombre* TEXT NOT NULL,                -- nombre original ya normalizado (sección 5)
         extension TEXT NOT NULL,              -- en minúscula
         tamano* INTEGER NOT NULL,
         sha256* TEXT NOT NULL,                -- hexadecimal en minúscula
         material INTEGER NOT NULL DEFAULT 0,
         via TEXT NOT NULL CHECK (via IN ('plataforma','curso')),
         creado_en TEXT NOT NULL)

entregas(id* INTEGER PK,
         curso_id TEXT NOT NULL REFERENCES cursos(id),
         usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
         actividad TEXT NOT NULL,
         texto* TEXT NULL,
         archivo_id TEXT NULL REFERENCES archivos(id),
         via TEXT NOT NULL CHECK (via IN ('plataforma','curso')),
         creada_en* TEXT NOT NULL)

notas(id* INTEGER PK,
      curso_id TEXT NOT NULL REFERENCES cursos(id),
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id),      -- el alumno
      actividad TEXT NOT NULL,
      valor* TEXT NOT NULL,
      comentario TEXT NULL,
      anterior* TEXT NULL,                    -- valor vigente antes de esta nota, o NULL
      autor_id INTEGER NOT NULL REFERENCES usuarios(id),
      via TEXT NOT NULL CHECK (via IN ('plataforma','curso')),
      creada_en TEXT NOT NULL)
```

- Índices por `(curso_id, id)` en las tres tablas y por `(curso_id, usuario_id, actividad)` en `notas`.
- Las tres tablas solo se agregan: triggers `BEFORE UPDATE` y `BEFORE DELETE` que hacen `RAISE(ABORT, ...)` en cada una, como `auditoria`. Un `UPDATE` o un `DELETE` directo sobre la base falla.
- Todas las fechas son de la plataforma (el reloj del núcleo), en RFC 3339 UTC. Nunca se toman del cuerpo del pedido.
- La nota vigente de un alumno en una actividad es la de mayor `id` para `(curso_id, usuario_id, actividad)`. Al insertar una nota, `anterior` es el `valor` de la vigente en ese momento (o `NULL`), dentro de la misma transacción.

## 5. Archivos en el disco

- Cada archivo vive en `RAIZ_ARCHIVOS/<curso_id>/<id>`: el nombre interno es el `id`, sin extensión y sin nada del nombre que mandó el usuario. Carpetas `0700`, archivos `0600`.
- La subida se escribe primero en `RAIZ_ARCHIVOS/.subiendo/<aleatorio>` mientras se calculan el tamaño y el SHA-256; si todo está bien se renombra a su lugar definitivo y se inserta la fila; si algo falla (tamaño, cuota, conexión cortada, tiempo) se borra el temporal y no queda nada. `respaldar.sh` no copia `.subiendo/`.
- Los archivos nunca se montan en un contenedor ni se pasan rutas suyas a los cursos.
- Al servir un archivo, el núcleo comprueba que el tamaño y el SHA-256 del contenido coincidan con la fila. Si no coinciden responde `500 {"error":"archivo_alterado"}` sin mandar el contenido y lo deja en el registro (sin el contenido).

### Nombre

El parámetro `nombre` se normaliza así: se recortan los espacios de los bordes; las `\` pasan a `/`; se toma lo que sigue a la última `/` y se vuelve a recortar. El resultado se rechaza con `400 nombre_invalido` si está vacío, es `.` o `..`, tiene caracteres de control (U+0000 a U+001F o U+007F) o tiene más de 200 caracteres. Ejemplos: `../../x.txt` queda `x.txt`; `a/b/c.txt` queda `c.txt`; `..\..\y.txt` queda `y.txt`; `../` y `dir/` se rechazan.

### Tipo

La extensión es lo que sigue al último `.` del nombre normalizado, en minúscula (sin `.`, o con el `.` solo al principio, no hay extensión). Si no está en `ARCHIVOS_TIPOS`: `400 tipo_no_permitido`.

El `Content-Type` con que se sirve depende solo de la extensión, con esta tabla fija; todo lo demás, incluso si se agrega a `ARCHIVOS_TIPOS` (`html`, `htm`, `xhtml`, `svg`, `xml`, `js`, `mjs`, `css` y cualquier otra), se sirve como `application/octet-stream`:

| Extensión | `Content-Type` |
|---|---|
| `pdf` | `application/pdf` |
| `png`, `gif`, `webp` | `image/png`, `image/gif`, `image/webp` |
| `jpg`, `jpeg` | `image/jpeg` |
| `txt`, `md`, `csv`, `py`, `c`, `cpp`, `h`, `java`, `ts`, `sql`, `ipynb` | `text/plain; charset=utf-8` |
| `json` | `application/json` |
| `zip` | `application/zip` |
| `docx`, `xlsx`, `pptx` | los tipos OOXML (`application/vnd.openxmlformats-officedocument...`) |
| `odt`, `ods`, `odp` | los tipos OpenDocument (`application/vnd.oasis.opendocument...`) |

### Descarga

Toda descarga (en la API de la plataforma y en la API para cursos) lleva:

- `Content-Disposition: attachment; filename*=UTF-8''<nombre>`, con el nombre en UTF-8 codificado por porcentajes (RFC 5987: solo quedan sin codificar letras ASCII, dígitos y `!#$&+-.^_`|~`). Puede agregar `filename="<respaldo ASCII>"`, donde los caracteres no ASCII, de control, `"`, `\` y `;` se reemplazan por `_`.
- `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: private, no-store` y `Content-Length`.
- Nunca `Access-Control-Allow-Origin`.

## 6. Rutas de la API de la plataforma

Las reglas generales de las fases 1 y 2 siguen: JSON, errores `{"error","mensaje"}`, control de `Origin` y `X-Campusia: 1` en las modificaciones con cookie, orden de los controles (host, origen, autenticación, límite de frecuencia, `requiere_sesion`, `permiso_del_token`, inscripción, rol, validación, alcance, conflictos). Funcionan en `DOMINIO_BASE` y en `<id>.DOMINIO_BASE`. En `<id>-curso.DOMINIO_BASE` todo se reenvía al curso, como en la fase 2.

"Inscripto" es cualquiera con inscripción en el curso; "docente" es dueño o profesor del curso. Si quien llama no está inscripto (aunque sea administrador u owner) o el curso no existe: `404 no_encontrado`, antes de mirar el cuerpo. Si está inscripto pero no tiene el rol: `403 prohibido`.

Códigos de error nuevos:
- 400: `nombre_invalido`, `tipo_no_permitido`, `no_es_alumno`. Se reusa `datos_invalidos`.
- 409: `cuota_excedida`.
- 413: `archivo_demasiado_grande`, `cuerpo_demasiado_grande`.
- 429: `demasiados_intentos` (límite de frecuencia, con `Retry-After` en segundos).
- 500: `archivo_alterado`.

| Método y ruta | Quién | Token | Cuerpo | Respuesta |
|---|---|---|---|---|
| `GET /api/cursos/{id}/archivos` | inscripto | `cursos:leer` | | `200 {"archivos":[Archivo],"usado","cuota"}` |
| `POST /api/cursos/{id}/archivos?nombre=<n>[&material=1]` | inscripto; `material=1` solo docentes | `cursos:escribir` | el archivo, crudo | `201 Archivo` |
| `GET /api/cursos/{id}/archivos/{archivo_id}` | inscripto que lo puede ver | `cursos:leer` | | `200` con el contenido (sección 5) |
| `GET /api/cursos/{id}/entregas[?actividad=&usuario=]` | inscripto | `cursos:leer` | | `200 {"entregas":[Entrega]}` |
| `POST /api/cursos/{id}/entregas` | inscripto | `cursos:escribir` | `{"actividad","texto"?,"archivo_id"?}` | `201 Entrega` |
| `GET /api/cursos/{id}/notas[?actividad=&usuario=]` | inscripto | `cursos:leer` | | `200 {"notas":[NotaVigente]}` |
| `GET /api/cursos/{id}/notas/historial[?actividad=&usuario=]` | docente | `cursos:leer` | | `200 {"notas":[Nota]}` |
| `POST /api/cursos/{id}/notas` | docente | `cursos:escribir` | `{"usuario_id","actividad","valor","comentario"?}` | `201 Nota` |
| `GET /api/owner/estado` | owner | `owner:leer` | | `200 Estado` (sección 10) |

No hay rutas para editar ni borrar archivos, entregas ni notas: cualquier otro método sobre esas rutas, o sobre `.../entregas/{id}`, `.../notas/{id}` y `.../archivos/{archivo_id}` con `PUT`, `PATCH`, `DELETE` o `POST`, responde `404` o `405` y no cambia nada.

Formatos (en esta API los `id` de personas son números):

- `Archivo`: `{"id","nombre","tipo","tamano","sha256","material","usuario":{"id","nombre"},"fecha"}`. `tipo` es el `Content-Type` de la tabla de la sección 5.
- `Entrega`: `{"id","actividad","texto","archivo":Archivo|null,"usuario":{"id","nombre","email"},"fecha","via":"plataforma"|"curso"}`. `texto` es `null` si no hay.
- `Nota`: `{"id","actividad","valor","comentario","anterior","usuario":{"id","nombre","email"},"autor":{"id","nombre"},"fecha","via"}`.
- `NotaVigente`: igual que `Nota` pero sin `anterior`.

### Archivos

- Visibilidad: los docentes ven y bajan todos los archivos del curso. Un alumno ve y baja los que subió él y los marcados como material. Un archivo que no se puede ver, que es de otro curso, que no existe o cuyo id no tiene el formato responde `404 no_encontrado` (o `400` si el id no tiene el formato).
- La lista va en el orden en que se subieron. `usado` es la suma de `tamano` de todos los archivos del curso (los vea o no quien pregunta) y `cuota` es `ARCHIVOS_CUOTA_CURSO`.
- Subida, en este orden después de los controles generales: `nombre` (falta o inválido: `400 nombre_invalido`), tipo (`400 tipo_no_permitido`), `material=1` de un alumno (`403 prohibido`), tamaño (un `Content-Length` mayor que `ARCHIVOS_MAX_BYTES` se rechaza sin leer el cuerpo; si el cuerpo pasa el máximo mientras se lee, se corta: `413 archivo_demasiado_grande`), cuota (si `usado + tamaño > cuota`: `409 cuota_excedida`). El `Content-Type` del pedido se ignora. La cuota se controla de forma atómica por curso: subidas simultáneas nunca hacen que `usado` pase la cuota. Un archivo rechazado no deja nada en la base ni en el disco.

### Entregas

- Cualquier inscripto entrega, siempre a su nombre: la persona sale de la sesión o del token, nunca del cuerpo. La fecha es la de la plataforma y `via` es `plataforma`. Los campos que no son `actividad`, `texto` ni `archivo_id` se ignoran.
- `actividad`: `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`. `texto`: cadena de hasta 20000 caracteres; vacía o solo con espacios cuenta como ausente. Tiene que haber `texto` o `archivo_id`. Si no: `400 datos_invalidos`.
- `archivo_id` tiene que ser un archivo de ese curso subido por la misma persona; si no: `404 no_encontrado` (o `400` si no tiene el formato). Un archivo se puede usar en más de una entrega.
- Lista, en orden de `id`: los docentes ven todas las del curso; un alumno, solo las suyas. `actividad` filtra por actividad. `usuario` (id numérico) filtra por persona; un alumno que pide otra persona recibe `403 prohibido`. Un filtro mal formado: `400 datos_invalidos`.

### Notas

- Solo docentes ponen notas (alumnos: `403 prohibido`). `usuario_id` (número o cadena de dígitos) tiene que ser una persona inscripta en ese curso (si no: `404 no_encontrado`) como `alumno` (si es docente: `400 no_es_alumno`). `actividad` como en las entregas. `valor`: cadena que, recortada, tiene de 1 a 20 caracteres (se guarda recortada). `comentario`: cadena de hasta 2000 caracteres o `null`; vacía cuenta como `null`. Si no: `400 datos_invalidos`.
- Cada nota o cambio de nota agrega una fila nueva con el autor, la fecha de la plataforma y el valor anterior. Nada se pisa.
- `GET .../notas`: las vigentes, ordenadas por actividad y nombre del alumno. Los docentes ven las de todos; un alumno, solo las suyas (pedir otra persona: `403 prohibido`). No incluyen `anterior`.
- `GET .../notas/historial`: todas las filas en orden de `id`, con los mismos filtros. Solo docentes (alumnos: `403 prohibido`).

## 7. API de datos para cursos

En la escucha para cursos (`DIRECCION_API_CURSOS:PUERTO_API_CURSOS`, fase 2) se agregan las mismas operaciones bajo `/api/curso/`, con `Authorization: Bearer <CAMPUSIA_TOKEN_CURSO>` y, además, el encabezado `X-Campus-Identidad` que el curso recibió en el pedido de la persona a la que está atendiendo. El curso actúa siempre en nombre de esa persona y con los permisos que esa persona tiene en ese momento; el token solo no alcanza para leer ni escribir datos de nadie.

| Método y ruta | Equivale a |
|---|---|
| `GET /api/curso/archivos` | `GET /api/cursos/{id}/archivos` |
| `POST /api/curso/archivos?nombre=<n>[&material=1]` | `POST /api/cursos/{id}/archivos` |
| `GET /api/curso/archivos/{archivo_id}` | `GET /api/cursos/{id}/archivos/{archivo_id}` |
| `GET /api/curso/entregas[?actividad=&usuario=]` | `GET /api/cursos/{id}/entregas` |
| `POST /api/curso/entregas` | `POST /api/cursos/{id}/entregas` |
| `GET /api/curso/notas[?actividad=&usuario=]` | `GET /api/cursos/{id}/notas` |
| `GET /api/curso/notas/historial[?actividad=&usuario=]` | `GET /api/cursos/{id}/notas/historial` |
| `POST /api/curso/notas` | `POST /api/cursos/{id}/notas` |

`{id}` es el curso del token. Mismos cuerpos, validaciones, errores, formatos y reglas de visibilidad que en la sección 6, con estas diferencias:

- Los `id` de personas (`usuario.id`, `autor.id`, el filtro `usuario` y `usuario_id` en el cuerpo) son cadenas, como en `GET /api/curso/inscriptos`. `usuario_id` acepta también números.
- Lo que se crea por acá queda con `via: "curso"`.
- No hay control de `Origin`.

Orden de los controles:

1. Token del curso (fase 2). Sin token o con uno que no es de un curso vigente: `401 {"error":"no_autenticado"}`.
2. Límite de frecuencia por token (`LIMITE_API_CURSO_MINUTO`): `429 demasiados_intentos`.
3. Identidad. El núcleo verifica `X-Campus-Identidad` con su propia clave pública y las reglas de `contratos/identidad-cursos.md`: formato `<carga>.<firma>` en base64url sin relleno (hasta 4096 bytes), firma Ed25519 válida, `v = 1`, `curso` igual al curso del token, `vence` en el futuro, `emitido` no más de 30 segundos en el futuro y `vence - emitido` de 120 segundos como mucho. Si falta o falla cualquiera: `401 {"error":"identidad_invalida"}`.
4. Inscripción: la persona `usuario` tiene que estar inscripta en el curso en ese momento. Si no: `403 prohibido`. El rol que vale es el de `inscripciones`, no el `rol` de la carga.
5. Rol, validación, alcance y conflictos, como en la sección 6.

Cualquier otra ruta o método en la escucha para cursos sigue respondiendo `404`, con o sin token (en particular `PUT`, `PATCH` y `DELETE` sobre todas estas rutas). En la escucha principal, `/api/curso/*` sigue respondiendo `404`, y el token de un curso sigue sin servir en ninguna ruta de la plataforma (`401`).

## 8. SDK (`@campusia/sdk` 0.2.0)

Se agregan, sin cambiar lo existente:

`@campusia/sdk/hono`:
- `encabezadoIdentidad(c): string`: el valor crudo de `X-Campus-Identidad` del pedido ya verificado por `identidadCampus()`. Si no hay identidad verificada, lanza `ErrorIdentidad('ausente')`.

`ClienteCampus` (todos reciben primero `identidad`, el valor crudo del encabezado, y lo mandan como `X-Campus-Identidad`; usan `redirect: 'manual'` y el mismo tiempo máximo que `yo()`):

| Método | Ruta | Devuelve |
|---|---|---|
| `subirArchivo(identidad, { nombre, contenido, material? })` | `POST /api/curso/archivos` | `Archivo`. `contenido` es `Uint8Array`, `ArrayBuffer` o `Blob` |
| `archivos(identidad)` | `GET /api/curso/archivos` | `{ archivos: Archivo[], usado, cuota }` |
| `bajarArchivo(identidad, id)` | `GET /api/curso/archivos/{id}` | `{ nombre, tipo, contenido: Uint8Array }`, con `nombre` sacado de `filename*` |
| `entregar(identidad, { actividad, texto?, archivoId? })` | `POST /api/curso/entregas` | `Entrega` |
| `entregas(identidad, { actividad?, usuario? }?)` | `GET /api/curso/entregas` | `Entrega[]` |
| `ponerNota(identidad, { usuario, actividad, valor, comentario? })` | `POST /api/curso/notas` | `Nota` |
| `notas(identidad, { actividad?, usuario? }?)` | `GET /api/curso/notas` | `NotaVigente[]` |
| `historialNotas(identidad, { actividad?, usuario? }?)` | `GET /api/curso/notas/historial` | `Nota[]` |

Los tipos `Archivo`, `Entrega`, `Nota` y `NotaVigente` se exportan con los campos de las secciones 6 y 7 (ids de personas como cadenas). Los errores son `ErrorApi`; `CodigoErrorApi` agrega `datos_invalidos`, `nombre_invalido`, `tipo_no_permitido`, `no_es_alumno`, `cuota_excedida`, `archivo_demasiado_grande`, `identidad_invalida` y `demasiados_intentos`: cuando la plataforma responde un error con uno de esos códigos en `error`, `ErrorApi.codigo` es ese código; si no, se mantiene la regla por estado de hoy (`401` → `no_autorizado`, `403` → `prohibido`, `404` → `no_encontrado`, `5xx` → `servidor`). Un `identidad` que no es una cadena no vacía de caracteres visibles ASCII se manda igual y la plataforma lo rechaza (`identidad_invalida`).

La versión del paquete pasa a `0.2.0`, y la plantilla depende de `file:vendor/campusia-sdk-0.2.0.tgz`. Las pruebas propias de `sdk/` cubren los métodos nuevos con un `fetch` falso.

## 9. Plantilla: ejemplo mínimo de entrega y de nota

Servidor (`plantilla-curso/servidor/`), todo detrás de `identidadCampus()`, pasando a la plataforma la identidad del pedido con `encabezadoIdentidad(c)`:

| Ruta | Quién | Qué hace |
|---|---|---|
| `GET /api/entregas` | inscripto | `{ entregas }` con `entregas(identidad)` |
| `POST /api/entregas` | inscripto | `multipart/form-data` con `actividad`, `texto` y `archivo` (opcional). Si hay archivo lo sube con `subirArchivo` y después llama a `entregar`. Responde `201` con la entrega |
| `GET /api/archivos/:id` | inscripto | Baja el archivo con `bajarArchivo` y lo devuelve con los mismos encabezados de descarga de la sección 5 |
| `GET /api/notas` | inscripto | `{ notas }` con `notas(identidad)` |
| `GET /api/notas/historial` | docente | `{ notas }` con `historialNotas(identidad)` |
| `POST /api/notas` | docente | JSON `{ usuario, actividad, valor, comentario? }` con `ponerNota` |

Los errores de la plataforma se devuelven con el mismo estado (`4xx`) y `{ error }`; si la plataforma no responde, `502`. El límite de cuerpo de `POST /api/entregas` es `ARCHIVOS_MAX_BYTES` por defecto (25 MB) más el resto del formulario. La plantilla no guarda copias de los archivos ni de las entregas en su base.

SPA (`plantilla-curso/web/`), con la identidad visual propia de la plantilla, una sección `[data-prueba="entregas"]` en la portada (en el prototipo, el recuadro "Entregas" del lateral del curso):

- Para todos: una lista con un `[data-prueba="entrega"]` por entrega visible, con `data-actividad="<actividad>"` y `data-usuario="<id de la persona>"`, que muestra la actividad, el texto (si hay), el nombre del archivo como enlace `[data-prueba="entrega-descarga"]` a `/api/archivos/<id>` (si hay) y la fecha. Para los docentes, además, el nombre de la persona.
- Alumnos: un formulario con `[data-prueba="entrega-actividad"]` (texto), `[data-prueba="entrega-texto"]` (área de texto), `[data-prueba="entrega-archivo"]` (`input type="file"`) y `[data-prueba="entrega-enviar"]`. Al enviar, la lista se actualiza sin recargar. Sus notas vigentes, un `[data-prueba="nota"]` por nota con `data-actividad`, que muestra la actividad y el valor.
- Docentes: en cada `[data-prueba="entrega"]` de un alumno, `[data-prueba="nota-valor"]` (texto) y `[data-prueba="nota-guardar"]`, que pone la nota de esa persona en esa actividad. Debajo, el historial: un `[data-prueba="nota-historial"]` por fila, con el nombre del alumno, la actividad, el valor, el valor anterior, quién la puso y la fecha; se actualiza al guardar. Los alumnos no ven historial.

Las pruebas existentes de la plantilla (`pruebas/tramo-plantilla-sdk/`) tienen que seguir pasando.

## 10. Página de estado del owner

`GET /api/owner/estado` (solo owner; token `owner:leer`; los demás `403 prohibido`; `Cache-Control: no-store`):

```json
{
  "nucleo": {"ok": true, "version": "<versión del binario>", "arranque": "<RFC 3339>", "segundos_activo": 0},
  "contenedores": {"proveedor": "docker" | "ninguno", "encendidos": 0, "cursos": 0},
  "disco": {"total_bytes": 0, "libres_bytes": 0},
  "archivos": {"cantidad": 0, "bytes": 0},
  "respaldo": {"ultimo": {"nombre": "AAAAMMDD-HHMMSS", "fecha": "AAAA-MM-DDTHH:MM:SSZ", "bytes": 0} | null}
}
```

- `contenedores.cursos`: cursos con contenedor (filas de `contenedores`); `encendidos`: los que están `encendido`. Con `PROVEEDOR_CONTENEDORES=ninguno`, ceros.
- `disco`: el sistema de archivos de `RAIZ_ARCHIVOS` (o de su carpeta padre si todavía no existe). `libres_bytes` es el espacio disponible para el usuario del servicio.
- `archivos`: cantidad y suma de `tamano` de todos los archivos.
- `respaldo.ultimo`: entre las carpetas de `DIR_RESPALDOS` cuyo nombre es una fecha válida `AAAAMMDD-HHMMSS` y que tienen `respaldo.tar.gz`, la de nombre mayor. `fecha` es ese nombre en UTC; `bytes`, el tamaño del `.tar.gz`. Se ignoran `.armando-*`, nombres que no son fechas válidas (por ejemplo `20261110-999999`) y carpetas sin `respaldo.tar.gz`. Sin respaldos: `null`.

Interfaz (`#v-owner`): `#tabs-owner` agrega `[data-otab="estado"]` con el texto "Estado", a continuación de "Uso y proveedores", con la clase `on` cuando está elegida. Muestra el título "Estado" y una fila `.metricas` con cuatro `.met`, como las métricas de "Uso y proveedores" del prototipo (`pintarOwner`):

- `#estado-nucleo`: "Funcionando" (y el tiempo desde el arranque).
- `#estado-contenedores`: los encendidos (y el total de cursos con contenedor).
- `#estado-disco`: "N GB libres de M GB", con un decimal.
- `#estado-respaldo`: la fecha del último respaldo con el atributo `data-fecha` igual a `respaldo.ultimo.fecha`; "Sin respaldos" si es `null`.

Se carga cada vez que se abre la pestaña.

## 11. Endurecimiento

**Encabezados.** En las respuestas HTML de la plataforma (la interfaz en `DOMINIO_BASE` y en `<id>.DOMINIO_BASE`, incluidas `/`, `/owner` y `/administracion`):

- `Content-Security-Policy`: `default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src <esquema>://*.<DOMINIO_BASE>[:puerto] https://challenges.cloudflare.com; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. Lo que exigen las pruebas: `frame-ancestors 'none'`, `object-src 'none'`, `default-src` y `base-uri` presentes, y `script-src` (o `default-src`) sin `'unsafe-inline'`, `'unsafe-eval'` ni `*`.
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` y `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`.

Las páginas de `<id>-curso.DOMINIO_BASE` mantienen lo de la fase 2 (`frame-ancestors` de la barra). Con `ENTORNO=produccion`, todas las respuestas de la escucha principal llevan `Strict-Transport-Security: max-age=31536000; includeSubDomains`. Las respuestas de la API siguen con `Cache-Control: no-store` y `nosniff`, y sin CORS.

**Tamaños.** Las rutas JSON rechazan cuerpos de más de `LIMITE_CUERPO_JSON` con `413 cuerpo_demasiado_grande` (el SIU sigue en 4 MB, las subidas en `ARCHIVOS_MAX_BYTES`, el reenvío a los cursos en los 50 MB de la fase 2). En la escucha para cursos rigen los mismos límites.

**Tiempos.** Las dos escuchas cortan la conexión si los encabezados no llegan completos en `TIEMPO_ESPERA_ENCABEZADOS_SEG` (contra conexiones lentas) y si el cuerpo no llega en `TIEMPO_ESPERA_CUERPO_SEG`. Los clientes HTTP salientes del núcleo (Brevo, Turnstile, cursos) siguen con tiempos máximos.

**Frecuencia.** Cada sesión y cada token personal tienen hasta `LIMITE_API_MINUTO` pedidos a `/api/*` por minuto (ventana fija o deslizante, en memoria); cada token de curso, `LIMITE_API_CURSO_MINUTO` en la escucha para cursos. El siguiente responde `429 demasiados_intentos` con `Retry-After`. No cuenta `/salud`. El límite de una persona no afecta a las demás. Los límites de login y de códigos de las fases 1 y 2 siguen igual.

**Registros sin secretos.** En ningún nivel de registro (incluido `RUST_LOG=debug`) el registro del núcleo contiene: valores de cookies de sesión, encabezados `Authorization` o `X-Campus-Identidad`, tokens personales (`cia_...`), tokens de curso (`cct_...`), códigos de login o de reautenticación, `SESSION_SECRET`, `IDENTIDAD_CLAVE_PRIVADA` (ni la semilla generada), claves de Brevo o de Turnstile, cuerpos de pedidos ni contenidos de archivos. Si una dependencia los registra en `debug`, se filtra su objetivo.

**Revisión de seguridad.** El módulo Núcleo revisa además todo el núcleo (rutas existentes, enrutador, supervisor, puente, importación del SIU) y corrige lo que encuentre sin romper los contratos anteriores. Lo encontrado y lo corregido va al handoff.

## 12. Permisos

| Acción | Dueño | Profesor del curso | Alumno del curso | No inscripto (incluye administrador y owner) | Token personal | Curso (token + identidad) |
|---|---|---|---|---|---|---|
| Subir archivos propios | sí | sí | sí | no (404) | `cursos:escribir` | con la identidad de esa persona |
| Subir material | sí | sí | no (403) | no | `cursos:escribir` | con identidad de un docente |
| Ver y bajar archivos | todos | todos | los suyos y el material | no | `cursos:leer` | según la identidad |
| Entregar | a su nombre | a su nombre | a su nombre | no | `cursos:escribir` | a nombre de la identidad |
| Ver entregas | todas | todas | las suyas | no | `cursos:leer` | según la identidad |
| Poner y cambiar notas | sí | sí | no (403) | no | `cursos:escribir` | con identidad de un docente |
| Ver notas vigentes | todas | todas | las suyas | no | `cursos:leer` | según la identidad |
| Ver historial de notas | sí | sí | no (403) | no | `cursos:leer` | con identidad de un docente |
| Editar o borrar entregas, notas o archivos | nadie | nadie | nadie | nadie | no existe | no existe |
| Ver el estado de la plataforma | | | | solo el owner | `owner:leer` | no |

Reglas:
- El rol sale solo de `inscripciones`, en el momento del pedido. Las marcas de la plataforma no dan acceso a datos de ningún curso.
- El token de un curso solo sirve para su curso, y solo junto con una identidad válida firmada por el núcleo para ese curso y para una persona inscripta.
- Las fechas y la persona de cada registro las pone la plataforma.
- Lo que hace la interfaz o la plantilla se puede hacer por la API con los mismos permisos.

## 13. Resguardo

El respaldo, la restauración, el temporizador y Litestream ya existen (`contratos/tramo-resguardo.md`). En esta fase:

- `RAIZ_ARCHIVOS` en producción es `/srv/campusia/archivos`, que `respaldar.sh` ya copia; las entregas y las notas viven en `campusia.db`, que ya se copia con `sqlite3 .backup`.
- `respaldar.sh` no copia `archivos/.subiendo/` (subidas a medias). Todo lo demás de `tramo-resguardo` queda igual y sus pruebas siguen pasando.
- La prueba `aceptacion/respaldo.spec.ts` recorre el ciclo completo con el núcleo real: subir archivos, entregar, poner y cambiar notas, respaldar con el núcleo andando, comprobar que el `.tar.gz` tiene la base y los archivos por su nombre interno, que la página de estado lo informa, agregar una entrega después del respaldo, restaurar con `restaurar.sh --destino`, levantar un núcleo sobre lo restaurado y comprobar que entregas, notas (vigentes e historial), archivos (lista y contenido byte a byte), repo y base del curso volvieron como estaban al respaldar, sin la entrega posterior, y que se puede seguir entregando.
- Litestream sigue desactivado y sin credenciales.

## 14. Despliegue

- `despliegue/campusia-nucleo.service` agrega `Environment=RAIZ_ARCHIVOS=/srv/campusia/archivos` y `Environment=DIR_RESPALDOS=/srv/campusia/respaldos`. Lo demás de las fases 1 y 2 no cambia.
- `despliegue/campusia.env.ejemplo` agrega, sin secretos: `ARCHIVOS_CUOTA_CURSO=1073741824`, `ARCHIVOS_MAX_BYTES=26214400`, `ARCHIVOS_TIPOS=` con la lista por defecto (sin `html`, `htm`, `xhtml`, `svg`, `xml`, `js`, `exe` ni `sh`), `LIMITE_CUERPO_JSON`, `LIMITE_API_MINUTO`, `LIMITE_API_CURSO_MINUTO`, `TIEMPO_ESPERA_ENCABEZADOS_SEG` y `TIEMPO_ESPERA_CUERPO_SEG`.
- `despliegue/instalar.sh` crea siempre `<raiz>/srv/campusia/archivos` y `<raiz>/srv/campusia/respaldos` con modo `0700` (dueño `campusia` cuando no es `--sin-servicios`), sin borrar lo que haya adentro. Sigue siendo idempotente.
- `despliegue/Caddyfile` agrega `request_body { max_size 60MB }` en el sitio y sigue pasando `caddy adapt`.
- `despliegue/respaldo/respaldar.sh`: lo de la sección 13.

## 15. Pruebas

Todas en `pruebas/fase-4/`, con ayudantes en `pruebas/fase-4/lib/` que reusan `pruebas/comun/` y `pruebas/fase-2/lib/`. Datos en `pruebas/fase-4/datos.json`: los de la fase 2 más Sofía López (`slopez@mail.austral.edu.ar`) como alumna de `redes`. En `redes`: Lucía Fernández dueña, Diego Herrera profesor, Tomás García y Sofía López alumnos.

Como un mismo núcleo de worker puede atender varios archivos de prueba, cada archivo sin Docker trabaja sobre cursos propios que crea insertando directamente en la base una fila en `cursos` (sin repo ni contenedor, `estado = 'sin_repo'`, sin fila en `codigos_curso`) y sus filas en `inscripciones`, con los mismos miembros que `redes` (`cursoAislado` en `lib/datos.ts`). Los servicios de esta fase tienen que funcionar con esos cursos igual que con los creados por la API.

| Archivo | Tipo | Qué prueba |
|---|---|---|
| `aceptacion/archivos.spec.ts` | aceptación | Subir y bajar igual (nombre, tamaño, SHA-256, tipo, fecha, encabezados de descarga); guardado fuera de los cursos con nombre interno; visibilidad para docentes y alumnos; material; uso y cuota; tipos permitidos por defecto; tokens personales |
| `aceptacion/entregas-notas.spec.ts` | aceptación | Entregar archivo y texto; quién, qué y cuándo; el alumno ve las suyas, dueño y profesor todas, con filtros; poner y cambiar notas; historial con autor y valor anterior; notas vigentes; todo por token personal |
| `aceptacion/respaldo.spec.ts` | aceptación | Respaldar y restaurar con el núcleo real y comprobar que todo volvió (sección 13) |
| `aceptacion/estado.spec.ts` | aceptación | `GET /api/owner/estado` sin respaldos y con respaldos; token `owner:leer`; solo el owner; pestaña Estado del panel |
| `aceptacion/curso-sdk.spec.ts` | aceptación (Docker) | El SDK desde un curso real (token del contenedor e identidades firmadas) sube, entrega, pone notas y lee según cada persona; errores tipados; el ejemplo de la plantilla en el navegador: el alumno entrega con archivo, el profesor ve y califica, el historial, el alumno ve su nota y no ve lo ajeno |
| `ataque/datos-permisos.spec.ts` | ataque | Alumno viendo entregas, notas, historial y archivos de otro; alumno poniendo notas o subiendo material; entregar en nombre de otro o con otra fecha; usar archivos ajenos o inventados; notas a quien no es alumno; no inscriptos, administradores y owner; otro curso; adivinar ids; permisos de token; `Origin`; sin sesión |
| `ataque/registros-inmutables.spec.ts` | ataque | Ninguna ruta edita ni borra; la base rechaza `UPDATE` y `DELETE`; un cambio de nota agrega una fila; un archivo alterado en el disco no se sirve |
| `ataque/archivos.spec.ts` | ataque | Tamaño máximo; superar la cuota (también con subidas simultáneas); recorrido de rutas y nombres inválidos; tipos peligrosos servidos como descarga y nunca como HTML, SVG, XML o JavaScript, en la plataforma y en la barra; el navegador descarga y no ejecuta; inyección en `Content-Disposition` |
| `ataque/api-curso.spec.ts` | ataque (Docker) | Sin token, tokens falsos o personales; identidades ausentes, falsificadas, de otra clave, vencidas, futuras, de vigencia larga, de otra versión, de otro curso o alteradas; persona no inscripta; alumno con identidad que dice otro rol; el curso intentando alterar o borrar entregas y notas, o entregar en nombre de otro; token de un curso contra otro curso; rutas en la escucha equivocada; montajes del contenedor; registro sin tokens ni identidades |
| `ataque/endurecimiento.spec.ts` | ataque | Encabezados de seguridad; HSTS en producción; cuerpos grandes; conexiones lentas; límite de frecuencia; registro sin secretos con `RUST_LOG=debug` |
| `despliegue/despliegue.spec.ts` | despliegue | Variables de la unidad y del ejemplo de entorno; `request_body` de Caddy; Litestream desactivado; `instalar.sh` crea `archivos/` y `respaldos/` |

La corrida completa incluye además todas las pruebas de ataque (y de aceptación y despliegue) de las fases 1 y 2 y, cuando se una, de la fase 3: tienen que seguir pasando con el endurecimiento.

### Cambios en las pruebas compartidas (2026-11-10)

- `pruebas/comun/nucleo.ts`: `entornoBase` agrega `RAIZ_ARCHIVOS` y `DIR_RESPALDOS` dentro de la carpeta temporal de cada núcleo, para que ninguna prueba toque `/srv/campusia`.
- `pruebas/comun/compilar.ts`: además del núcleo y la interfaz, compila el SDK y lo empaqueta en `plantilla-curso/vendor/` (así una corrida solo de Playwright usa el SDK actual), y crea `CAMPUSIA_CORRIDA` si no viene definida.
- `pruebas/fase-2/fixtures.ts`, `pruebas/fase-2/lib/docker.ts` y `pruebas/fase-2/limpieza-global.ts`: cada núcleo con Docker anota su prefijo en `$CAMPUSIA_CORRIDA/prefijos`, y la limpieza final borra solo las imágenes de los prefijos de esta corrida. Antes borraba las de todos los prefijos `cia<8 hex>`, que con la fase 3 corriendo al mismo tiempo sobre el mismo Docker incluían imágenes de la otra corrida.

## 16. Fuera de alcance

- Borrar archivos (ni siquiera material): no existe en esta fase.
- Pantallas de entregas y notas en la interfaz de la plataforma: las muestra cada curso (la plantilla trae el ejemplo).
- Activar Litestream y subir respaldos a R2 (no hay bucket todavía).
- Lo de la fase 3 (agente, versión de prueba, publicar, versiones, intermediario del modelo).

### Cambios en las pruebas (2026-11-10, segunda tanda)

- `pruebas/fase-4/aceptacion/curso-sdk.spec.ts`, prueba del ejemplo de la plantilla: la descarga del archivo entregado se hace con `fetch` dentro de la página del curso en lugar de `page.request`. `page.request` resuelve el nombre desde Node y no usa la regla del navegador que lleva `*.campusia.prueba` a `127.0.0.1`, así que el subdominio del curso no resolvía. Se siguen comprobando el estado 200, el contenido idéntico y `Content-Disposition: attachment`.
- `pruebas/tramo-resguardo/estatico.sh`, control "no toca carpetas fuera del tramo": solo se aplica en la rama `tramo-resguardo`, que es la que tenía ese límite. Antes se aplicaba en cualquier rama distinta de `main`, y contradecía esta fase, que tiene que cambiar `nucleo/`, `interfaz/`, `plantilla-curso/`, `sdk/` y `despliegue/` (sección 14) y corre `tramo-resguardo` completo.
