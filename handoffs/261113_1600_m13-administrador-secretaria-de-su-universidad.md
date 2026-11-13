# M13: el administrador es secretaría de su propia universidad

_Creado: 2026-11-13 16:00. Tarea M13 de la fase 0 de `docs/plan.md`._

## Qué se hizo

- `nucleo/src/identidad.rs` y `enrutador.rs`: la identidad firmada para Australis lleva `universidad` y `administrador` (solo `true` para quien administra su universidad y no es el owner). Ya no se oculta al administrador como alumno.
- `backend/crates/core`: migración `0010_core_university_scope.sql` (universidad y marca de administrador en `core_users`, universidad en `core_campuses`). `auth.rs` lee la carga y sincroniza la universidad en cada pedido; `directory.rs` copia la universidad del creador al campus y limita `campuses_for_user` y `list_users_for`; `access.rs` da `Manage` al administrador solo en los campus de su universidad y el owner lo conserva en todos.
- `backend/crates/modules/auth/src/lib.rs` (fuera de lo asignado, mínimo): la lista de personas y las acciones sobre una persona respetan la universidad del administrador.
- `contratos/identidad-australis.md` actualizado.
- `pruebas/australis/checkpoint-b/`: los pasos 5 y 6 dejan de ser fallos esperados; se agregaron pruebas de ataque de un administrador de otra universidad (API e interfaz).

## Pruebas

`backend/crates/server/tests/identity.rs` (administrador propio, owner, otra universidad, personas, campus creado, pérdida de derechos) y pruebas de `nucleo/src/enrutador.rs`.

## Pendiente

- Las pruebas de `pruebas/australis/checkpoint-b/` necesitan la pila local completa y no se corrieron en esta tarea.
- Los campus que ya existían quedan sin universidad: solo el owner los administra hasta que se les asigne una.
