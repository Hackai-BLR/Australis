# Cierre del tramo: acciones del profesor para el agente, sin tokens personales y cupos de tokens

_Creado: 2026-11-10 23:34. Rama `tramo-acciones-y-cupos`, desde `main` con las fases 1 a 4, el tramo inhabilitar y la reautenticación por sesión ya integrados (sigue a `261110_1618_integracion-fases-3-e-inhabilitar.md`). Contrato: `contratos/tramo-acciones-y-cupos.md`. Alcance: `.orquestacion/tramo-acciones-y-cupos.md`. El detalle de la ronda de revisión del espacio compartido está en `261110_2141_tramo-acciones-y-cupos.md`; este handoff cierra el tramo. No se hizo merge a `main`._

## Qué se hizo

### Acciones fijas del profesor para el agente

- `nucleo/src/acciones.rs`: rutas fijas `/api/curso/acciones/*` (listar inscriptos, inscribir por mails, importar el listado del SIU, ver, generar y activar el código, pedir quitar personas y pedir cambiar roles) en la escucha de espacios y en la de la API para cursos. No es extensible.
- Token del agente `cat_` por ejecución (`tokens_agente`, solo la huella HMAC): atado al curso y al profesor que habla en el panel Editar, con exactamente sus permisos en ese momento (mismos controles que la web: dominios de la universidad, solo el dueño agrega o quita profesores y cambia roles, nadie quita al dueño). Se revoca al terminar la ejecución y vence a `AGENTE_MAX_SEG`. Fuera de una ejecución, el token del curso (`cct_`) solo lee.
- Quitar y cambiar roles generan una confirmación (`confirmaciones_agente`) que solo quien la pidió aprueba o rechaza desde el panel Editar, con su sesión. Si al aprobarla ya no se puede aplicar, queda `fallida` con el motivo.
- Auditoría con el profesor como responsable y `agente = 1`.
- SDK `@campusia/sdk` 0.3.0 (`sdk/src/cliente.ts`) con los métodos de las acciones y `CAMPUSIA_TOKEN_AGENTE`. Plantilla con el SDK nuevo y `CLAUDE.md` con las acciones; el espacio trae el mismo texto como memoria gestionada (`despliegue/espacio-trabajo/CLAUDE.md`).

### Sin tokens personales

- Se borraron las rutas `/api/tokens*`, `/api/sesiones/cerrar-otras` y `PUT /api/admin/limite`, la pantalla "Tokens de API" y "Cerrar las demás sesiones" del menú de perfil. Cualquier `Authorization` en la API pública responde `401`; nunca cae a la cookie. La tabla `tokens_api` queda sin uso.
- El owner ve las sesiones activas de cualquier persona (dispositivo, IP, último uso) y las cierra desde Administración › Personas (`nucleo/src/sesiones_owner.rs`, `interfaz/src/Sesiones.tsx`). `sesiones.ultimo_uso` se actualiza como mucho una vez por minuto.

### Cupos de tokens del modelo

- `nucleo/src/cupos.rs`, `interfaz/src/Cupos.tsx`: cupo mensual por universidad (owner), reparto por profesor con predeterminado y excepciones (administrador de su universidad u owner de cualquiera), reserva = lo no repartido; `409 cupo_excedido` si lo repartido supera el total.
- Medición en `uso_modelo.tokens` (entrada + caché + salida) y `uso_modelo.usuario_id`: durante una ejecución se descuenta al profesor que pidió; fuera, al dueño del curso. Ningún encabezado del cliente cambia a quién se descuenta.
- Corte antes de ejecutar el agente (`429 cupo_agotado`) y en el intermediario antes de reenviar (`429 rate_limit_error`, `x-should-retry: false`), con `RESERVA_TOKENS_PEDIDO` por pedido en vuelo para acotar el exceso en paralelo.
- Con suscripción, un `429` de Anthropic deja el modelo no disponible durante `retry-after` o `ESPERA_SIN_USO_SEG`; el panel Editar muestra "No hay uso disponible por el momento".
- Vistas: owner por universidad, administrador por profesor, profesor en el panel Editar (`#cupo`). Aviso del 80 % solo en la interfaz, sin mails.
- Reemplaza el límite en USD: la migración convierte `limite_usd × 1 000 000` en `cupo_tokens`; `limite_usd` queda como dato histórico.

### Migración y despliegue

- `nucleo/migraciones/6001_acciones_y_cupos.sql` (las anteriores no se tocaron).
- `despliegue/campusia.env.ejemplo`: `RESERVA_TOKENS_PEDIDO=20000` y `ESPERA_SIN_USO_SEG=300`.
- `despliegue/construir-espacio.sh` copia el `.tgz` del SDK al contexto de la imagen; `Containerfile`, `lib/bash`, `lib/agente.bashrc`, `lib/sdk-fijo.mjs` y `lib/sdk-ganchos.mjs` endurecen el espacio compartido (ver el handoff de las 21:41).

## Cómo compilar

```bash
. "$HOME/.cargo/env"
cargo build --manifest-path nucleo/Cargo.toml
pnpm --dir interfaz install && pnpm --dir interfaz run build
pnpm --dir sdk install && pnpm --dir sdk run build
rm -f plantilla-curso/vendor/campusia-sdk-*.tgz && pnpm --dir sdk pack --pack-destination plantilla-curso/vendor
bash despliegue/construir-espacio.sh --etiqueta campusia-espacio:1
```

Conviene empaquetar el SDK antes de construir la imagen: sin el `.tgz`, el espacio usa el SDK de `node_modules` del curso.

## Cómo levantar

