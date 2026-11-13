# Contrato de la fase 2: cursos, inscripciones y enrutador

_Escrito: 2026-11-10. Referencias: `CONVENCIONES.md`, `handoffs/261110_0400_plan-implementacion-plataforma.md`, `contratos/fase-1.md`, `contratos/tramo-plantilla-sdk.md`, `contratos/tramo-resguardo.md`, `contratos/identidad-cursos.md`, `.orquestacion/fase-2.md` y `prototipo/campus.html`._

Este contrato es la fuente de verdad para implementar la fase 2. Las pruebas de `pruebas/fase-2/` lo verifican. Si algo de acá no coincide con una prueba, manda la prueba y se avisa en el handoff. Las pruebas no se cambian para que pasen. Todo lo de `contratos/fase-1.md` sigue vigente salvo lo que este contrato cambia explícitamente.

## 1. Módulos y carpetas

| Módulo | Carpetas | Qué entrega |
|---|---|---|
| Núcleo | `nucleo/` | Cursos, inscripciones, códigos de curso, firma de identidad, API para cursos, `ProveedorDeContenedores` (CLI de Docker), enrutador `-curso`, apagado y encendido, migración `0002` |
| Interfaz | `interfaz/` | Crear curso, Unirme con código, panel Inscriptos, selector de la barra con "+ Crear curso", iframe del curso real, estados de carga |
| Despliegue y plantilla | `despliegue/`, `plantilla-curso/`, `sdk/` | Unidad de systemd con las variables nuevas y el alias `campusia.service`, ejemplo de entorno, `instalar.sh` con `--plantilla` y `--sdk`. La plantilla y el SDK ya están hechos: solo se tocan si hace falta, y con sus pruebas (`pruebas/tramo-plantilla-sdk/`) en verde |

Cada módulo toca solo sus carpetas. Nadie toca `pruebas/`, `contratos/`, `prototipo/`, `handoffs/` ni `.orquestacion/`.

## 2. Compilar, levantar y probar

### Compilar

```bash
. "$HOME/.cargo/env"
cargo build --manifest-path nucleo/Cargo.toml
pnpm --dir interfaz install && pnpm --dir interfaz run build
pnpm --dir sdk install && pnpm --dir sdk run build
rm -f plantilla-curso/vendor/campusia-sdk-*.tgz && pnpm --dir sdk pack --pack-destination plantilla-curso/vendor
```

El núcleo necesita en tiempo de ejecución el CLI de contenedores (`docker`, o `podman` con `CONTENEDORES_CLI=podman`) y `git`.

### Levantar en desarrollo

```bash
export DATABASE_URL=sqlite:///tmp/campusia.db DOMINIO_BASE=campusia.prueba ENTORNO=desarrollo \
  PROVEEDOR_EMAIL=archivo ARCHIVO_EMAIL=/tmp/mails.jsonl SESSION_SECRET=$(openssl rand -hex 32) \
  TURNSTILE_SITE_KEY=1x00000000000000000000AA TURNSTILE_SECRET=1x0000000000000000000000000000000AA \
  INTERFAZ_DIR=$PWD/interfaz/dist EMAIL_FROM=no-responder@campusia.prueba \
  PROVEEDOR_CONTENEDORES=docker RAIZ_CURSOS=/tmp/campusia-cursos PLANTILLA_CURSO_DIR=$PWD/plantilla-curso SDK_DIR=$PWD/sdk
nucleo/target/debug/campusia-nucleo migrar
nucleo/target/debug/campusia-nucleo sembrar pruebas/fase-2/datos.json
nucleo/target/debug/campusia-nucleo crear-owner equipo@campusia.prueba
nucleo/target/debug/campusia-nucleo
```

### Probar

```bash
bash pruebas/fase-2/correr.sh
```

Corre, en este orden y desde cero, sin pasos manuales:

1. `pruebas/tramo-plantilla-sdk/correr.sh`: compila y prueba el SDK, lo empaqueta en `plantilla-curso/vendor/`, compila y prueba la plantilla y construye su imagen (eso además deja caliente la caché de capas de Docker para las imágenes de los cursos).
2. `pruebas/tramo-resguardo/correr.sh`.
3. `pruebas/correr.sh` (Playwright): compila el núcleo y la interfaz y corre `pruebas/fase-1/` y `pruebas/fase-2/`.

Sigue aunque una parte falle y termina con código distinto de 0 si alguna falló. Con argumentos (`bash pruebas/fase-2/correr.sh fase-2/ataque`) o con `SOLO_PLAYWRIGHT=1` corre solo Playwright con esos argumentos. `CAMPUSIA_SIN_COMPILAR=1` y `PRUEBAS_WORKERS` funcionan como en la fase 1.

Requisitos de la máquina: Docker sin sudo (en desarrollo, el Docker del sistema), las imágenes `node:22-alpine` y `caddy:2.8.4` (o red para bajarlas), `git`, Node 22, pnpm y Rust.

Las pruebas de la fase 2 levantan cada núcleo con `PROVEEDOR_CONTENEDORES=docker`, un `PREFIJO_CONTENEDORES` único por núcleo, un `RAIZ_CURSOS` temporal, un `PUERTO_API_CURSOS` libre y la plantilla del repo (o una copia con rutas espía, ver la sección 12). Al terminar borran los contenedores, imágenes y redes de ese prefijo. Las pruebas de la fase 1 levantan el núcleo con `PROVEEDOR_CONTENEDORES=ninguno` (`pruebas/comun/nucleo.ts`).

## 3. Variables de entorno nuevas

