# Fase 2: cursos, inscripciones y enrutador

_Creado: 2026-11-10 07:20. Sigue a `261110_0516_fase-1-identidad-roles-paneles.md`, `261110_0500_tramo-resguardo.md` y `261110_0501_tramo-plantilla-sdk.md`. Contrato: `contratos/fase-2.md`._

## Qué se hizo

- **Núcleo** (`nucleo/`), migración nueva `nucleo/migraciones/0002_cursos.sql` (estado de los cursos, contenedores, códigos de curso; la `0001` no cambia).
  - `cursos.rs`: crear curso (solo con marca de profesor, subdominio validado contra reservados, sufijos `-curso` y `-prueba` y caracteres raros), detalle, reintentar la preparación, inscripciones por mails como alumnos o profesores, importación del SIU, código de inscripción (activar, desactivar, regenerar, vencimiento, unirse con límites por persona y por IP), cambio de rol, quitar con reautenticación, transferir. Reglas de dominios de la universidad, marca de profesor, dueño y auditoría según el contrato. Las cuentas inscriptas que nunca entraron quedan pendientes y se activan al primer login.
  - `siu.rs`: lectura de CSV, xlsx y xls con calamine en un proceso lector aislado y con límites de tamaño, filas, memoria, CPU y tiempo, para que planillas manipuladas (celdas lejanas, `sharedStrings` que se descomprimen a cientos de MB, xls gigantes) se rechacen con `400 archivo_invalido` sin tirar abajo ni inflar el núcleo.
  - `identidad.rs`: encabezado `X-Campus-Identidad` firmado con Ed25519 según `.orquestacion/identidad.md`. Clave privada de `IDENTIDAD_CLAVE_PRIVADA` o generada y guardada en `configuracion`. Subcomando `clave-publica`.
  - `contenedores.rs`: trait `ProveedorDeContenedores` e implementación por CLI (`docker` o `podman`) con red interna sin ICC, contenedores de solo lectura, sin capacidades, `no-new-privileges`, límites de memoria, CPU y procesos, solo `/datos` montado y etiquetas `campusia.prefijo` y `campusia.curso`. Detecta Docker sin root.
  - `puente.rs`: con Docker sin root, la red de los cursos vive en el espacio de red del demonio; el núcleo entra a ese espacio con `nsenter` y deja un puente por socket Unix para llegar a los contenedores y para abrir ahí la escucha de la API para cursos. Se relanza si el demonio cambia de proceso.
  - `supervisor.rs`: repo de git por curso desde la plantilla (ramas `main` y `prueba`, SDK empaquetado si falta), construcción de la imagen desde `main`, contenedor con token propio `cct_...` (solo se guarda su huella), apagado por inactividad, encendido con espera de `/salud`, recreación si el contenedor o la imagen desaparecen. Reintenta la construcción de la imagen y la creación y el arranque del contenedor ante fallas transitorias de Docker (hasta 3 reintentos con espera de 1, 2 y 4 segundos).
  - `enrutador.rs`: `<id>.DOMINIO_BASE` sirve la interfaz con la barra y el iframe; `<id>-curso.DOMINIO_BASE` se reenvía al contenedor solo para inscriptos (sin sesión, a login; sin inscripción, 403), borrando cookies, `Authorization` y encabezados de identidad del navegador, descartando las cookies que intenta plantar el curso y limitando los cuerpos grandes sin acumularlos en memoria. `frame-ancestors` y `sandbox` del iframe según el contrato.
  - `api_cursos.rs`: escucha separada para los cursos con `GET /api/curso/yo` y `GET /api/curso/inscriptos` con el token del curso.
  - Permiso de token nuevo `cursos:escribir`; panel de administrador con los cursos reales.
- **Interfaz** (`interfaz/`): modal Crear curso desde Mis cursos y desde el selector de la barra, Unirme con código, panel Inscriptos completo (`Inscriptos.tsx`: mails, SIU, código, roles, quitar con confirmación y reautenticación, transferir), modales del curso (`ModalesCurso.tsx`), iframe del curso real y estados de carga mientras el curso se prepara o se despierta.
- **Despliegue** (`despliegue/`): la unidad de systemd agrega `RAIZ_CURSOS`, `PLANTILLA_CURSO_DIR`, `SDK_DIR`, `PROVEEDOR_CONTENEDORES` y el alias `campusia.service` (para que le aplique el drop-in de `despliegue/docker/preparar-docker.sh` con `DOCKER_HOST` y `XDG_RUNTIME_DIR`); `campusia.env.ejemplo` con las variables nuevas sin secretos; `instalar.sh` con `--plantilla` y `--sdk` y `/srv/campusia/cursos` en `0700`.
- **Contrato y pruebas**: `contratos/fase-2.md` y `pruebas/fase-2/` (aceptación, ataque y despliegue, con ayudantes en `pruebas/fase-2/lib/` y el comando `pruebas/fase-2/correr.sh`).

## Cómo se compila

```bash
. "$HOME/.cargo/env"
cargo build --manifest-path nucleo/Cargo.toml
pnpm --dir interfaz install && pnpm --dir interfaz run build
pnpm --dir sdk install && pnpm --dir sdk run build
rm -f plantilla-curso/vendor/campusia-sdk-*.tgz && pnpm --dir sdk pack --pack-destination plantilla-curso/vendor
```

En tiempo de ejecución el núcleo necesita `git` y el CLI de contenedores.

