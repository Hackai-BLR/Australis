# M11: vistas de administrador y owner de los campus con módulos

_Creado: 2026-11-13 14:00. Tarea M11 de la fase 0 de `docs/plan.md`. Termina el pull request #33 y se apoya en el trabajo sin fusionar de M10 (`feat/m10-enrolments-on-every-change`)._

## Qué se hizo

- Se fusionó `origin/fix/cb-campus` sobre M10. Los conflictos estaban en `nucleo/src/cursos/modulos.rs` y `nucleo/src/cursos/modulos/pruebas.rs`: se mantuvo el cerrojo por campus y la firma con `Option<&str>` de M10, y la auditoría solo cuando la sincronización cambió algo, de #33.
- `nucleo/src/admin.rs` y `nucleo/src/cursos/modulos.rs`: un owner sin universidad ya no recibe 403 ni 404. `GET /api/admin/cursos` sin `?universidad=` lista los cursos libres y los campus con módulos de todas las universidades; con `?universidad=` se queda en esa. `GET /api/cursos-modulos/{id}/inscriptos` lo puede leer el owner de cualquier campus. Un profesor sin marca de administrador sigue con 403.

## Pruebas

`nucleo/src/cursos/modulos/pruebas.rs`: `el_owner_sin_universidad_ve_los_campus_con_modulos_de_todas_las_universidades`, además de las de #33 (administrador, conteos, sin llamada a Australis cuando la universidad no tiene campus con módulos).

## Pendiente

- `cargo fmt` y `cargo clippy -D warnings` ya fallaban en `nucleo/` antes de este cambio; no se tocaron.
- `interfaz/src/Admin.tsx` no cambió en M11: el selector de universidad del owner sigue mandando `?universidad=`.
