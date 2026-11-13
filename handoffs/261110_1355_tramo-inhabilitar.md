# Tramo inhabilitar: cierre

_Escrito: 2026-11-10 13:55. Rama `tramo-inhabilitar`, desde `main` (fases 1, 2 y 4). Referencias: `CONVENCIONES.md`, `handoffs/261110_0400_plan-implementacion-plataforma.md`, `contratos/tramo-inhabilitar.md`, `.orquestacion/tramo-inhabilitar.md` y `prototipo/campus.html`._

Principio del tramo: nada se borra. Las cuentas se suspenden, las universidades se deshabilitan y los cursos se archivan; todo se revierte y se conservan historia, inscripciones quitadas, entregas, notas, archivos, versiones y auditoría.

## Qué se hizo

### Contrato y pruebas

- `contratos/tramo-inhabilitar.md`: rutas, formatos, permisos, reglas de login y enrutador, selectores de interfaz y criterios. Incluye la sección 6.1 con los agregados del alcance de las 10:55 (quitar administradores), 11:00 (poner y quitar owners) y 11:15 (el owner con todos los permisos del administrador).
- `pruebas/tramo-inhabilitar/`: 7 archivos de aceptación y 7 de ataque con Playwright, ayudantes en `lib.ts` y `fixtures.ts`, datos en `datos.json` (los de la fase 2 más Raúl Admin y Rocío Rectora) y `correr.sh`.

### Núcleo

- Migración `nucleo/migraciones/5001_inhabilitar.sql`: `usuarios.suspendida_en`, `suspendida_por`, `baja_en`; `universidades.deshabilitada_en`; `cursos.archivado_en`, `archivado_por`; tabla `inscripciones_historia` de solo agregado (disparadores que impiden `UPDATE` y `DELETE`). Todas las columnas nuevas son `NULL`.
- Módulo nuevo `nucleo/src/inhabilitar.rs`:
  - Controles reutilizables: `cuenta_inhabilitada`, `exigir_habilitada`, `curso_archivado`, `curso_fuera_de_servicio`, `curso_servible`, `curso_modificable`, `curso_visible`, `universidad_habilitada`, `login_permitido`, `bloqueo_enrutador`.
  - Rutas: `POST /api/admin/personas/{id}/{suspender|reactivar|baja}`, `POST /api/owner/personas/{id}/{suspender|reactivar|baja}`, `POST /api/owner/universidades/{id}/{deshabilitar|rehabilitar}`, `POST /api/cursos/{id}/{archivar|desarchivar}`, `POST /api/admin/cursos/{id}/{archivar|desarchivar|transferir}`.
- Módulo nuevo `nucleo/src/roles.rs`: alcance del administrador con `?universidad=<id>` (owner sobre cualquier universidad, administrador limitado a la suya con 404 para otra), `DELETE /api/owner/universidades/{id}/administradores/{usuario}`, `GET|POST /api/owner/owners`, `DELETE /api/owner/owners/{id}` y `quitar_owner_de` (regla del último owner) que usa también la línea de comandos.
- Cambios mínimos en archivos compartidos:
  - `auth.rs`: sesión o token de una cuenta inhabilitada es `401 no_autenticado` en cada petición, contra la base.
  - `login.rs`: el pedido de código responde igual para cuentas suspendidas, de universidades deshabilitadas, mails nuevos de esos dominios, activas e inexistentes; iguala el tiempo con la media de una emisión real con variación al azar y repite el `503` si el último envío real falló. `verificar` rechaza códigos de cuentas inhabilitadas. Los owners entran aunque su universidad esté deshabilitada.
  - `enrutador.rs`: 403 en HTML para cuenta inhabilitada con sesión viva y para curso archivado ("Curso archivado") o de universidad deshabilitada ("Curso no disponible"), sin encender el contenedor ni reenviar.
  - `supervisor.rs`: detiene y no enciende cursos fuera de servicio; vuelve a detener contenedores encendidos a mano.
  - `api_cursos.rs`: token de curso de un curso archivado rechazado; los inscriptos inactivos no aparecen.
  - `cursos.rs`, `admin.rs`, `owner.rs`, `cuenta.rs`, `datos.rs`: controles de curso modificable, alcance por universidad y campos nuevos (`archivado`, `suspendida`, `estado`, `baja`, `owner`, `deshabilitada`).
  - `servidor.rs`: rutas nuevas.
  - `main.rs`: subcomando `quitar-owner <email>`; `crear-owner` además levanta la suspensión.

### Interfaz

- Componentes nuevos `interfaz/src/Confirmar.tsx` (modal de confirmación con reintento tras reautenticación) e `interfaz/src/Inhabilitar.tsx` (acciones de suspender, reactivar, dar de baja, archivar, desarchivar, deshabilitar, rehabilitar, transferir, quitar administrador, invitar y quitar owner).
- Administrador › Personas: columna Estado (Activa, Suspendida, Pendiente, Baja), chips de estado y acciones por fila. Administrador › Cursos: estado Archivado, archivar o desarchivar y transferir.
- Owner › Universidades: pastilla Deshabilitada, deshabilitar o rehabilitar, quitar administrador y "Administrar". Pestaña Owners con invitar y quitar. Selector de universidad en Administración y entrada "Administración" en el menú de perfil del owner.
- Curso: archivar o desarchivar desde `#m-cursos` para el dueño; pastilla `#curso-archivado` y aviso "Curso archivado" sin iframe. Mis cursos: tarjetas archivadas al final con su pastilla.

