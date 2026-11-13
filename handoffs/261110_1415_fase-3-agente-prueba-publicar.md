# Fase 3: agente, versión de prueba, publicar y versiones

_Creado: 2026-11-10 14:15. Sigue a `261110_0720_fase-2-cursos-inscripciones-enrutador.md` y `261110_0532_tramo-experimento-intermediario.md`. Contrato: `contratos/fase-3.md`._

## Qué se hizo

- **Núcleo** (`nucleo/`), migración `3001_agente.sql`: intermediario del modelo (`modelo.rs`, proveedores `suscripcion` y `api`), medición de uso y límite mensual, escucha de espacios y proxy de salida (`proxy_salida.rs`), espacio de trabajo por curso (`espacios.rs`), agente con transmisión SSE y commits en `prueba` (`agente.rs`), enrutador `-prueba`, publicar con verificación aislada, versiones y volver (`publicar.rs`, `repo.rs`).
- **Interfaz** (`interfaz/`): modos Publicado y Prueba, panel Editar con el chat en vivo, Publicar y panel Versiones.
- **Espacio de trabajo** (`despliegue/espacio-trabajo/`, `despliegue/construir-espacio.sh`): imagen con Node 22, pnpm, git y Claude Code con versión fija, hooks y `campusia-espacio` / `campusia-agente`.

## Correcciones de la revisión del tramo

Cada una tiene su prueba en `pruebas/fase-3/`.

- **La imagen publicada ya no ejecuta código del curso con red ni como root** (`publicar.rs`, `ataque/publicar.spec.ts`). Antes la etapa `imagen` corría el `Containerfile` del curso con la red del demonio, como root y sin límites, y eso volvía a ejecutar `pnpm install` (con los scripts del `package.json`, que el agente puede cambiar) y `pnpm build`. Ahora la etapa empaqueta, en un contenedor sin red, sin capacidades y con `no-new-privileges`, el `node_modules` instalado en `dependencias` y el `dist` de `compilacion` (que ya corrieron aislados), y construye la imagen con `docker build --network none` y una receta fija del núcleo (`node:22-bookworm-slim`, la misma base que el espacio, para que los módulos nativos sean compatibles), sin ningún paso que corra código del curso. El `Containerfile` de la plantilla se sigue usando solo para la primera imagen del curso (fase 2), que sale de la plantilla. La imagen publicada lleva también las dependencias de desarrollo: `pnpm prune --prod` sin red se cuelga.
- **Los scripts del agente no leen el token de modelo** (`despliegue/espacio-trabajo/`, `ataque/agente.spec.ts`). `tini`, `node`, `bash`, `dash`, `git`, `pnpm` y Claude Code quedan con modo `0711`: los procesos que los ejecutan no son volcables y otro proceso del mismo usuario no puede leer su `/proc/<pid>/environ`. Claude Code usa como shell `/usr/local/lib/campusia/bash`, que borra `ANTHROPIC_*` y `CAMPUSIA_TOKEN_CURSO` antes de cada comando. `campusia-agente` saca el token del entorno antes de correr cualquier programa y lo vuelve a poner solo para Claude Code; `campusia-espacio` borra `ANTHROPIC_*` y pasa `CAMPUSIA_TOKEN_CURSO` solo a `pnpm dev`. Queda un límite: el código del curso que corre `pnpm dev` (que escribe el agente) tiene `CAMPUSIA_TOKEN_CURSO` en `process.env` por diseño, y archivos del sistema legibles por cualquiera (por ejemplo `/etc`) se pueden leer con un script; no hay secretos ahí.
- **El intermediario rechaza herramientas del servidor y contenido por URL** (`modelo.rs`, `ataque/intermediario.spec.ts`): `400 invalid_request_error` si `tools` trae herramientas con tipo de servidor (`web_fetch_*`, `web_search_*`, `code_execution_*`, ...; solo se aceptan las del cliente: sin tipo, `custom`, `bash_*`, `text_editor_*`, `computer_*`, `memory_*`), si hay `mcp_servers` o `container`, si algún bloque (también dentro de `tool_result` o `system`) tiene una fuente `url`, o si el cuerpo no es JSON. No se reenvía ni se registra uso.
- **El límite mensual reserva antes de reenviar** (`modelo.rs`, `ataque/limite.spec.ts`): cada petición reserva una estimación de su costo máximo (bytes del cuerpo como tokens de entrada y `max_tokens` como salida, con los precios del modelo) y libera la reserva al registrar el uso real. Si ya hay reservas que con el total del mes alcanzan el límite, la petición espera a que terminen y vuelve a controlar; si el total llega al límite, `429`. Así el sobregasto queda acotado a una petición. Las peticiones de `pnpm dev` siguen sin contar como actividad del espacio (fuera de alcance).
- **El agente sigue la sesión con `--continuar`** (`espacios.rs`, `agente.rs`, `aceptacion/espacio.spec.ts`): el núcleo recuerda en qué generación del contenedor hubo una ejecución; mientras el espacio sigue encendido pasa `--continuar` y el pedido tal cual. Si el contenedor se recreó o se reinició (inactividad, tiempo máximo, núcleo reiniciado) vuelve al resumen de la conversación en el texto. Como consecuencia, los pedidos al modelo de una ejecución incluyen los mensajes de las anteriores; `resultadosDeHerramientas` en `pruebas/fase-3/lib/modelo-falso.ts` ahora ignora los resultados de herramientas que ya aparecían antes de `desde`.
- **Tiempo máximo del agente** (`agente.rs`, `ataque/tiempo-agente.spec.ts`): al superar `AGENTE_MAX_SEG` se abren los permisos de la copia antes de detener el espacio, para que los cambios parciales entren en el commit de `prueba`. El mensaje queda en `error` con "El agente superó el tiempo máximo y se detuvo...". El espacio vuelve a encenderse con el pedido siguiente.
- **Pruebas nuevas sin cambios de código**: `409 curso_no_listo` con el curso `preparando` o `error`, antes que `agente_ocupado` y `sin_cambios` y después de la validación y del rol (`ataque/permisos.spec.ts`); `PROVEEDOR_CONTENEDORES=ninguno` con `503` en espacio, agente, publicar y volver y las lecturas funcionando (`aceptacion/sin-contenedores.spec.ts`); este handoff con la corrida real (`despliegue/despliegue.spec.ts`).

## Cómo se compila, se levanta y se prueba

Igual que en `contratos/fase-3.md`, secciones 2 y 3. `bash pruebas/fase-3/correr.sh` corre todo; `bash pruebas/fase-3/manual/modelo-real.sh` corre la prueba con el modelo real.

## Prueba con el modelo real

- Fecha: 2026-11-10 (terminó 14:12 UTC)
- Duración: 182 s de la prueba (3.5 min con el arranque de Playwright y la imagen del espacio)
- Consumo: 9 consultas con claude-haiku-5-5, 2649 tokens de salida, USD 0.0509 según la tabla de precios incluida
- Resultado: ok. Pedido real con haiku (ruta `/hola` en `servidor/app.ts`), visto en `-prueba`, publicado como v1 y visto en `-curso`. El registro del núcleo no contiene el token.
- Comando: `bash pruebas/fase-3/manual/modelo-real.sh`

## Pendientes

- Las peticiones del código del curso al intermediario no cuentan como actividad, y no hay cuotas por minuto ni de concurrencia por curso (fuera de alcance en el contrato).
- La imagen publicada usa `node:22-bookworm-slim` en lugar de la `node:22-alpine` del `Containerfile` de la plantilla, y trae las dependencias de desarrollo.
