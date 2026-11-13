# Integración: fase 3 y tramo inhabilitar sobre main

_Creado: 2026-11-10 16:18. Sigue a `261110_1305_fase-3.md`, `261110_1413_fase-3-correccion-413.md`, `261110_1355_tramo-inhabilitar.md` y `261110_1132_tramo-reautenticacion.md`. Rama `integracion`, desde `origin/main` (`820ab8b`: fases 1, 2 y 4 y tramo de reautenticación por sesión)._

## Qué se hizo

1. `git merge --no-ff origin/fase-3` → "Unión de la fase 3: agente, prueba, publicar y versiones".
2. `git merge --no-ff origin/tramo-inhabilitar` → "Unión del tramo inhabilitar".
3. Controles de inhabilitar en las rutas de la fase 3 (pendiente anotado en el handoff del tramo).
4. Corrección del riesgo de tiempo del pedido de código tras reiniciar el núcleo.
5. Dos ajustes de pruebas desactualizadas por cambios de otras ramas (detalle abajo).

Se conserva `REAUTENTICACION_MODO=sesion` como predeterminado: no se tocó `config.rs`, `auth.rs` ni `login.rs` en esa parte, y la interfaz sigue montando el modal solo en modo `codigo`.

## Conflictos resueltos

### Fase 3 sobre main

| Archivo | Resolución |
|---|---|
| `nucleo/src/config.rs` | Campos y lectura de la fase 4 (`raiz_archivos` … `tiempo_espera_cuerpo_seg`), `ModoReautenticacion` del tramo de reautenticación y `agente: ConfigAgente` de la fase 3, todos juntos |
| `nucleo/src/main.rs` | Unión de módulos: `archivos`, `datos`, `endurecimiento`, `estado`, `registros` (fase 4) con `agente`, `agente_config`, `espacios`, `modelo`, `prueba`, `proxy_salida`, `publicar`, `repo` (fase 3). El arranque combinado (servidor con tiempos de la fase 4, espacios e intermediario de la fase 3) se fusionó solo |
| `nucleo/src/servidor.rs` | `use` con los módulos de las dos ramas. Rutas de la fase 3 y de la fase 4 juntas; capa `cerrar_si_queda_cuerpo` (corrección del 413) sobre el filtro |
| `nucleo/Cargo.toml`, `Cargo.lock` | Se queda la versión de main (ya tenía `http-body = "1"`, además de `hyper`, `hyper-util`, `tower-service`) |
| `despliegue/campusia-nucleo.service` | `RAIZ_ARCHIVOS`, `DIR_RESPALDOS` y `RAIZ_ESPACIOS` |
| `despliegue/campusia.env.ejemplo` | Variables de la fase 4 y de la fase 3, una tras otra |
| `despliegue/instalar.sh` | `mkdir`, `chmod 0700` y `chown` sobre `CURSOS`, `ARCHIVOS`, `RESPALDOS` y `ESPACIOS` |

### Tramo inhabilitar sobre lo anterior

| Archivo | Resolución |
|---|---|
| `nucleo/src/main.rs`, `servidor.rs` | Módulos `inhabilitar` y `roles` y sus rutas junto a los de la fase 3 |
| `interfaz/src/estilos.css` | Estilos del chat y de errores de publicación (fase 3) y de acciones de inhabilitar |
| `interfaz/src/Curso.tsx` | Se parte de la versión de la fase 3 (agente, espacio, publicar, versiones) y se agrega lo del tramo: pastilla y aviso "Curso archivado" sin iframe, archivar y desarchivar desde el menú, `Editar` y `Publicar` ocultos si está archivado, `PanelAgente` no se monta, el modo Prueba no enciende el espacio (`enPrueba` exige no archivado) y al archivar se vuelve a Publicado. `setCargado(false)` del tramo pasa a `setCargado(null)` (en la fase 3 es la clave del iframe) |

### Migraciones

`0001`, `0002`, `3001_agente`, `4001_datos`, `4002_archivos_retirados`, `5001_inhabilitar` y la nueva `5002_envios_codigo`. No hay tablas ni columnas repetidas. En una base ya desplegada con `4001` y `4002`, sqlx 0.8 aplica `3001` igual (`Migrator::run` aplica toda migración no registrada, sin exigir orden; verificado en `sqlx-core-0.8.6/src/migrate/migrator.rs`).

## Decisiones

### Inhabilitar en la fase 3 (`2d34f08`)