| Variable | Por defecto | Uso |
|---|---|---|
| `PROVEEDOR_CONTENEDORES` | `docker` | `docker` usa el CLI de contenedores. `ninguno` no ejecuta ningún comando de contenedores ni abre la escucha de la API para cursos: crear un curso responde `503 servicio_no_disponible` sin crear nada. Otro valor: el núcleo no arranca |
| `CONTENEDORES_CLI` | `docker` | Ejecutable del CLI (`docker` o `podman`). Hereda `DOCKER_HOST` y `XDG_RUNTIME_DIR` del entorno |
| `PREFIJO_CONTENEDORES` | `campusia` | Prefijo de todo lo que el núcleo crea en el motor de contenedores. `[a-z0-9]{1,20}` |
| `RED_CURSOS` | `<PREFIJO>-cursos` | Red de los cursos |
| `RAIZ_CURSOS` | `/srv/campusia/cursos` | Un repo de git por curso en `RAIZ_CURSOS/<id>` |
| `PLANTILLA_CURSO_DIR` | `/srv/campusia/plataforma/plantilla-curso` | Plantilla inicial de los cursos |
| `SDK_DIR` | `/srv/campusia/plataforma/sdk` | Se usa solo si la plantilla no trae `vendor/campusia-sdk-*.tgz`: el núcleo corre `pnpm pack` ahí |
| `PUERTO_API_CURSOS` | `8081` | Puerto de la escucha de la API para cursos |
| `DIRECCION_API_CURSOS` | la puerta de enlace de `RED_CURSOS` | Dirección de esa escucha |
| `URL_API_CURSOS` | `http://<DIRECCION_API_CURSOS>:<PUERTO_API_CURSOS>` | Valor de `CAMPUSIA_API` en los contenedores |
| `CURSO_MEMORIA` | `256m` | Límite de memoria de cada curso |
| `CURSO_CPUS` | `0.5` | Límite de CPU de cada curso |
| `CURSO_PIDS` | `256` | Límite de procesos de cada curso |
| `MINUTOS_INACTIVIDAD` | `15` | Un curso sin peticiones durante ese tiempo se detiene |
| `INACTIVIDAD_SEG` | vacío | Si está, reemplaza a `MINUTOS_INACTIVIDAD` (en segundos). Lo usan las pruebas |
| `REVISION_INACTIVIDAD_SEG` | `30` | Cada cuánto se revisa la inactividad |
| `ARRANQUE_CURSO_SEG` | `60` | Cuánto espera una petición a que un curso recién encendido responda `/salud` |
| `CONSTRUCCION_MAX_SEG` | `900` | Tiempo máximo para construir la imagen de un curso |
| `IDENTIDAD_CLAVE_PRIVADA` | vacío | Semilla Ed25519 de 32 bytes en base64url sin relleno. Si falta, el núcleo genera una y la guarda en `configuracion` (`identidad_clave_privada`). Si está pero no decodifica a 32 bytes, el núcleo no arranca |
| `IDENTIDAD_VIGENCIA_SEG` | `60` | `vence - emitido` del encabezado de identidad. Máximo 120 |
| `LIMITE_UNIRSE_USUARIO` | `10` | Intentos fallidos de "Unirme con código" por persona dentro de `VENTANA_LIMITES_SEG` |
| `LIMITE_UNIRSE_IP` | `30` | Intentos fallidos de "Unirme con código" por IP dentro de `VENTANA_LIMITES_SEG` |

Con `PROVEEDOR_CONTENEDORES=docker`, si al arrancar no se puede preparar la red o abrir la escucha de la API para cursos, el núcleo sale con código distinto de 0 y un mensaje claro.

## 4. Subcomandos

| Comando | Qué hace |
|---|---|
| `campusia-nucleo clave-publica` | Imprime en una línea la clave pública Ed25519 de identidad (32 bytes, base64url sin relleno). Si no hay `IDENTIDAD_CLAVE_PRIVADA` y la base no tiene clave, la genera y la guarda. Solo necesita `DATABASE_URL` (y `IDENTIDAD_CLAVE_PRIVADA` si se usa) |
| `campusia-nucleo sembrar` | Igual que en la fase 1. Los cursos sembrados quedan con `estado = 'sin_repo'`: no tienen repo ni contenedor |

## 5. Modelo de datos

Migración nueva `nucleo/migraciones/0002_cursos.sql`. La `0001` no se modifica. Las columnas marcadas con * las leen o escriben las pruebas.

```sql
ALTER TABLE cursos ADD COLUMN estado* TEXT NOT NULL DEFAULT 'sin_repo'
  CHECK (estado IN ('sin_repo','preparando','listo','error'));

contenedores(curso_id* TEXT PK REFERENCES cursos, nombre TEXT NOT NULL, imagen TEXT NULL, commit_main TEXT NULL,
             token_huella TEXT NOT NULL UNIQUE, estado TEXT NOT NULL CHECK (estado IN ('apagado','encendiendo','encendido','error')),
             ultima_peticion TEXT NULL, error TEXT NULL, creado_en TEXT NOT NULL, actualizado_en TEXT NOT NULL)

codigos_curso(curso_id* TEXT PK REFERENCES cursos, codigo* TEXT NOT NULL UNIQUE, activo* INTEGER NOT NULL DEFAULT 0,
              vence_en* TEXT NULL, creado_en TEXT NOT NULL, creado_por INTEGER NULL)
```

- `vence_en` es texto RFC 3339 en UTC, como el resto de las fechas.
- `configuracion` guarda `identidad_clave_privada`* (semilla en base64url) cuando no viene por entorno.
- El token del curso (`CAMPUSIA_TOKEN_CURSO`) nunca se guarda en claro: solo su huella HMAC-SHA256 con `SESSION_SECRET`. Se puede rotar cada vez que se crea el contenedor.
- Los intentos fallidos de "Unirme con código" se registran en `limites` con `tipo` `unirse_usuario` y `unirse_ip`.
- `inscripciones` no cambia: el dueño es la inscripción con `rol = 'dueño'` y hay exactamente una por curso.

## 6. Rutas de la API

