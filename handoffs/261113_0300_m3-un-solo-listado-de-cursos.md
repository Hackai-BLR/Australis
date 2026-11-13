# M3: un solo listado de cursos

_Creado: 2026-11-13 03:00. Tarea M3 de la fase 0 de `docs/plan.md`. Se apoya en M2 (`feat/m2-sign-in`), que todavía no está en main._

## Qué se hizo

- Núcleo: dos tablas nuevas (`7001_campus_con_modulos.sql`). `campus_modulos` guarda cada campus con módulos de Australis, con su universidad y su creador. `inscripciones_modulos` es el registro de quién está inscripto, con rol y suspensión.
- `nucleo/src/cursos/modulos.rs`:
  - `POST /api/cursos-modulos` crea el campus en Australis firmando como la persona (el mismo encabezado de `contratos/identidad-australis.md`) y lo registra en la universidad de quien lo crea. Solo profesores con universidad. Sin `AUSTRALIS_URL` responde 503 y no queda nada.
  - `POST /api/cursos-modulos/{id}/inscriptos` valida que los mails sean de la universidad, los manda a la importación de alumnos de Australis (vista previa y confirmación) y recién después los registra en el núcleo.
  - `POST /api/cursos-modulos/{id}/sincronizar` lee los miembros del campus en Australis y los vuelca en el núcleo: altas, cambios de rol y suspensiones. Nunca borra.
  - `GET /api/cursos-modulos/{id}/inscriptos` lista los inscriptos para quien está en el campus.
- `GET /api/mis-cursos` devuelve los dos tipos: cada curso lleva `tipo` (`libre` o `modulos`). Los campus con módulos traen `campus_externo`. Un alumno suspendido no ve el campus.
- Interfaz: el modal de crear curso ofrece "Curso libre" o "Campus con módulos". Mis cursos muestra los dos y las tarjetas de campus abren `campus.<dominio>/campuses/<id>`.

## Pruebas

`nucleo/src/cursos/modulos/pruebas.rs`, con un Australis falso: creación y firma, listado de los dos tipos, permisos, inscripción del núcleo hacia Australis, sincronización de Australis hacia el núcleo, otra universidad, alumno sin permisos.

## Desvíos

- `nucleo/src/servidor.rs` (las rutas nuevas) y `nucleo/migraciones/7001_campus_con_modulos.sql`: la tarea no los nombra pero no se puede terminar sin ellos.
- `backend/crates/modules/campus/src/lib.rs` no cambió: el backend de Australis no puede llamar al núcleo (no tiene cliente HTTP y no se agregan dependencias), así que el núcleo es quien llama a Australis.

## Pendiente

- De Australis al núcleo la inscripción es a pedido (`sincronizar`): lo que se importa directamente en Australis llega cuando alguien sincroniza. Hace falta un cliente HTTP en el backend de Australis (cambio de una pasada del `Cargo.toml`) para que la importación escriba en el núcleo al confirmar.
- La secretaría de Australis (dueño o administrador de cualquier universidad) ve todos los campus del backend: el aislamiento por universidad en Australis queda para una tarea posterior.
- Los campus con módulos todavía no entran en la baja, la suspensión ni el archivado de cursos.