- `agente::exigir_en_servicio`: `POST /api/cursos/{id}/espacio`, `/agente`, `/publicar` y `/versiones/{n}/volver` responden `409 curso_archivado` (curso archivado) o `409 universidad_deshabilitada`. Las lecturas (`GET` de agente, versiones, publicaciones, uso, espacio) siguen permitidas a los docentes, como el resto de las lecturas de un curso archivado.
- `prueba.rs`: el subdominio `<id>-prueba` llama a `inhabilitar::bloqueo_enrutador` (403 "Curso archivado" o "Curso no disponible", y 403 para una cuenta inhabilitada con sesión viva), igual que el enrutador de cursos.
- `modelo.rs`: los tokens de modelo (`cmt_`) y de curso del espacio (`cct_`) de un curso fuera de servicio dejan de servir.
- `espacios.rs`: `revisar_fuera_de_servicio` detiene los espacios de cursos archivados o de universidades deshabilitadas; corre en cada vuelta de la vigilancia de inactividad y apenas se archiva un curso o se deshabilita una universidad (junto con la del supervisor).
- Pruebas nuevas: `pruebas/tramo-inhabilitar/ataque/fase-3.spec.ts` (sin Docker).

### Tiempo del pedido de código tras reiniciar (`958b47c`)

Riesgo: la media de emisiones vivía en memoria; tras un reinicio era 0, así que el pedido de código de una cuenta suspendida respondía al instante mientras el de una activa tardaba lo que tarda el proveedor. Lo mismo con el 503: tras reiniciar con el proveedor caído, la suspendida recibía 200 y la activa 503.

- Migración `5002_envios_codigo.sql`: tabla de una fila con `media_seg`, `fallo` y `actualizado_en`.
- Cada emisión real actualiza la media en memoria y la guarda en segundo plano (para no sumar al tiempo de respuesta una escritura que el camino simulado no hace).
- Al arrancar, `login::cargar_envios` toma lo guardado. Sin nada guardado (instalación nueva) parte de `ESPERA_CODIGO_INICIAL_MS` (predeterminado 800 con Brevo, 10 con `archivo`, máximo 20000).
- Contrato: `contratos/tramo-inhabilitar.md` (secciones 3 y "Cambios"). Variable nueva en `despliegue/campusia.env.ejemplo`.
- Pruebas nuevas en `pruebas/tramo-inhabilitar/ataque/login-tiempo.spec.ts`: tras reiniciar, la suspendida tarda lo que una activa; tras reiniciar con el proveedor caído, recibe el mismo 503; un núcleo sin envíos guardados también espera.

## Pruebas cambiadas por cambios acordados en otras ramas

- `45274d6`: `tramo-inhabilitar/aceptacion/interfaz.spec.ts`, `aceptacion/interfaz-roles.spec.ts`, `ataque/reautenticacion.spec.ts`, `ataque/roles.spec.ts` y `ataque/sesiones.spec.ts` corren con `MODO_CODIGO`. El tramo se escribió antes del modo `sesion` predeterminado: esas pruebas comprueban el diálogo de reautenticación, el `403 reautenticacion_requerida` y las rutas de código de reautenticación, que en modo `sesion` no existen (404) o no se piden. Es el mismo criterio que usó el tramo de reautenticación con las pruebas del mecanismo de la fase 1. El resto del tramo corre en modo `sesion`.
- `41658f8`: `pruebas/fase-3/lib/imagen.ts`. La fase 4 hizo que `CAMPUSIA_CORRIDA` sea una carpeta (`comun/compilar.ts` y `fase-4/correr.sh`); la fase 3 lo usaba como identificador para la etiqueta de la imagen del espacio (`cia3espacio:/tmp/campusia-corrida-…`, inválida) y para su carpeta candado (el `mkdir` fallaba y cada archivo esperaba 26 min antes de fallar). `corrida()` ahora deriva un identificador válido del nombre de la carpeta.

## Resultado de las pruebas

Corrida completa desde cero sobre `41658f8` (código final; el handoff no cambia código):

| Parte | Resultado |
|---|---|
| `cargo test` del núcleo | 4/4 |
| Tramo inhabilitar (`pruebas/tramo-inhabilitar`, Playwright) | 78/78 (incluye las 5 de `login-tiempo` y las 2 de `fase-3.spec.ts`) |
| Tramo plantilla de curso y SDK | 162/162 (45 + 27 + 90) |
| Tramo resguardo (`estatico`, respaldo, rotación, Docker, ataque) | todas pasaron (352 controles) |
| Experimento del intermediario (`node --test`) | 52/52 |
| Fases 1 a 4 con Playwright (`bash pruebas/correr.sh`) | 454 passed, 1 skipped, 0 fallidas (30,2 min) |

