# Tramo: acciones del profesor para el agente, sin tokens personales y cupos de tokens

_Creado: 2026-11-10 21:41. Rama `tramo-acciones-y-cupos`, desde `main` con las fases 1 a 4, el tramo inhabilitar y la reautenticación por sesión ya integrados (sigue a `261110_1618_integracion-fases-3-e-inhabilitar.md`). Contrato: `contratos/tramo-acciones-y-cupos.md`. Alcance: `.orquestacion/tramo-acciones-y-cupos.md`._

## Qué se hizo

- **Acciones del profesor** (`nucleo/src/acciones.rs`): rutas fijas `/api/curso/acciones/*` en la escucha de espacios y en la de la API para cursos; token del agente `cat_` por ejecución (`tokens_agente`, solo la huella), atado al curso y al profesor que pide, revocado al terminar y con vencimiento a `AGENTE_MAX_SEG`; confirmaciones (`confirmaciones_agente`) para quitar y cambiar roles, que se aprueban o rechazan desde el panel Editar; auditoría con `agente = 1`.
- **Sin tokens personales**: se borraron las rutas `/api/tokens*`, `cerrar-otras` y `PUT /api/admin/limite`; cualquier `Authorization` en la API pública responde `401`. El owner ve y cierra las sesiones de una persona (`nucleo/src/sesiones_owner.rs`, `interfaz/src/Sesiones.tsx`).
- **Cupos de tokens** (`nucleo/src/cupos.rs`, `interfaz/src/Cupos.tsx`): cupo por universidad (owner), reparto por profesor con predeterminado y excepciones (administrador), medición en `uso_modelo.tokens` y `usuario_id`, corte antes de ejecutar el agente y en el intermediario con reserva por pedido en vuelo, aviso del 80 % y proveedor sin uso disponible.
- Migración `nucleo/migraciones/6001_acciones_y_cupos.sql`. SDK `@campusia/sdk` 0.3.0 con los métodos nuevos; plantilla y `CLAUDE.md` del espacio con las acciones.

## Cómo compilar, levantar y probar

Compilar:

```bash
. "$HOME/.cargo/env"
cargo build --manifest-path nucleo/Cargo.toml
pnpm --dir interfaz install && pnpm --dir interfaz run build
pnpm --dir sdk install && pnpm --dir sdk run build
rm -f plantilla-curso/vendor/campusia-sdk-*.tgz && pnpm --dir sdk pack --pack-destination plantilla-curso/vendor
bash despliegue/construir-espacio.sh --etiqueta campusia-espacio:1
```

`construir-espacio.sh` ahora copia también `plantilla-curso/vendor/campusia-sdk-*.tgz` al contexto de la imagen (ver "Seguridad del espacio compartido"); conviene empaquetar el SDK antes de construir la imagen.

Levantar en desarrollo (como la fase 3, con las variables de la fase 4 y, si se quiere, `RESERVA_TOKENS_PEDIDO` y `ESPERA_SIN_USO_SEG`):

```bash
nucleo/target/debug/campusia-nucleo migrar
nucleo/target/debug/campusia-nucleo sembrar pruebas/tramo-inhabilitar/datos.json
nucleo/target/debug/campusia-nucleo crear-owner equipo@campusia.prueba
nucleo/target/debug/campusia-nucleo
```

Probar, desde cero y sin pasos manuales:

```bash
bash pruebas/tramo-acciones-y-cupos/correr.sh
```

Corre las pruebas del SDK y del handoff (`node --test`), las de Playwright del tramo (construye la imagen del espacio una vez por corrida) y después `pruebas/tramo-inhabilitar/correr.sh` con todo lo anterior. Con argumentos o `SOLO_TRAMO=1` corre solo el tramo. Para no reconstruir la imagen al iterar: `CAMPUSIA_ESPACIO_IMAGEN=<imagen ya construida> CAMPUSIA_ESPACIO_IMAGEN_PROPIA=1`.

## Seguridad del espacio compartido

Todos los docentes de un curso comparten el contenedor del espacio: `pnpm dev` (código del curso) y cada ejecución del agente corren con el mismo usuario. Un proceso de un mismo usuario puede leer `/proc/<pid>/environ` de otro salvo que este no sea volcable (lo que pasa cuando su programa no es legible por ese usuario; por eso la fase 3 dejó `tini`, `node`, `bash`, `dash`, `git`, `pnpm` y Claude Code en `0711`). La revisión encontró que el token del agente (`cat_`) se podía leer igual: el shell del agente lo conservaba para todos los comandos y los programas comunes (`sleep`, `id`, `tail`, `cat`, ...) sí son volcables. Un vigía dejado por un profesor no dueño en `pnpm dev` leía el `cat_` del dueño durante su ejecución y podía inscribir profesores con sus permisos. Con el mismo camino quedaba expuesto el token del modelo (`cmt_`) en los procesos que se lanzan con `docker exec`, que reciben el entorno del contenedor.

Correcciones:

