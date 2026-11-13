# Despliegue continuo completo: SDK, plantilla y espacio de trabajo

_Creado: 2026-11-10 23:52. Rama `tramo-despliegue-completo`, desde `main` con el tramo de acciones y cupos unido (sigue a `261110_2334_tramo-acciones-y-cupos.md`). No se hizo merge a `main`._

## Problema

En producción el despliegue continuo solo instalaba el binario del núcleo y la interfaz (`instalar.sh --binario --interfaz`). No compilaba ni empaquetaba el SDK, no actualizaba `/srv/campusia/plataforma/{plantilla-curso,sdk,espacio-trabajo}` y no reconstruía la imagen del espacio cuando cambiaban `sdk/`, `plantilla-curso/` o `despliegue/espacio-trabajo/`.

## Qué se hizo

### `despliegue/continuo/desplegar.sh`

- `--etapa compilar` instala las dependencias de `interfaz` y `sdk` (con red) y, sin red, compila el SDK y lo empaqueta con `pnpm pack` en `plantilla-curso/vendor/`. Falla si no queda el `.tgz` que nombra la dependencia `@campusia/sdk` de `plantilla-curso/package.json`.
- Etapa nueva `DESPLIEGUE_ESPACIO` (defecto `desplegar.sh --etapa espacio`), después de instalar y antes de la salud. Corre como el usuario del servicio con su Docker sin root (`DOCKER_HOST` del socket de `/run/user/<uid>`). Reconstruye la imagen con `despliegue/construir-espacio.sh --etiqueta <imagen> --cli docker --plantilla fuentes/<commit>/plantilla-curso --espacio fuentes/<commit>/despliegue/espacio-trabajo` solo si:
  - la imagen no existe, o
  - no hay commit anterior, o
  - `git diff` entre el anterior y el nuevo toca `DESPLIEGUE_ESPACIO_CARPETAS` (defecto `sdk plantilla-curso despliegue/espacio-trabajo despliegue/construir-espacio.sh`).
- La imagen es `DESPLIEGUE_ESPACIO_IMAGEN`, si no `ESPACIO_IMAGEN` (viene de `campusia.env`, que la unidad ya carga), si no `campusia-espacio:1`.
- Las etapas reciben además `REFERENCIA` (el commit contra el que se compara).
- Si la etapa del espacio falla: se reinstala la versión anterior (la imagen vieja queda, `docker build` no reetiqueta si falla), se registra `fallo-espacio` y sale con 1. Si falla la salud: se reinstala la anterior y se vuelve a correr la etapa del espacio para la anterior (reconstruye solo si las carpetas difieren); `revertido` o `fallo-reversion` como antes.
- `continuo.env.ejemplo`: `DESPLIEGUE_ESPACIO`.

### `despliegue/continuo/campusia-instalar`

- Pasa `--plantilla`, `--sdk` y `--espacio` a `instalar.sh`.
- Las fuentes de `plantilla-curso/`, `sdk/` y `despliegue/espacio-trabajo/` salen del commit publicado (`git archive` del espejo de root), no de las fuentes de `campusia`. De las fuentes solo se toman los artefactos compilados: `plantilla-curso/vendor/campusia-sdk-*.tgz` y `sdk/dist` (sin `node_modules`), leídos como `campusia` y rechazando enlaces simbólicos o archivos especiales en cualquier punto de la ruta o del contenido.
- Si las fuentes no tienen el SDK empaquetado (por ejemplo, la reinstalación de un commit anterior compilado antes de este cambio), avisa y conserva la plantilla, el SDK y el espacio instalados en lugar de fallar, para que la vuelta atrás siga funcionando.

## Pruebas

| Archivo | Qué cubre | Resultado |
|---|---|---|
| `pruebas/tramo-infraestructura/test_despliegue.py` | primer despliegue construye la imagen; sin cambios no reconstruye; cambios en `sdk/`, `plantilla-curso/` o `espacio-trabajo/` reconstruyen; imagen inexistente reconstruye; etiqueta de `ESPACIO_IMAGEN`; espacio fallido vuelve a la anterior (`fallo-espacio`); salud fallida reconstruye el espacio anterior. `docker` falso en el contenedor | 22/22 (aceptación 13/13, ataque 9/9) |
| `pruebas/tramo-infraestructura/test_instalador.py` (nuevo) | `campusia-instalar` real como root: recibe `--plantilla --sdk --espacio`, la plantilla es la del commit y no la alterada en las fuentes, `.tgz` y `sdk/dist` de las fuentes, sin `node_modules`; rechaza enlaces en el `.tgz`, `vendor`, `sdk/dist`; sin SDK empaquetado conserva la plataforma | 6/6 (aceptación 2/2, ataque 4/4) |
| `pruebas/tramo-infraestructura-cierre/test_compilacion.py` | la compilación por defecto real deja `plantilla-curso/vendor/campusia-sdk-0.3.0.tgz` con `dist/index.js` y `dist/hono.js` | 3/3 |
| `pruebas/tramo-infraestructura-cierre/test_levantar.py` | el stub de compilación copia el `.tgz` y `sdk/dist`; `DESPLIEGUE_ESPACIO` es un stub que registra el commit; prueba nueva de la plantilla, el SDK y el espacio desplegados | no se corrió (Ansible completo) |

Cómo correrlas sin las fases ni Ansible:

```bash
cd pruebas/tramo-infraestructura
uv venv -q --python 3.12 .herramientas/venv && uv pip install -q --python .herramientas/venv/bin/python -r requisitos.txt
.herramientas/venv/bin/python -m pytest -q test_despliegue.py test_instalador.py
cd ../tramo-infraestructura-cierre && ../tramo-infraestructura/.herramientas/venv/bin/python -m pytest -q test_compilacion.py
```

## Pendiente

- Correr `pruebas/tramo-infraestructura-cierre/correr.sh` (levantar con Ansible en Debian 13 y Ubuntu 24.04) antes de unir a `main`.
- La primera vez en producción la imagen se reconstruye si falta o si cambió algo desde el commit en `actual`. Los espacios que ya están corriendo siguen con la imagen vieja hasta que se reinician.
- La construcción real de la imagen necesita red (apt, npm) en el Docker sin root de `campusia`. Ocurre fuera del contenedor sin red de la compilación y fuera del `MemoryMax` de la unidad.