Las reglas generales de la fase 1 siguen: JSON, errores `{"error","mensaje"}`, `Cache-Control: no-store`, control de `Origin` y `X-Campusia: 1` en las modificaciones con cookie, orden de los controles (host, origen, autenticación, `requiere_sesion`, `permiso_del_token`, rol, reautenticación, validación, alcance, conflictos).

Códigos de error nuevos:
- 400: `subdominio_invalido`, `no_es_profesor` (agrega `emails` cuando corresponde), `archivo_invalido`. Se reusan `datos_invalidos`, `email_invalido` (agrega `emails`), `dominio_no_habilitado` (agrega `emails`) y `codigo_invalido`.
- 409: `subdominio_en_uso`, `es_dueno`.
- 503: `servicio_no_disponible` si no se pueden crear cursos (`PROVEEDOR_CONTENEDORES=ninguno`).

Permiso de token nuevo: `cursos:escribir`, válido para cualquier persona. `cursos:leer` sirve para las lecturas de esta sección.

En las tablas, **Quién** es el rol requerido, **Token** el permiso que necesita un token (o "solo sesión"), **Reaut** si exige reautenticación. "Docente" es dueño o profesor del curso. Si quien llama no está inscripto en el curso (aunque sea administrador u owner) o el curso no existe: `404 no_encontrado`. Si está inscripto pero no tiene el rol: `403 prohibido`.

### Cursos

| Método y ruta | Quién | Token | Reaut | Cuerpo | Respuesta |
|---|---|---|---|---|---|
| `POST /api/cursos` | persona con marca de profesor | `cursos:escribir` | | `{"nombre","subdominio","periodo"}` | `201 Curso` con `rol: "dueño"` |
| `GET /api/cursos/{id}` | inscripto | `cursos:leer` | | | `200 Curso` |

`Curso`: `{"id","nombre","periodo","color","rol","version_publicada","estado":"sin_repo"|"preparando"|"listo"|"error","contenedor":"ninguno"|"apagado"|"encendiendo"|"encendido"}`.

`POST /api/cursos`:
- `nombre`: de 1 a 120 caracteres sin contar los espacios de los bordes (se guarda recortado). `periodo`: de 1 a 60. Si no: `400 datos_invalidos`.
- `subdominio` es el id del curso. Se recortan los espacios de los bordes; después tiene que cumplir todo esto, si no `400 subdominio_invalido`:
  - `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`, de 3 a 40 caracteres, sin `--`;
  - no termina en `-curso` ni en `-prueba`;
  - no es una palabra reservada: `www`, `api`, `admin`, `administracion`, `owner`, `app`, `mail`, `correo`, `smtp`, `imap`, `pop`, `ftp`, `static`, `estaticos`, `cdn`, `assets`, `login`, `auth`, `cuenta`, `cuentas`, `soporte`, `ayuda`, `docs`, `blog`, `status`, `estado`, `salud`, `campus`, `campusia`, `plataforma`, `nucleo`, `curso`, `cursos`, `prueba`, `pruebas`, `test`, `dev`, `staging`, `root`, `sistema`.
- Si ya existe un curso con ese id: `409 subdominio_en_uso`.
- La persona sin marca de profesor recibe `403 prohibido` (también el owner y los administradores sin marca).
- El curso queda en la universidad de quien lo crea, con un color de la paleta del prototipo, `version_publicada: null`, quien lo crea como `dueño` y un código de curso generado e inactivo.
- Auditoría `curso_creado`.
- Responde enseguida con `estado: "preparando"` (o `"listo"` si ya terminó). En segundo plano:
  1. Crea el repo en `RAIZ_CURSOS/<id>`: copia `PLANTILLA_CURSO_DIR` sin `node_modules/`, `dist/` ni `.git/`; si no trae `vendor/campusia-sdk-*.tgz`, lo genera con `pnpm pack` en `SDK_DIR`. `git init`, un commit inicial en `main` con todo (incluido el `.tgz`) y una rama `prueba` en el mismo commit. Queda con `main` en el árbol de trabajo, sin cambios pendientes y sin remotos. Crea `RAIZ_CURSOS/<id>/datos/` (ignorada por git) para los datos del curso.
  2. Construye la imagen `<PREFIJO>-curso-<id>:<12 primeros caracteres del commit>` desde un `git archive` de `main` (nunca desde el árbol de trabajo, así `datos/` y `.git/` no entran en la imagen), con las etiquetas `campusia.prefijo=<PREFIJO>` y `campusia.curso=<id>`.
  3. Crea y arranca el contenedor (sección 8). Pasa a `estado: "listo"`. Si algo falla: `estado: "error"`, con el motivo en `contenedores.error` y en el registro del núcleo.

### Inscripciones

| Método y ruta | Quién | Token | Reaut | Cuerpo | Respuesta |
|---|---|---|---|---|---|
| `GET /api/cursos/{id}/inscriptos` | docente | `cursos:leer` | | | `200 {"inscriptos":[Inscripto],"alumnos","profesores"}` |
| `POST /api/cursos/{id}/inscriptos` | docente; con `rol: "profesor"`, solo el dueño | `cursos:escribir` | | `{"emails":[...],"rol":"alumno"\|"profesor"}` | `200 {"agregados","ya_estaban","creados"}` |
| `POST /api/cursos/{id}/inscriptos/siu` | docente | `cursos:escribir` | | `{"archivo","contenido"}` | `200 {"agregados","ya_estaban","creados","rechazados"}` |
| `PUT /api/cursos/{id}/inscriptos/{usuario_id}` | dueño | solo sesión | sí | `{"rol":"alumno"\|"profesor"}` | `200 Inscripto` |
| `DELETE /api/cursos/{id}/inscriptos/{usuario_id}` | docente | solo sesión | sí | | `204` |
| `POST /api/cursos/{id}/transferir` | dueño | solo sesión | sí | `{"usuario_id"}` | `200 {"dueno":{"id","nombre","email"}}` |