- `despliegue/espacio-trabajo/Containerfile`: todos los ejecutables ELF de `/usr/bin`, `/usr/sbin`, `/usr/local/bin` (siguiendo enlaces), `/usr/lib/git-core`, `/usr/libexec` y los de `gcc` quedan sin permiso de lectura para el usuario del contenedor: ningún proceso de un programa del sistema es volcable. Las bibliotecas (`*.so*`) no se tocan.
- `despliegue/espacio-trabajo/lib/bash` define `BASH_ENV=/usr/local/lib/campusia/agente.bashrc`. Ese archivo (de root) saca `CAMPUSIA_TOKEN_AGENTE` de las variables exportadas del shell (sigue como variable del shell) y define `node` para que solo `node` lo reciba. El agente usa las acciones como dice el contrato: un `.mjs` que se corre con `node`. Lo que corra por otra vía (`pnpm exec`, `npx`, `timeout node ...`) no recibe el token; el `CLAUDE.md` de la plantilla y del espacio lo dice.
- `node` lanzado desde el shell del agente carga `--import /usr/local/lib/campusia/sdk-fijo.mjs`, que resuelve `@campusia/sdk` a una copia de root dentro de la imagen (`/usr/local/lib/campusia/sdk`, sacada del `.tgz` de la plantilla). Así, un `node_modules/@campusia/sdk` modificado por otro profesor no recibe el token. Si la imagen se construyó sin el `.tgz`, se usa el de `node_modules` como antes.
- `nucleo/src/espacios.rs`: el `docker exec` de `permisos_en_contenedor` (solo con contenedores sin root) pasa `ANTHROPIC_AUTH_TOKEN` y `CAMPUSIA_TOKEN_CURSO` vacíos.
- Prueba: `pruebas/tramo-acciones-y-cupos/ataque/espacio-compartido.spec.ts`. Un proceso con el usuario del curso recorre `/proc/*/environ` y `cmdline` cada 5 ms mientras el agente del dueño inscribe con el SDK, corre comandos comunes, `Grep` y `Glob`; no tiene que ver ningún `cat_` ni `cmt_`. Además verifica que `/proc/1/environ` no se lee y que no queda ningún ejecutable ELF del sistema legible.

El intermediario (`nucleo/src/modelo.rs`) no cambió: fuera de una ejecución el consumo se sigue cargando al dueño, como pide la sección 7.3. El riesgo venía de poder leer el `cmt_`, y eso es lo que se cerró.

Límite que queda: el agente corre código del repositorio que pueden haber escrito otros docentes (por ejemplo, si importa un módulo del curso desde su script o corre `pnpm build`). El token del agente no llega a esos procesos salvo que el propio script los importe. Las quitas y los cambios de rol siguen necesitando la confirmación del profesor desde su sesión.

## Pruebas agregadas en esta ronda

| Archivo | Qué verifica |
|---|---|
| `ataque/espacio-compartido.spec.ts` | Lo de arriba |
| `ataque/confirmaciones-y-servicio.spec.ts` | Aprobar y rechazar con el curso archivado: `409 curso_archivado`, después del control de rol (otro docente: `403`), sin cambios; al desarchivar se pueden resolver. Token `cat_` vigente con el profesor suspendido, dado de baja, el curso archivado o la universidad deshabilitada: `401` en la petición siguiente, sin efectos |
| `aceptacion/confirmaciones-fallidas.spec.ts` | Confirmación que falla al aprobarse: persona ya quitada por la web (`404`), persona que perdió la marca (`400 no_es_profesor`), persona que ahora es la dueña (`409 es_dueno`). La confirmación queda `fallida` con el motivo en `error`, sale de las pendientes y no se vuelve a resolver (`409 confirmacion_resuelta`) |
| `handoff.test.mjs` | Que exista este handoff con lo que pide `CONVENCIONES.md` |

## Pruebas anteriores que no coincidían con el contrato

Además de lo que lista la sección 12 del contrato (pruebas de tokens personales, `cerrar-otras` y límite en USD), se corrigieron dos pruebas del tramo inhabilitar que usaban funciones eliminadas. Están en "Cambios en las pruebas (2026-11-10, corrección)" del contrato:

- `pruebas/tramo-inhabilitar/aceptacion/roles.spec.ts` "administra dos universidades distintas desde la misma sesión": usaba `PUT /api/admin/limite?universidad=B` (ahora `404`). Pasa a `PUT /api/admin/cupos/predeterminado?universidad=B`, que verifica lo mismo: el owner cambia la configuración de B sin tocar A.
- `pruebas/tramo-inhabilitar/ataque/roles.spec.ts` "las sesiones viejas de un owner quitado no sirven, ni revividas en la base": con el token personal revivido esperaba `403`; ahora espera `401 no_autenticado` (sección 6). Las demás peticiones siguen esperando `403`.

## Cambios al contrato que conviene anotar

- Sección 5.2: el shell del agente conserva `CAMPUSIA_TOKEN_AGENTE` como variable del shell, pero solo lo exporta a `node`.
- Sección 5.7: el `CLAUDE.md` pide correr el script directamente con `node`.