## Cómo se compila

```bash
. "$HOME/.cargo/env"
cargo build --manifest-path nucleo/Cargo.toml
pnpm --dir interfaz install && pnpm --dir interfaz run build
pnpm --dir sdk install && pnpm --dir sdk run build
rm -f plantilla-curso/vendor/campusia-sdk-*.tgz && pnpm --dir sdk pack --pack-destination plantilla-curso/vendor
```

## Cómo se levanta en desarrollo

Igual que la fase 4, con los datos del tramo (claves de prueba públicas de Turnstile, mails a archivo):

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

## Cómo se prueba

```bash
bash pruebas/tramo-inhabilitar/correr.sh
```

Corre las pruebas del tramo y después `pruebas/fase-4/correr.sh` (tramos de plantilla y SDK, resguardo y todas las fases con Playwright). Con argumentos de Playwright o `SOLO_TRAMO=1` corre solo el tramo. `CAMPUSIA_SIN_COMPILAR=1` y `PRUEBAS_WORKERS` funcionan como antes. Las pruebas con Docker usan prefijos propios por núcleo y no corren `docker system prune` ni tocan imágenes ajenas.

## Cómo se despliega

Sin variables de entorno nuevas. Al desplegar, el núcleo aplica la migración `5001_inhabilitar.sql` con `campusia-nucleo migrar` (o al arrancar, como en las fases anteriores). Se sigue el procedimiento de la fase 4 (`despliegue/`): compilar en modo release, copiar el binario y `interfaz/dist`, reiniciar la unidad de systemd. Para recuperar el acceso desde el servidor: `campusia-nucleo crear-owner <email>` (levanta la suspensión); para quitar un owner: `campusia-nucleo quitar-owner <email>`.

## Resultado de las pruebas

- Aceptación del tramo: 37/37.
- Ataque del tramo: 36/36.
- Fases y tramos anteriores (`pruebas/fase-4/correr.sh`) en verde con los cambios del tramo.

## Decisiones tomadas

- El estado de la cuenta se verifica contra la base en cada petición (sesión y token), en lugar de depender solo de la revocación: una sesión revivida en la base de una cuenta suspendida sigue sin servir.
- Las inscripciones quitadas por la baja van a `inscripciones_historia`, de solo agregado por disparadores; la inscripción activa se borra de `inscripciones` pero la historia queda.
- Los controles de curso archivado y universidad deshabilitada se exponen como funciones públicas de `inhabilitar.rs` (`curso_modificable`, `curso_servible`, `curso_visible`) para que las rutas de la fase 3 las llamen al unirse.
- El owner actúa como administrador con `?universidad=<id>`; un administrador que indica otra universidad recibe 404, sin revelar si existe.
- El pedido de código iguala tiempo y respuesta ante el proveedor de mails caído para no filtrar el estado de la cuenta por canales laterales.
- Quitar administrador u owner revoca todas las sesiones y los tokens con permisos `admin:*` u `owner:*`; la cuenta sigue activa.

## Desvíos del plan y del contrato

- `pruebas/fase-1/aceptacion/login.spec.ts` suma `archivado: false` al curso esperado de `GET /api/mis-cursos`, porque la prueba compara el objeto completo y el contrato agrega ese campo. Registrado en la sección "Cambios" del contrato.
- `Persona` del administrador suma `"owner": bool` para ocultar acciones en filas de owners (registrado en el contrato).
- `despliegue/respaldo/restaurar.sh`, fuera de las carpetas del tramo: la restauración de repos rechaza bundles sin referencias y verifica el repositorio armado con `git fsck`, para que el tramo de resguardo pase de forma estable dentro de la corrida completa.
- Los agregados del alcance (10:55, 11:00 y 11:15) llegaron con el tramo en curso y se incorporaron en la sección 6.1 del contrato y en `roles.rs`, `aceptacion/roles.spec.ts`, `aceptacion/interfaz-roles.spec.ts` y `ataque/roles.spec.ts`.

## Pendientes conocidos

- Unión con la fase 3: las rutas de editar con el agente, publicar, versiones y `-prueba` tienen que llamar a `inhabilitar::curso_modificable` y `inhabilitar::curso_servible`. Los archivos compartidos (`servidor.rs`, `cursos.rs`, `enrutador.rs`, `supervisor.rs`, `Curso.tsx`, `Admin.tsx`, `Owner.tsx`) van a tener conflictos chicos de líneas agregadas.
- La migración usa el prefijo `5001`; si la fase 3 agrega migraciones, verificar el orden al unir.
- No hay interfaz para ver `inscripciones_historia`; queda solo en la base y en la auditoría.
- El tiempo igualado del pedido de código usa una media móvil en memoria de las emisiones reales del proceso: tras un reinicio, hasta la primera emisión real, la media es 0 y los pedidos sin código no esperan. Conviene sembrar un valor inicial o persistir la media.