`Inscripto`: `{"id","nombre","email","rol","pendiente"}` (`id` numérico). La lista va ordenada: el dueño, después los profesores y después los alumnos, cada grupo por nombre. `alumnos` y `profesores` son las cantidades (`profesores` cuenta al dueño).

`POST /api/cursos/{id}/inscriptos`:
- Normaliza cada mail (recorta y pasa a minúsculas) y quita repetidos. Lista vacía o de más de 500: `400 datos_invalidos`. `rol` que no es `alumno` ni `profesor`: `400 datos_invalidos`.
- Es atómica: si algo falla no se inscribe a nadie.
- Mails con formato inválido: `400 email_invalido` con `emails`.
- Cada mail tiene que ser de un dominio de la universidad del curso (comparación del dominio completo, como en el login), y si la cuenta existe tiene que ser de esa universidad. Si no: `400 dominio_no_habilitado` con `emails` (los rechazados).
- Con `rol: "profesor"`: solo el dueño (`403 prohibido` para los profesores); cada mail tiene que ser de una cuenta existente con marca de profesor. Si no: `400 no_es_profesor` con `emails`.
- Las cuentas que no existen se crean pendientes (`pendiente = 1`) en la universidad del curso, con el nombre sacado del mail como en el login.
- Quien ya está inscripto (con cualquier rol) no cambia y va a `ya_estaban`. `agregados`, `ya_estaban` y `creados` son listas de mails (`creados` está incluido en `agregados`).
- Auditoría `inscripcion` por cada persona agregada, con el mail, el rol y el curso en el detalle.

`POST /api/cursos/{id}/inscriptos/siu`:
- `archivo` es el nombre del archivo y `contenido` el archivo en base64. Hasta 2 MB decodificado; el núcleo acepta en esta ruta cuerpos JSON de hasta 4 MB. Más grande: `413` o `400 archivo_invalido`.
- Formatos: Excel `.xlsx` (empieza con `PK`), Excel `.xls` (empieza con `D0 CF 11 E0`) o CSV. En Excel se lee la primera hoja. El CSV puede venir en UTF-8 con o sin BOM (o Windows-1252 si no es UTF-8 válido), separado por `,` o `;`, con campos entre comillas.
- La primera fila con contenido es la cabecera. Columna de mail: la primera cuyo nombre, sin mayúsculas ni acentos, contiene `mail` o `correo`. Nombre: una columna `nombre`, `nombre y apellido`, `apellido y nombre` o `apellido, nombre`; o columnas `apellido` y `nombre(s)` separadas (el nombre queda "Nombre Apellido"). Sin columna de mail o archivo ilegible: `400 archivo_invalido`.
- Inscribe como alumnos. No es atómica: cada fila con mail inválido o de otra universidad va a `rechazados` como `{"fila","email","motivo":"email_invalido"|"dominio_no_habilitado"}` (`fila` empieza en 1 en la cabecera) y las demás se importan. Las filas sin mail se ignoran.
- Las cuentas nuevas se crean pendientes con el nombre del archivo. Las existentes conservan su nombre.
- Auditoría `inscripcion` por cada persona agregada e `importacion_siu` con las cantidades.

`PUT /api/cursos/{id}/inscriptos/{usuario_id}`: solo el dueño (los profesores y alumnos reciben `403 prohibido` antes de la reautenticación). La persona tiene que estar inscripta (`404`). No se cambia al dueño (`409 es_dueno`). Para pasar a `profesor` la persona necesita la marca (`400 no_es_profesor`). Auditoría `rol_en_curso`.

`DELETE /api/cursos/{id}/inscriptos/{usuario_id}`, en este orden:
1. Quien llama tiene que ser docente del curso (alumno: `403`; no inscripto: `404`).
2. Reautenticación.
3. La persona tiene que estar inscripta: `404`.
4. Al dueño no lo quita nadie: `409 es_dueno`.
5. Un profesor solo quita alumnos: si la persona es profesor (incluido él mismo), `403 prohibido`.

Auditoría `desinscripcion`. La persona pierde el acceso al curso en la petición siguiente.

`POST /api/cursos/{id}/transferir`: solo el dueño. `usuario_id` tiene que estar inscripto (`404`) como `profesor` y tener la marca (`400 no_es_profesor`). El nuevo queda `dueño` y el anterior `profesor`. Auditoría `curso_transferido`.

### Código de inscripción

| Método y ruta | Quién | Token | Reaut | Cuerpo | Respuesta |
|---|---|---|---|---|---|
| `GET /api/cursos/{id}/codigo` | docente | `cursos:leer` | | | `200 Codigo` |
| `POST /api/cursos/{id}/codigo` | docente | `cursos:escribir` | | `{"dias"?}` | `200 Codigo`: código nuevo, activo, vence en `dias` (1 a 365, por defecto 30; otro valor `400 datos_invalidos`). El anterior deja de servir. Auditoría `codigo_curso_generado` |
| `PUT /api/cursos/{id}/codigo` | docente | `cursos:escribir` | | `{"activo": bool}` | `200 Codigo`. Auditoría `codigo_curso_cambiado` |
| `POST /api/unirse` | cualquiera con sesión | `cursos:escribir` | | `{"codigo"}` | `200 {"curso":{"id","nombre","periodo","color","rol"}}` |

`Codigo`: `{"codigo","activo","vence"}` (`vence` en RFC 3339 o `null`).

- Formato: `<3 caracteres>-<6 caracteres>`. Los 3 primeros son los 3 primeros caracteres alfanuméricos del id en mayúsculas (completados con `X`). Los 6 últimos salen de un CSPRNG sobre `ABCDEFGHJKMNPQRSTUVWXYZ23456789`. Ejemplo: `RED-4K7P9X`. Se guarda en claro: lo ven los docentes.
- `POST /api/unirse` recorta y pasa a mayúsculas el código. Responde `400 codigo_invalido`, siempre con el mismo cuerpo, si: no existe, está inactivo, venció, la persona no es de la universidad del curso (o no tiene universidad), o el valor no tiene el formato. Si la persona ya está inscripta responde 200 con su rol actual y no lo cambia. Si no, la inscribe como `alumno`. Auditoría `inscripcion_por_codigo`.
- Límites: cuando una persona acumula `LIMITE_UNIRSE_USUARIO` intentos fallidos, o una IP `LIMITE_UNIRSE_IP`, dentro de `VENTANA_LIMITES_SEG`, los intentos siguientes responden `429 demasiados_intentos` aunque el código sea correcto.