## Cómo se levanta en desarrollo

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

Con `PROVEEDOR_CONTENEDORES=ninguno` el núcleo no toca Docker y crear un curso responde `503 servicio_no_disponible`.

## Cómo se prueba

```bash
bash pruebas/fase-2/correr.sh                              # tramos de plantilla y resguardo, y fases 1 y 2, desde cero
bash pruebas/fase-2/correr.sh fase-2/ataque                # solo Playwright con esos argumentos
CAMPUSIA_SIN_COMPILAR=1 PRUEBAS_WORKERS=2 bash pruebas/fase-2/correr.sh fase-2
```

Requisitos: Docker sin sudo, imágenes `node:22-alpine` y `caddy:2.8.4` (o red para bajarlas), `git`, Node 22, pnpm y Rust.

## Cómo se despliega

```bash
cargo build --release --manifest-path nucleo/Cargo.toml
pnpm --dir interfaz install && pnpm --dir interfaz run build
pnpm --dir sdk install && pnpm --dir sdk run build
rm -f plantilla-curso/vendor/campusia-sdk-*.tgz && pnpm --dir sdk pack --pack-destination plantilla-curso/vendor
sudo despliegue/docker/preparar-docker.sh
sudo despliegue/instalar.sh --binario nucleo/target/release/campusia-nucleo --interfaz interfaz/dist \
  --plantilla plantilla-curso --sdk sdk
sudo systemctl restart campusia
```

Antes, completar en `/srv/campusia/config/campusia.env` las variables nuevas de `despliegue/campusia.env.ejemplo`. `IDENTIDAD_CLAVE_PRIVADA` puede quedar vacía: el núcleo genera la clave y la guarda en la base (entra en el respaldo).

## Resultado de las pruebas

Corrida completa de `bash pruebas/fase-2/correr.sh` el 2026-11-10, código de salida 0:

- Tramo plantilla de curso y SDK: 31/31.
- Tramo resguardo: estático 49/49, respaldo 58/58, rotación 18/18, Docker 50/50, ataque de respaldo 150/150, ataque de Docker 27/27.
- Fase 1: aceptación 66/66, ataque 72/72, despliegue 8/8.
- Fase 2: aceptación 60/60, ataque 72/72, despliegue 5/5.
- Playwright en total: 283/283.

En la verificación anterior había fallado `pruebas/fase-2/ataque/siu-malicioso.spec.ts:50` (y no corrieron las tres siguientes): el curso de la prueba quedó en `error` porque Docker no encontró una capa intermedia en la caché al construir (`unexpected media type ... not found`). La causa era que cada worker, al cerrar su núcleo, borraba sus imágenes mientras otros workers construían las suyas; con el almacén de imágenes de containerd (Docker 29), eso puede llevarse contenido que otra construcción comparte. Se corrigió con los reintentos del supervisor y moviendo el borrado de imágenes de las pruebas al final de la corrida.

## Decisiones tomadas

- Reintentos ante fallas transitorias de Docker: solo para errores que se reconocen como transitorios (contenido o capas que faltan en la caché, leases, demonio caído o que no contesta, conexiones cortadas, conflictos de nombre); un Dockerfile roto o una construcción que supera `CONSTRUCCION_MAX_SEG` no se reintentan. Antes de volver a crear el contenedor se borra el que haya quedado a medias.
- El SIU se lee en un proceso lector aparte con límites de memoria, CPU y tiempo, para que un archivo manipulado no comprometa la memoria del núcleo.
- Con Docker sin root, el acceso a la red de los cursos queda encapsulado en el proveedor (puente por socket Unix), como pide la sección 8 del contrato.

## Desvíos del plan y del contrato

- Variables nuevas fuera de la tabla del contrato: `CONTENEDORES_SIN_ROOT` (`auto`, `si` o `no`; por defecto `auto`) y `CONTENEDORES_PID_RED` (archivo con el PID del espacio de red del demonio sin root, para ubicaciones no estándar).
- `Inscripto` agrega `profesor` (la marca de profesor), ya anotado en el contrato.
- Cambios en las pruebas, todos anotados en "Cambios en las pruebas" del contrato: `codigos-curso.spec.ts` (IP de las cuentas nuevas), `subdominios.spec.ts` (byte nulo), `repo.test.mjs` y `estatico.sh` de los tramos (carpeta `.orquestacion` y alcance en `main`) y, en este cierre, la limpieza de imágenes de `pruebas/fase-2/lib/docker.ts`, que pasa a `pruebas/fase-2/limpieza-global.ts` (`globalTeardown`).
- El contrato dice que los módulos no tocan `pruebas/`; el cambio de la limpieza lo hizo el cierre de la fase porque la limpieza concurrente rompía construcciones de otros workers.

## Pendientes conocidos

- Editar con el agente, publicar, versiones y la versión de prueba (`-prueba`): fase 3. `version_publicada` queda `null`.
- La verificación de Docker sin root en el servidor real la hace el orquestador; las pruebas usan el Docker de desarrollo con un `nsenter` simulado para el camino sin root.
- Las imágenes viejas de un curso no se borran cuando se construye una nueva: hace falta una limpieza periódica cuando lleguen las publicaciones de la fase 3.
- Los reintentos ante fallas transitorias no tienen una prueba que fuerce la falla de Docker; se validaron con la corrida completa.
- Siguen los pendientes de la fase 1 (Resend, limpieza de la tabla `limites`, quitar personas de una universidad).
