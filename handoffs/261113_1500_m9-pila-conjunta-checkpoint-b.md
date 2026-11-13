# M9: pila conjunta y pruebas de navegador del checkpoint B

_Creado: 2026-11-13 15:00. Tarea M9 de la fase 0 de `docs/plan.md`._

## Qué se hizo

- Un solo comando levanta el núcleo, Australis y un modelo falso juntos sobre una base nueva, como en producción: `pruebas/australis/checkpoint-b/correr.sh` (instala, levanta la pila, corre las pruebas y la baja). `pila.sh arriba` deja la pila corriendo y `pila.sh bajar` la baja.
- La pila (`comun/pila-b.ts`) usa Docker, una red privada y un puerto libre en `127.0.0.1`:
  - núcleo (imagen `australis-b-nucleo`): con `AUSTRALIS_URL`, la clave de identidad, `AUSTRALIS_TOKEN_MODELO`, el proveedor `api` apuntando al modelo falso y los cursos libres en contenedores reales;
  - Australis: backend con `AUTH_MODE=header`, `IDENTITY_PUBLIC_KEY`, `AI_PROVIDER=proxy` y el token `cmt_` como `AI_API_KEY` (nunca la credencial del modelo), y el nginx del frontend como destino del núcleo;
  - modelo falso y Turnstile falso en un solo contenedor (`imagenes/falsos/falsos.mjs`), con un registro de los pedidos que recibe el modelo.
- La imagen del núcleo (`imagenes/nucleo.Dockerfile`) trae `pnpm`, `node`, `git` y el cliente de Docker, y el SDK ya compilado: un curso libre arranca (queda `listo` y `encendido`).
- El guion del modelo falso responde a "ética" y "bibliografía" con operaciones reales `add_section` y a notas, asistencia o actas sin ninguna operación.
- Pruebas Playwright en `pruebas/australis/checkpoint-b/`: `aceptacion/historia.spec.ts` (pasos 1 a 6) y `ataque/rechazos.spec.ts` (encabezado falso, vencido, ajeno o alterado; pedidos que no pasan por el núcleo; persona inhabilitada; profesor sin cupo; credencial del modelo; la IA y las notas).

## Hallazgos

- `plantilla-curso/pnpm-lock.yaml` fija el hash de `vendor/campusia-sdk-0.3.0.tgz`, y el `pnpm pack` del SDK no produce esos bytes: `pnpm install --frozen-lockfile` falla con `ERR_PNPM_TARBALL_INTEGRITY` al construir el curso. La imagen de prueba reescribe ese hash en su copia de la plantilla (`imagenes/fijar-sdk.mjs`). El servidor real necesita lo mismo o regenerar el bloqueo.
- Un administrador de universidad que no es profesor entra a Australis como alumno y recibe 403 en un campus con módulos, y `/api/admin/cursos` no lista los campus con módulos. La prueba "el administrador ve esas inscripciones" queda como `test.fixme` hasta que se integre M11. La secretaría (dueño) sí abre el campus.
- En producción nadie sirve todavía el frontend de Australis detrás de `campus.campusia.tech`: la pila de prueba apunta el núcleo al nginx del frontend, que reenvía `/api/` al backend.

## Desvíos

- `pruebas/australis/playwright.config.ts` (de M8): `testMatch` pasó de `checkpoint-[a-z]` a `checkpoint-a`, para que la configuración del checkpoint A no recoja las pruebas del B, que usan otra pila.

## Pendiente

- Cuando se integre M11, sacar el `fixme` de la prueba del administrador.
- Los pasos 1, 2 y 6 se repiten en `campusia.tech` después de M6, a mano.