Como la fase 3, con `RAIZ_ARCHIVOS` y `DIR_RESPALDOS` de la fase 4 y, si se quiere, `RESERVA_TOKENS_PEDIDO` y `ESPERA_SIN_USO_SEG`:

```bash
nucleo/target/debug/campusia-nucleo migrar
nucleo/target/debug/campusia-nucleo sembrar pruebas/tramo-inhabilitar/datos.json
nucleo/target/debug/campusia-nucleo crear-owner equipo@campusia.prueba
nucleo/target/debug/campusia-nucleo
```

## Cómo probar

```bash
bash pruebas/tramo-acciones-y-cupos/correr.sh
```

Corre desde cero, sin pasos manuales: SDK y handoff (`node --test`), Playwright del tramo (construye la imagen del espacio una vez por corrida y la borra al terminar) y después `pruebas/tramo-inhabilitar/correr.sh` (tramo inhabilitar, fases 1 a 4 y tramos anteriores). Con argumentos o `SOLO_TRAMO=1` corre solo el tramo. Para iterar sin reconstruir la imagen: `CAMPUSIA_ESPACIO_IMAGEN=<imagen> CAMPUSIA_ESPACIO_IMAGEN_PROPIA=1`. `CAMPUSIA_SIN_COMPILAR=1` y `PRUEBAS_WORKERS` funcionan como antes.

## Cómo desplegar

Igual que la integración anterior (`despliegue/instalar.sh`, `campusia-nucleo.service`, `Caddyfile`), con estos pasos extra:

1. Agregar `RESERVA_TOKENS_PEDIDO` y `ESPERA_SIN_USO_SEG` a `/srv/campusia/config/campusia.env` si se quieren valores distintos de los predeterminados.
2. Empaquetar el SDK 0.3.0 en `plantilla-curso/vendor` y reconstruir la imagen del espacio con `construir-espacio.sh`; reiniciar los espacios para que tomen la imagen nueva.
3. Al arrancar, el núcleo aplica `6001_acciones_y_cupos`: cada universidad queda con `limite_usd × 1 000 000` tokens por mes. Revisar los cupos en Owner › Cupos.
4. Avisar a quienes usaban tokens personales que dejan de funcionar (`401`).

## Resultado de las pruebas

- Aceptación del tramo: 39/39.
- Ataque del tramo: 33/33.
- SDK y handoff (`node --test`): todas pasan.
- Fases y tramos anteriores (`pruebas/tramo-inhabilitar/correr.sh`), con los ajustes de la sección 12 del contrato: pasan.

## Decisiones

- El token del agente es propio por ejecución (`cat_`) y no una ampliación del `cct_`: así el `cct_` del código del curso sigue siendo de solo lectura y la ejecución queda atada al profesor que habla.
- Los permisos se recalculan en cada pedido sobre el profesor del token: suspender, dar de baja, archivar el curso o deshabilitar la universidad cortan un `cat_` vigente en la petición siguiente.
- Las confirmaciones se resuelven con la sesión del profesor (y la reautenticación de la fase 1), nunca con un token.
- Fuera de una ejecución del agente, el consumo del intermediario se carga al dueño del curso.
- 1 USD del límite anterior equivale a 1 millón de tokens por mes en la migración.
- En el espacio compartido, el token del agente solo se exporta a `node`, y `node` resuelve `@campusia/sdk` a una copia de root de la imagen; los ejecutables ELF del sistema no son legibles por el usuario del contenedor, para que ningún proceso sea volcable desde otro docente.

## Desvíos del plan

- Contrato, sección 5.2: el shell del agente conserva `CAMPUSIA_TOKEN_AGENTE` como variable del shell pero solo lo exporta a `node` (el contrato decía que lo dejaba pasar a todos los comandos).
- Contrato, sección 5.7: el `CLAUDE.md` pide correr el script directamente con `node`; `pnpm exec`, `npx` o `timeout node` no reciben el token.
- Pruebas anteriores que no coincidían con el contrato y se corrigieron sin cambiar lo que verifican (anotado en "Cambios en las pruebas (2026-11-10, corrección)" del contrato):
  - `pruebas/tramo-inhabilitar/aceptacion/roles.spec.ts` "administra dos universidades distintas desde la misma sesión": `PUT /api/admin/limite?universidad=B` pasa a `PUT /api/admin/cupos/predeterminado?universidad=B`.
  - `pruebas/tramo-inhabilitar/ataque/roles.spec.ts` "las sesiones viejas de un owner quitado no sirven, ni revividas en la base": con el token personal revivido espera `401 no_autenticado` en lugar de `403`.
- Las pruebas que la sección 12 del contrato manda quitar o ajustar (tokens personales, `cerrar-otras`, límite en USD) se quitaron o ajustaron: se borraron `pruebas/fase-1/aceptacion/tokens.spec.ts`, `pruebas/fase-1/ataque/tokens.spec.ts` y `pruebas/fase-3/ataque/limite.spec.ts`.

## Pendientes conocidos

- El agente puede correr código del repositorio escrito por otros docentes (por ejemplo, si su script importa un módulo del curso o corre `pnpm build`). El token del agente no llega a esos procesos salvo que el propio script los importe; las quitas y los cambios de rol igual requieren la confirmación del profesor.
- `limite_usd` y `uso_agente` (USD) quedan como datos informativos; se pueden quitar de las respuestas en un tramo futuro.
- `tokens_api` queda en la base sin uso; borrarla sería una migración aparte.
- Los avisos del 80 % son solo en la interfaz; si más adelante se quieren mails, hay que definir frecuencia y destinatarios.
- La disponibilidad del modelo con suscripción se guarda en memoria: un reinicio del núcleo la vuelve a "disponible" hasta el siguiente `429`.