### API para cursos

Se sirve solo en la escucha `DIRECCION_API_CURSOS:PUERTO_API_CURSOS` (con cualquier `Host`), con `Authorization: Bearer <CAMPUSIA_TOKEN_CURSO>`. Los formatos son los de `contratos/identidad-cursos.md` y `contratos/tramo-plantilla-sdk.md`:

| Método y ruta | Respuesta 200 |
|---|---|
| `GET /api/curso/yo` | `{"id","nombre","periodo"}` del curso del token |
| `GET /api/curso/inscriptos` | arreglo plano `[{"id","nombre","email","rol"}]`, con `id` como cadena, en el orden de `GET /api/cursos/{id}/inscriptos` |
| `GET /salud` | `{"ok":true}` |

- Sin token, o con un token que no es de un curso (de sesión, personal `cia_...`, inventado o de un contenedor anterior): `401 {"error":"no_autenticado"}`.
- Cualquier otra ruta en esa escucha responde 404, con o sin token. Las rutas de la plataforma (`/api/yo`, `/api/admin/*`, `/api/cursos/*`, login, interfaz) no existen ahí.
- En la escucha principal, `/api/curso/*` responde 404, y el token de un curso no sirve en ninguna ruta de la plataforma (`401`).

## 7. Identidad hacia los cursos

Exactamente lo de `contratos/identidad-cursos.md`:
- `X-Campus-Identidad: <carga>.<firma>`, carga JSON en base64url sin relleno, firma Ed25519 sobre los bytes ASCII de `<carga>`.
- `{"v":1,"curso":"<id>","usuario":"<id de la persona como cadena>","email","nombre","rol":"dueño"|"profesor"|"alumno","emitido","vence"}`, con `vence - emitido = IDENTIDAD_VIGENCIA_SEG` (máximo 120) y `emitido` la hora actual.
- La clave privada solo la tiene el núcleo. Nunca entra al contenedor, al repo del curso ni a una respuesta.

## 8. Contenedores

Contrato `ProveedorDeContenedores` (trait del núcleo) con la implementación por CLI. Todo lo que crea lleva la etiqueta `campusia.prefijo=<PREFIJO>` (y `campusia.curso=<id>` cuando corresponde), y el núcleo nunca toca contenedores, imágenes ni redes de otro prefijo.

- Red `RED_CURSOS`: `--internal` (sin salida a internet) y con `com.docker.network.bridge.enable_icc=false` (los cursos no se ven entre sí). Si existe, se reusa.
- Contenedor `<PREFIJO>-curso-<id>`, con:
  - `--network RED_CURSOS`, sin puertos publicados, sin `--privileged`, sin `--network host`, sin montar el socket de Docker ni nada más que `RAIZ_CURSOS/<id>/datos` en `/datos` (lectura y escritura) y un `tmpfs` en `/tmp`;
  - `--read-only --cap-drop ALL --security-opt no-new-privileges --memory CURSO_MEMORIA --cpus CURSO_CPUS --pids-limit CURSO_PIDS`, con el usuario sin privilegios de la imagen;
  - exactamente estas variables de la plataforma: `PORT=3000`, `CAMPUSIA_CURSO=<id>`, `CAMPUSIA_CLAVE_PUBLICA`, `CAMPUSIA_API=URL_API_CURSOS`, `CAMPUSIA_TOKEN_CURSO=cct_<43 caracteres base64url>`, `CAMPUSIA_DATOS=/datos`. Ninguna otra con secretos (ni `SESSION_SECRET`, ni `IDENTIDAD_CLAVE_PRIVADA`, ni `DOCKER_HOST`).
  - El núcleo se asegura de que el usuario del contenedor pueda escribir en `/datos`.
- El núcleo le habla al contenedor por su dirección en `RED_CURSOS`, puerto 3000. El contenedor le habla al núcleo solo por `URL_API_CURSOS`.
- Si el contenedor no existe (por ejemplo, alguien lo borró) se crea de nuevo desde la imagen; si la imagen no existe, se construye de nuevo desde `main`. Los datos siguen en `RAIZ_CURSOS/<id>/datos`.
- En Docker sin root las direcciones de la red de los cursos viven en el espacio de red del demonio sin root: el proveedor encapsula cómo llegar al contenedor y dónde abrir la escucha de la API para cursos (`DIRECCION_API_CURSOS`, `URL_API_CURSOS`). Las pruebas corren con el Docker de desarrollo; la verificación en el servidor la hace el orquestador.

### Apagado y encendido

- Cada petición reenviada actualiza la hora de la última petición del curso.
- Cada `REVISION_INACTIVIDAD_SEG`, los cursos encendidos sin peticiones durante la inactividad configurada se detienen (`stop`; el contenedor sigue existiendo) y pasan a `contenedor: "apagado"`.
- Una petición a un curso apagado lo enciende (`start`), espera a que `GET /salud` responda 200 (hasta `ARRANQUE_CURSO_SEG`) y recién entonces la reenvía. Las peticiones que llegan mientras se enciende esperan el mismo arranque: nunca se arranca dos veces a la vez.
- Al arrancar, el núcleo pone en `apagado` los cursos cuyo contenedor no está corriendo.

## 9. Enrutador

