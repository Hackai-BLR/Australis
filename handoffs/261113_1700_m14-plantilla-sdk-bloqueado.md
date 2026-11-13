# M14: la plantilla del curso se instala con el SDK al que está bloqueada

_Creado: 2026-11-13 17:00. Tarea M14 de la fase 0 de `docs/plan.md`._

## Qué se halló

- En un contenedor local armado como `desplegar.sh` (node 22, pnpm 12.18.0, SDK compilado y empaquetado con `pnpm pack` a `plantilla-curso/vendor`), con los archivos con el modo que deja `git` en Linux (0644), el hash de `plantilla-curso/pnpm-lock.yaml` coincide con el paquete: `pnpm install --frozen-lockfile`, `pnpm build` y `pnpm test` de la plantilla pasan (27 pruebas). Un curso libre arranca en el servidor.
- El desajuste que vieron M9 y la integración venía de otro lado: el paquete incluye los modos de los archivos, y un árbol copiado desde Windows los deja en 0755, lo que cambia los bytes del `.tgz` (`ERR_PNPM_TARBALL_INTEGRITY`). Con el mismo modo, dos empaques en momentos distintos dan los mismos bytes. Con pnpm 10 puede variar, por eso CI usa 12.18.0.
- Por lo tanto el bloqueo no se regeneró: ya era correcto.

## Qué se hizo

- CI: el trabajo `plantilla-curso` usa pnpm 12.18.0 (el de producción) e instala con `--frozen-lockfile`.
- `despliegue/continuo/desplegar.sh`: después de empaquetar el SDK compara su hash con el del bloqueo y falla la compilación con un mensaje claro si no coinciden.
- Imagen de prueba: `imagenes/fijar-sdk.mjs` pasó a `imagenes/verificar-sdk.mjs`, que solo compara y hace fallar la construcción si no coinciden. `nucleo.Dockerfile` normaliza el modo de los archivos del SDK (0644) antes de empaquetar, para que el contexto copiado desde Windows dé los mismos bytes.
- La prueba esperada-como-fallo sobre el bloqueo (`checkpoint-b/aceptacion/historia.spec.ts`) es una prueba normal.

## Cómo se comprobó

- Contenedor local: empaquetar, comprobación de `desplegar.sh`, instalar con `--frozen-lockfile`, compilar y probar la plantilla.
- `docker build --target web` de `nucleo.Dockerfile`, sin caché (corre `verificar-sdk.mjs`).
- No se corrió el checkpoint B completo.

## Pendiente

- Cuando cambie el código del SDK o su versión, hay que regenerar el hash del bloqueo (los dos mensajes de falla lo dicen).
