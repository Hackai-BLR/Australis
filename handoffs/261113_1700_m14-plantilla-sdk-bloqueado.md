# M14: la plantilla del curso se instala con el SDK al que está bloqueada

_Creado: 2026-11-13 17:00. Tarea M14 de la fase 0 de `docs/plan.md`._

## Qué se hizo

- Medición en un contenedor local, armado como `despliegue/continuo/desplegar.sh` (node 22, pnpm 12.18.0, `pnpm pack` del SDK a `plantilla-curso/vendor`): hoy un curso libre no arrancaba. `pnpm install --frozen-lockfile` fallaba con `ERR_PNPM_TARBALL_INTEGRITY`, porque el hash de `plantilla-curso/pnpm-lock.yaml` no era el del paquete.
- El paquete es el mismo cada vez con pnpm 12.18.0 (dos empaques con fechas distintas dan el mismo hash), así que alcanzó con regenerar el bloqueo: `plantilla-curso/pnpm-lock.yaml` fija ahora el hash real.
- Con otra versión de pnpm el paquete cambia (pnpm 10 da otro hash). Por eso el trabajo `plantilla-curso` de CI usa pnpm 12.18.0, y ahora instala con `--frozen-lockfile`.
- `desplegar.sh` compara, después de empaquetar el SDK, el hash del paquete con el del bloqueo y falla la compilación con un mensaje claro si no coinciden.
- La imagen de prueba ya no reescribe el hash: `imagenes/fijar-sdk.mjs` pasó a `imagenes/verificar-sdk.mjs`, que solo compara y hace fallar la construcción de la imagen si no coinciden.
- La prueba esperada-como-fallo sobre el bloqueo (`checkpoint-b/aceptacion/historia.spec.ts`) es una prueba normal.

## Cómo se comprobó

- Contenedor local: empaquetar el SDK, pasar la comprobación de `desplegar.sh`, `pnpm install --frozen-lockfile`, `pnpm build` y `pnpm test` de la plantilla (27 pruebas, 0 fallas).
- `docker build --target web` de `nucleo.Dockerfile` (corre `verificar-sdk.mjs`).
- No se corrió el checkpoint B completo ni CI.

## Pendiente

- Cuando cambie el código del SDK o su versión, hay que regenerar el hash del bloqueo (el mensaje de `desplegar.sh` y de la imagen de prueba lo dice).