| Host | Fase 1 | Fase 2 |
|---|---|---|
| `<id>.DOMINIO_BASE` | barra | barra con el curso real en el iframe |
| `<id>-curso.DOMINIO_BASE` | página provisoria | reenvío al contenedor del curso (abajo). Los cursos con `estado = 'sin_repo'` (los sembrados) siguen con la página provisoria de la fase 1, y su `/api/*` sigue respondiendo 404 |
| `<id>-prueba.DOMINIO_BASE` | 404 | 404 (fase 3) |

En `<id>-curso.DOMINIO_BASE`, para todos los métodos y rutas, en este orden:
1. El curso no existe: 404.
2. Sin sesión válida (cookie `campusia_sesion`; `Authorization` no cuenta): `401` en HTML, sin el nombre del curso, con un enlace a `<esquema>://<id>.<DOMINIO_BASE>[:puerto]/` para entrar.
3. Sesión de alguien no inscripto (aunque sea administrador u owner): `403` en HTML, sin el nombre del curso.
4. Métodos que no son `GET`, `HEAD` ni `OPTIONS`: el `Origin` tiene que ser exactamente `<esquema>://<id>-curso.<DOMINIO_BASE>[:puerto]`; si no (falta, `null`, otro curso, la barra, la plataforma u otro sitio), `403` y la petición no llega al curso.
5. `estado` `preparando`: `503` en HTML con el texto "Preparando el curso" y `Retry-After`. `error`: `503` en HTML.
6. Curso apagado: lo enciende (sección 8). Si no responde a tiempo: `503` en HTML con `Retry-After`.
7. Reenvía método, ruta, consulta, cuerpo y encabezados, salvo: `Cookie`, `Authorization`, `Proxy-Authorization`, `X-Campus-Identidad` y cualquier otro `X-Campus-*`, y los encabezados de salto a salto. Agrega un único `X-Campus-Identidad` recién firmado para esa persona y ese curso.
8. Devuelve la respuesta del curso con su estado, cuerpo y encabezados, salvo `Set-Cookie` (se descartan todos) y los de salto a salto. Agrega `Content-Security-Policy: frame-ancestors <esquema>://<id>.<DOMINIO_BASE>[:puerto]` y `X-Content-Type-Options: nosniff`.

## 10. Interfaz

La interfaz reproduce el prototipo (`prototipo/campus.html`): `modalCrear`, `modalUnirse`, `pintarInscriptos`, el panel `#p-inscriptos` y el selector `#m-cursos`. Los selectores nombrados son parte del contrato.

**Mis cursos** (`#v-cursos`, prototipo `pintarCursos`):
- `[data-accion="unirse"]` ("Unirme con código") para todos; también dentro de `.vacio`.
- `[data-accion="crear"]` ("Crear curso") solo para personas con marca de profesor.

**Crear curso** (modal, prototipo `modalCrear`): `#c-nombre`, `#c-sub` (con el sufijo `.<DOMINIO_BASE>` visible al lado), `#c-per` (un `select` con al menos tres períodos, como el prototipo), `#c-err` y `[data-accion="crear-ok"]` ("Crear"). Mientras no se toque `#c-sub`, se completa solo a partir del nombre: minúsculas, sin acentos, palabras separadas por `-` ("Análisis Matemático I" da `analisis-matematico-i`). Los errores de la API se muestran en `#c-err` ("Esa dirección ya está en uso.", "Esa dirección no se puede usar.", ...). Al crear navega a `<esquema>://<id>.<base>[:puerto]/`.

**Unirme con código** (modal, prototipo `modalUnirse`): `#u-cod`, `#u-err` y `[data-accion="unirse-ok"]` ("Unirme"). Si falla, `#u-err` dice "Ese código no existe o ya no está activo." (con 429, que espere). Si sale bien, navega al subdominio del curso.

**Barra del curso** (`#v-curso`):
- `#m-cursos` agrega `[data-accion="crear"]` ("+ Crear curso") para personas con marca de profesor.
- `iframe#curso` con `src` `<esquema>://<id>-curso.<base>[:puerto]/` y `sandbox` que incluye `allow-scripts`, `allow-same-origin` y `allow-forms`, y no incluye `allow-top-navigation`, `allow-top-navigation-by-user-activation` ni `allow-popups-to-escape-sandbox`.
- `#curso-cargando` se ve encima del lienzo mientras el iframe no terminó de cargar, y mientras el curso está `preparando` (con el texto "Preparando el curso"; la barra consulta `GET /api/cursos/{id}` cada pocos segundos y carga el iframe cuando pasa a `listo`). Se oculta cuando el iframe carga.

**Panel Inscriptos** (`#p-inscriptos`, prototipo `pintarInscriptos`; lo abre `[data-panel="p-inscriptos"]`, solo docentes):
- `#ins-tit`: "Inscriptos · N alumnos, M profesores", con singular cuando es 1 ("1 alumno", "1 profesor").
- `[data-insf="f-mails"]` abre `#f-mails` con `#ins-mails` (mails separados por línea, coma, punto y coma o espacios), `#ins-rol` (`alumno` y `profesor`; la opción `profesor` deshabilitada si quien mira no es el dueño), `#ins-agregar` y `#ins-err`, donde se muestran los mails rechazados.
- `[data-insf="f-siu"]` abre `#f-siu` con `#ins-archivo` (`input type="file"`, `.csv,.xlsx,.xls`). Al elegir un archivo lo sube y avisa en `#aviso` cuántos importó ("N alumnos importados del SIU") y los rechazados.
- `[data-insf="f-codigo"]` abre `#f-codigo` con `#cod-valor` (el código), `#cod-vence` ("Vence el ..." o "Desactivado"), `#cod-nuevo` ("Generar otro") y el interruptor `#cod-sw` (clase `on` si está activo).
- `#ins-lista` tiene una fila `.persona[data-usuario="<id>"]` por persona, con el nombre y el mail. El dueño lleva la pastilla "Dueño". El dueño ve, en las demás filas, `select[data-rol="<id>"]` (la opción `profesor` deshabilitada para quien no tiene la marca) y `[data-quitar="<id>"]`; un profesor ve `[data-quitar]` solo en las filas de alumnos y nunca en la suya. Las filas de profesores tienen, para el dueño, `[data-transferir="<id>"]` ("Hacer dueño").
- `[data-quitar]` cambia la fila a `.persona.conf` con "¿Quitar a <nombre>?", `[data-noquitar]` y `[data-siquitar="<id>"]`. `[data-transferir]` pide confirmación con `[data-sitransferir="<id>"]`. Las acciones que piden reautenticación usan el modal de la fase 1 (`#reaut-digitos`) y se reintentan solas.

