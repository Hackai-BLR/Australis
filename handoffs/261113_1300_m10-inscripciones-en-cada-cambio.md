# M10: las inscripciones llegan al núcleo en cada cambio

_Creado: 2026-11-13 13:00. Tarea M10 de la fase 0 de `docs/plan.md`. Se apoya en el pull request #34 (la importación confirmada ya sincronizaba)._

## Qué se hizo

- `nucleo/src/enrutador.rs`: además de confirmar una importación, ahora sincronizan las inscripciones del núcleo, en el mismo pedido, suspender, reactivar, reenviar la invitación y agregar un docente invitado (`POST /api/campuses/{id}/members/{uid}/suspend|reactivate|invite` y `POST /api/campuses/{id}/teachers`). Solo si Australis respondió con éxito.
- Si la sincronización falla, el pedido responde 502 con `{"error": <mensaje en español>, "codigo": "sincronizacion_fallida"}` en lugar de la respuesta de Australis, así la pantalla lo muestra. El cambio ya quedó hecho en Australis; sincronizar a mano (`POST /api/cursos-modulos/{id}/sincronizar`) lo reintenta.
- `nucleo/src/cursos/modulos.rs`: `sincronizar_campus_externo` devuelve el resultado en vez de tragarse el error.

## Pruebas

`nucleo/src/cursos/modulos/pruebas.rs`: suspender y reactivar, docente invitado, reenvío de invitación y la falla visible, con el Australis falso ampliado.

## Desvíos

- `nucleo/src/enrutador.rs` no está en lo que M10 posee; no se puede reenviar y sincronizar en el mismo pedido sin tocarlo (cambio mínimo).
- `backend/crates/modules/roster/src/**` no cambió: el backend de Australis no llama al núcleo.

## Pendiente

- Un campus de otra universidad o un docente invitado de otro dominio queda fuera de la sincronización, como antes.
- La pantalla de Australis muestra el mensaje tal cual; no distingue que el cambio sí se hizo.
- `cargo fmt` y `cargo clippy -D warnings` ya fallaban en `nucleo/` antes de este cambio; no se tocaron.
