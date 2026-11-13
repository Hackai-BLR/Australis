# Tramo plantilla de curso y SDK

Rama `tramo-plantilla-sdk`, en paralelo con la fase 1 del núcleo. Solo se tocaron `sdk/`, `plantilla-curso/`, `contratos/tramo-plantilla-sdk.md`, `pruebas/tramo-plantilla-sdk/`, el `.gitignore` de la raíz y este handoff. No se tocó `nucleo/`, `interfaz/` ni `despliegue/`.

## Qué se hizo

- Contrato del tramo en `contratos/tramo-plantilla-sdk.md`: identidad y entorno (copia fiel de `identidad.md` del orquestador), reglas de verificación en orden con su código de error, API pública del SDK, rutas, datos, interfaz e imagen de la plantilla, permisos y criterio de terminado.
- `sdk/` (`@campusia/sdk` 0.1.0, ESM, sin `dependencies`, `hono` como `peerDependencies`):
  - `verificarIdentidad` sincrónica con Ed25519 de `node:crypto` y `ErrorIdentidad` tipado (`configuracion`, `ausente`, `formato`, `firma`, `version`, `curso`, `vigencia`, `vencido`, `futuro`).
  - `@campusia/sdk/hono`: `identidadCampus()`, `requiereRol(...)` (el dueño cumple `profesor`) y `obtenerIdentidad(c)`.
  - `ClienteCampus` (`yo()`, `inscriptos()`) y `clienteDesdeEntorno()`, con `redirect: 'manual'` para que el token no salga a otro servidor y `ErrorApi` tipado.
  - Pruebas unitarias propias en `sdk/pruebas/`.
- `plantilla-curso/`: un proceso Node 22 con Hono que sirve API y SPA en `PORT`; todo salvo `/salud` pasa por el middleware del SDK. SQLite en `${CAMPUSIA_DATOS}/curso.sqlite` con WAL y migraciones al arrancar. Rutas `/api/yo`, `/api/portada` (502 si la plataforma falla, `yo()` cacheado 60 s), `/api/clases` (GET, y POST para dueño y profesores con validación, 415 y límite de 100 KB). SPA en React con identidad propia (serif, verde `#14402C`/`#2E7D5B`, estado vacío crema), indicador de rol para dueño y profesor, responsive. `Containerfile` multi-etapa sobre `node:22-alpine`, usuario `node`, `/app` de root, `/datos` del usuario del curso, sin herramientas de compilación ni npm/corepack en la imagen final, `HEALTHCHECK` con Node. `CLAUDE.md` con las reglas para el agente del curso. Pruebas propias en `servidor/*.test.ts`.
- `pruebas/tramo-plantilla-sdk/`: `correr.sh` y siete archivos de `node --test` (aceptación y ataque del SDK, del repo, del contenedor, de la imagen y de la interfaz con Chromium), con una plataforma falsa y firma de encabezados como el núcleo.

## Cómo se compila, se levanta y se prueba

```bash
pnpm --dir sdk install && pnpm --dir sdk run build && pnpm --dir sdk test
rm -f plantilla-curso/vendor/campusia-sdk-*.tgz && pnpm --dir sdk pack --pack-destination plantilla-curso/vendor
pnpm --dir plantilla-curso install && pnpm --dir plantilla-curso run build && pnpm --dir plantilla-curso test
docker build -t campusia-curso:dev -f plantilla-curso/Containerfile plantilla-curso
docker run --rm -p 3000:3000 -v campusia-dev:/datos -e CAMPUSIA_CURSO=redes -e CAMPUSIA_CLAVE_PUBLICA=<clave de prueba> \
  -e CAMPUSIA_API=http://host.docker.internal:8080 -e CAMPUSIA_TOKEN_CURSO=token-prueba \
  --add-host host.docker.internal:host-gateway campusia-curso:dev
```

Todas las pruebas, desde un árbol limpio y sin pasos manuales:

```bash
bash pruebas/tramo-plantilla-sdk/correr.sh
```

Necesita Docker sin sudo, Node 22, pnpm y el Chromium de Playwright en `~/.cache/ms-playwright`. La imagen de prueba es `campusia-curso:tramo-prueba` (`IMAGEN_CURSO` la cambia).

## Despliegue

Este tramo no despliega nada por sí mismo. El núcleo (fase 2) copia `plantilla-curso/` como repo inicial de cada curso, empaqueta el SDK en `vendor/` y construye la imagen con `plantilla-curso/` como único contexto. El contenedor se corre endurecido: `--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --memory 256m`, volumen en `/datos` y las seis variables del contrato. Ninguna clave real en el repo ni en la imagen.

## Decisiones

- Verificación estricta en el orden de la sección 2 del contrato: la firma se comprueba antes de leer la carga, así un atacante no obtiene información de errores de formato del JSON.
- La identidad solo sale de `X-Campus-Identidad`; cookies, consulta, `Authorization` y encabezados inventados se ignoran.
- Configuración inválida (clave que no da 32 bytes, curso vacío) niega todo salvo `/salud`.
- El SDK llega a la plantilla como `.tgz` en `vendor/` con versión fija (`file:vendor/campusia-sdk-0.1.0.tgz`), así la imagen se construye sin red hacia un registro privado ni rutas fuera del contexto.
- Imagen `node:22-alpine` multi-etapa; en la final se quitan npm, corepack y yarn. Pesa unos 284 MB (límite 350 MB).
- Pruebas propias del SDK y de la plantilla con `node --test --experimental-strip-types`, sin vitest, para no sumar dependencias.

## Desvíos del plan

- `imagen.ataque.test.mjs`: la prueba «el proceso del curso no corre como root» usaba `docker top <contenedor> -o user`, que Docker siempre rechaza porque exige la columna PID. Se cambió a `-o pid,user` con la misma aserción. Queda registrado en «Cambios en las pruebas» del contrato.
- El `.tgz` de `vendor/` no se versiona (se ignora desde el `.gitignore` de la raíz): lo genera `correr.sh` desde `sdk/`. El `.gitignore` propio de la plantilla no lo ignora, para que los repos de curso que se creen desde ella sí lo lleven.

## Resultado de las pruebas

`bash pruebas/tramo-plantilla-sdk/correr.sh` termina con código 0 desde un árbol limpio:

- Aceptación: 34/34.
- Ataque: 56/56.
- Pruebas propias de `sdk/` y de `plantilla-curso/`: pasan.

## Pendientes conocidos

- El núcleo todavía no implementa `GET /api/curso/yo` ni `GET /api/curso/inscriptos`; las pruebas usan una plataforma falsa con los formatos del contrato. Se integran en la fase 2.
- Al crear un curso, el núcleo tiene que generar el `.tgz` del SDK (o copiarlo de un artefacto de compilación) dentro de `vendor/` antes de construir la imagen, porque en este repo no se versiona.
- Las pruebas de punta a punta dependen de Docker y de Chromium instalado; no hay variante para Podman en `correr.sh`, aunque el `Containerfile` es compatible.
- Al integrar con la fase 1, el verificador tiene que correr también `pruebas/<fase>/correr.sh` de cada fase.