## 11. Permisos

| Acción | Dueño | Profesor del curso | Alumno del curso | No inscripto (incluye administrador y owner) | Token |
|---|---|---|---|---|---|
| Crear curso | cualquier persona con marca de profesor | | | | `cursos:escribir` |
| Ver el curso (`GET /api/cursos/{id}`, `-curso`) | sí | sí | sí | no | `cursos:leer` (solo la API) |
| Ver inscriptos y código | sí | sí | no | no | `cursos:leer` |
| Inscribir alumnos (mails, SIU), manejar el código | sí | sí | no | no | `cursos:escribir` |
| Inscribir profesores | sí | no | no | no | `cursos:escribir` |
| Cambiar roles | sí, con reautenticación | no | no | no | no |
| Quitar alumnos | sí, con reautenticación | sí, con reautenticación | no | no | no |
| Quitar profesores | sí, con reautenticación | no | no | no | no |
| Quitar al dueño | no | no | no | no | no |
| Transferir el curso | sí, con reautenticación, a un profesor del curso con marca | no | no | no | no |
| Unirse con código | | | | si es de la universidad del curso | `cursos:escribir` |

Reglas:
- Solo personas con marca de profesor pueden ser profesores o dueños de un curso.
- Solo se inscriben personas de la universidad del curso.
- El rol en el curso sale solo de `inscripciones`. Las marcas de la plataforma (administrador, owner) no dan acceso a ningún curso.
- Un token de curso solo sirve en la API para cursos y solo para su curso.
- Lo que hace la interfaz se puede hacer por la API con los mismos permisos.

Auditoría, acciones nuevas: `curso_creado`, `inscripcion`, `inscripcion_por_codigo`, `importacion_siu`, `desinscripcion`, `rol_en_curso`, `curso_transferido`, `codigo_curso_generado`, `codigo_curso_cambiado`. `universidad_id` es la del curso; `detalle` menciona el id del curso y, si hay una persona afectada, su mail. Nunca incluye tokens ni la clave privada.

## 12. Pruebas

Todas en `pruebas/fase-2/`, con ayudantes propios en `pruebas/fase-2/lib/` que reusan `pruebas/comun/`. Datos en `pruebas/fase-2/datos.json`: los de la fase 1 más Martín Ruiz (`mruiz@austral.edu.ar`, profesor sin cursos), Sofía López (`slopez@mail.austral.edu.ar`, sin cursos) y Pablo Sin Marca (`psinmarca@austral.edu.ar`, cuenta común).

Plantilla espía: algunas pruebas levantan el núcleo con una copia temporal de `plantilla-curso/` a la que le agregan rutas antes de la identidad: `/espia/eco` devuelve los encabezados que recibió el curso, `/espia/registro` las peticiones recibidas, `/espia/cookie` intenta plantar cookies de la plataforma, `/espia/red` intenta conexiones desde adentro del contenedor y `/espia/entorno` las variables `CAMPUSIA_*`. La copia se arma reemplazando en `servidor/app.ts` la línea exacta `  app.get('/salud', (c) => c.json({ estado: 'ok' }));`; si esa línea cambia en la plantilla, se actualiza la prueba.

| Archivo | Qué prueba |
|---|---|
| `aceptacion/cursos.spec.ts` | Crear curso por la API; estado `listo`; repo de git con `main` y `prueba`; contenedor endurecido con sus variables; Mis cursos y panel de administrador; auditoría; token `cursos:escribir`; `clave-publica` |
| `aceptacion/inscripciones.spec.ts` | Inscribir por mails como alumnos y profesores; cuentas pendientes que se activan al entrar; CSV y Excel del SIU; código (generar, activar, desactivar, unirse); cambiar rol; quitar con reautenticación; transferir; auditoría |
| `aceptacion/enrutador.spec.ts` | El alumno ve el curso en su subdominio; el curso lee la identidad con el SDK para cada rol; la portada trae los datos de la plataforma con el token del curso; datos persistentes; `frame-ancestors`; cursos sembrados con la página provisoria; recrear un contenedor borrado |
| `aceptacion/inactividad.spec.ts` | El curso se apaga solo y se despierta con una visita; peticiones simultáneas al despertar; los datos sobreviven |
| `aceptacion/interfaz.spec.ts` | Crear curso desde Mis cursos y desde la barra; errores del modal; iframe del curso real; estado de carga; Unirme con código; panel Inscriptos completo (mails, SIU, código, roles, quitar, transferir) |
| `ataque/enrutador.spec.ts` | Sin sesión, no inscriptos, administradores y quitados no entran; identidad falsificada; cookies y `Authorization` que no llegan al curso; cookies plantadas por el curso; peticiones desde otro curso u origen; firma verificable con `IDENTIDAD_CLAVE_PRIVADA` |
| `ataque/inscripciones.spec.ts` | Alumnos y no inscriptos contra las rutas de docentes; profesor sin marca como profesor; profesor no dueño con profesores, roles y transferencias; quitar al dueño; mails de otra universidad y dominios parecidos; ver inscriptos de otro curso; acciones sensibles sin reautenticación o con token |
| `ataque/codigos-curso.spec.ts` | Adivinar códigos y límites; códigos inactivos, vencidos, regenerados y de otra universidad; formato y aleatoriedad |
| `ataque/subdominios.spec.ts` | Reservados, sufijos, caracteres raros, recorrido de rutas, repetidos; sin marca de profesor; nada se crea |
| `ataque/token-curso.spec.ts` | Token de un curso contra otro curso y contra la plataforma; tokens personales y cookies contra la API para cursos; token sin guardar en claro; la escucha para cursos no expone la plataforma |
| `ataque/contenedor.spec.ts` | Sin privilegios ni capacidades, solo lectura, límites, sin socket de Docker, usuario sin root; sin internet ni acceso a otros cursos ni a la plataforma; secretos fuera del contenedor y del repo |
| `despliegue/despliegue.spec.ts` | Unidad de systemd con las variables nuevas y el alias; ejemplo de entorno; `instalar.sh --plantilla --sdk` |