- El skipped es `fase-3/real/modelo-real.spec.ts`, que solo corre con el modelo real (manual, como en la fase 3).
- En la corrida anterior de las fases (dentro de `fase-4/correr.sh`, con las construcciones Docker de la fase 3 en paralelo) falló una vez `fase-4/ataque/datos-permisos.spec.ts:65` en su `beforeAll`: "No llegó ningún mail a slopez@mail.austral.edu.ar" (el pedido de código respondió 200 y el mail no apareció en los 8 s de espera). Sola y en la misma secuencia de su worker pasó (14/14 y 24/24), y en la corrida completa siguiente de las fases pasó. No se encontró una causa determinista; queda anotada como intermitente bajo carga.
- Primera corrida, antes de los dos ajustes de pruebas: 13 fallas del tramo inhabilitar por el modo `sesion` y las pruebas de la fase 3 colgadas por `CAMPUSIA_CORRIDA` (ver arriba).

## Cómo se compila

```bash
. "$HOME/.cargo/env"
cargo build --release --manifest-path nucleo/Cargo.toml
pnpm --dir interfaz install && pnpm --dir interfaz run build
pnpm --dir sdk install && pnpm --dir sdk run build
rm -f plantilla-curso/vendor/campusia-sdk-*.tgz && pnpm --dir sdk pack --pack-destination plantilla-curso/vendor
```

## Cómo se prueba

```bash
bash pruebas/tramo-inhabilitar/correr.sh
```

Corre el tramo inhabilitar y después `pruebas/fase-4/correr.sh` (tramos de plantilla y SDK, resguardo y Playwright de las fases 1 a 4, incluida la fase 3 con Docker y el modelo falso). El experimento del intermediario no está en ese corredor; se corre con `bash pruebas/fase-3/correr.sh` (o solo esa parte, ver el script) y requiere Docker.

## Cómo se despliega

1. Compilar como arriba (release).
2. `despliegue/instalar.sh --binario nucleo/target/release/campusia-nucleo --interfaz interfaz/dist --plantilla plantilla-curso --sdk sdk --espacio despliegue/espacio-trabajo` (crea `/srv/campusia/archivos`, `respaldos` y `espacios` con `0700`, copia la imagen del espacio a `/srv/campusia/plataforma/espacio-trabajo/`).
3. Completar en `/srv/campusia/config/campusia.env` lo que falte respecto de `despliegue/campusia.env.ejemplo`: variables de la fase 3 (`PROVEEDOR_MODELO` y su credencial, `MODELO_AGENTE`, `ESPACIO_IMAGEN`, `PUERTO_ESPACIOS`, `PUERTO_PROXY_SALIDA`, `SALIDA_PERMITIDA`, límites del espacio), `REAUTENTICACION_MODO=sesion` (o sin definir) y, opcional, `ESPERA_CODIGO_INICIAL_MS`.
4. Como el usuario del servicio: `bash despliegue/construir-espacio.sh --etiqueta campusia-espacio:1 --espacio /srv/campusia/plataforma/espacio-trabajo --plantilla /srv/campusia/plataforma/plantilla-curso` (sin sudo; necesita red a los registros de imágenes y npm).
5. Reiniciar `campusia-nucleo.service`. Al arrancar aplica `3001_agente`, `5001_inhabilitar` y `5002_envios_codigo` (también con `campusia-nucleo migrar`).

## Pendientes

- Los de `261110_1305_fase-3.md` (uso del intermediario desde el código del curso no cuenta como actividad, sin cuotas por minuto, sin limpieza de imágenes viejas, `CAMPUSIA_TOKEN_CURSO` en el entorno de `pnpm dev`) y los de `261110_1355_tramo-inhabilitar.md` salvo los dos resueltos acá (unión con la fase 3 y tiempo tras reinicio).
- Un agente que ya estaba trabajando cuando se archiva el curso no se corta: se queda sin modelo (token rechazado) y el espacio se detiene en la siguiente revisión.
- `/srv/campusia/espacios` no entra en el respaldo de la fase 4; son copias de trabajo regenerables desde la rama `prueba` del repo del curso, salvo los datos de prueba del espacio.
- Las pruebas de interfaz del tramo inhabilitar con los diálogos de confirmación corren solo en modo `codigo`; en modo `sesion` la confirmación se cubre por API.