## 13. Despliegue

- `despliegue/campusia-nucleo.service` agrega `Environment=RAIZ_CURSOS=/srv/campusia/cursos`, `Environment=PLANTILLA_CURSO_DIR=/srv/campusia/plataforma/plantilla-curso`, `Environment=SDK_DIR=/srv/campusia/plataforma/sdk` y `Environment=PROVEEDOR_CONTENEDORES=docker`, y en `[Install]` `Alias=campusia.service`, así el drop-in `campusia.service.d/docker.conf` que escribe `despliegue/docker/preparar-docker.sh` (con `DOCKER_HOST` y `XDG_RUNTIME_DIR`) y `restaurar.sh` (que usa `campusia.service`) le aplican. Sigue sin `NoNewPrivileges=true`, `PrivateUsers=true`, `RestrictNamespaces=true` y sin `ProtectHome` en `true`, `yes`, `read-only` ni `tmpfs`; si tiene `RestrictAddressFamilies`, incluye `AF_UNIX`; deja `/run/user` escribible.
- `despliegue/campusia.env.ejemplo` agrega, con valores de ejemplo y sin secretos: `PROVEEDOR_CONTENEDORES=docker`, `CONTENEDORES_CLI=docker`, `PREFIJO_CONTENEDORES=campusia`, `RAIZ_CURSOS=/srv/campusia/cursos`, `PLANTILLA_CURSO_DIR`, `SDK_DIR`, `PUERTO_API_CURSOS`, `CURSO_MEMORIA`, `CURSO_CPUS`, `MINUTOS_INACTIVIDAD=15`, `ARRANQUE_CURSO_SEG`, `LIMITE_UNIRSE_USUARIO` y `LIMITE_UNIRSE_IP`. `IDENTIDAD_CLAVE_PRIVADA`, si aparece, va vacía o con `completar`; nunca una clave.
- `despliegue/instalar.sh` acepta `--plantilla <carpeta>` y `--sdk <carpeta>` opcionales:
  - Siempre crea `<raiz>/srv/campusia/cursos` con modo `0700`.
  - Con `--plantilla`, copia la plantilla a `<raiz>/srv/campusia/plataforma/plantilla-curso/` sin `node_modules/` ni `dist/`, reemplazando la anterior. Falla (código distinto de 0) si la plantilla no tiene `vendor/campusia-sdk-*.tgz`.
  - Con `--sdk`, copia el SDK a `<raiz>/srv/campusia/plataforma/sdk/` sin `node_modules/`.
  - Sigue siendo idempotente y sin esos argumentos hace lo mismo que en la fase 1.

## 14. Fuera de alcance

Editar con el agente, publicar, versiones y la versión de prueba (`-prueba`) son de la fase 3. `version_publicada` de los cursos nuevos queda `null` y el repo no tiene etiquetas todavía.

## Cambios en las pruebas (2026-11-10)

- `pruebas/fase-2/ataque/codigos-curso.spec.ts`, "adivinar códigos desde muchas cuentas se corta por IP": las cuentas nuevas entran desde una IP aleatoria y recién después pasan a la IP del ataque. Entrar cinco veces desde la misma IP pide cinco códigos y, por `UMBRAL_TURNSTILE` (5 pedidos de código por IP), la quinta verificación exige Turnstile, que es lo que dice este contrato. Los intentos de "Unirme con código" siguen saliendo todos de la misma IP.
- `pruebas/fase-2/ataque/subdominios.spec.ts`, `nadaCreado`: Docker no acepta argumentos con un byte nulo, así que para los subdominios con `\u0000` se listan las etiquetas `campusia.curso` de los contenedores del prefijo y se comprueba que ninguna sea ese valor ni tenga un byte nulo. El resto de los casos no cambia.
- `pruebas/tramo-plantilla-sdk/repo.test.mjs` admite `.orquestacion` en la raíz (la carpeta de orquestación que este contrato nombra) y `pruebas/tramo-resguardo/estatico.sh` solo controla el alcance del tramo fuera de `main`: en `main` la fase 2 modifica `nucleo/`, `interfaz/` y `despliegue/` como indica la tabla de módulos, y esta suite corre las dos del tramo.
- `Inscripto` en `GET /api/cursos/{id}/inscriptos` y `PUT /api/cursos/{id}/inscriptos/{usuario_id}` agrega `profesor` (booleano, la marca de profesor), que la interfaz necesita para deshabilitar la opción `profesor` de `select[data-rol]` según la sección de la interfaz.
- `pruebas/fase-2/lib/docker.ts`, `limpiarPrefijo`: al cerrar cada núcleo se borran solo sus contenedores y redes. Las imágenes de todos los prefijos de prueba (`cia` y 8 hexadecimales) se borran una sola vez al final de la corrida, en `pruebas/fase-2/limpieza-global.ts` (`globalTeardown` de `pruebas/playwright.config.ts`). Con el almacén de imágenes de containerd, borrar una imagen mientras otro worker construye la suya puede llevarse capas que esa construcción comparte en la caché (`unexpected media type ... not found`) y dejar el curso en `error`. Al terminar la corrida se sigue borrando todo lo de los prefijos de prueba.
