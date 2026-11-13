# M2: un solo ingreso a Australis

_Creado: 2026-11-13 02:00. Tarea M2 de la fase 0 de `docs/plan.md`._

## Qué se hizo

- Núcleo: el host `campus.<dominio base>` es Australis (`servidor.rs`). `enrutador.rs` exige sesión, rechaza cuentas inhabilitadas y pedidos que modifican desde otro origen, borra cookies y encabezados `x-campus-*`, agrega `X-Campus-Identidad` firmado con el rol de la plataforma y reenvía a `AUSTRALIS_URL`. `identidad.rs` firma la carga de Australis (`curso` fijo `australis`, `administrador` aparte).
- Backend de Australis: `AUTH_MODE` (`password` o `header`) e `IDENTITY_PUBLIC_KEY`. En modo `header` el extractor `CurrentUser` verifica el encabezado, crea la cuenta la primera vez, actualiza rol y nombre, y rechaza las cuentas suspendidas. Las rutas de contraseña e invitaciones responden 404 y existe `GET /api/auth/mode`.
- Interfaz de Australis: sin sesión y en modo `header`, `RequireAuth` lleva al navegador a la plataforma en lugar de mostrar el login.
- Contrato nuevo: `contratos/identidad-australis.md`.

## Pruebas

- `backend/crates/server/tests/identity.rs` y las pruebas unitarias de `auth.rs` y `config.rs` (backend).
- `nucleo/src/enrutador.rs`, módulo `pruebas`: host reservado, rol firmado, reenvío sin cookies con la identidad verificable, falla del destino.
- `frontend/src/shared/auth/guards.test.tsx`.

## Desvíos

- Archivos fuera de lo que M2 posee: `nucleo/src/config.rs` (variable `AUSTRALIS_URL`), `nucleo/src/servidor.rs` (clasificar y despachar el host de Australis), `backend/Cargo.toml`, `Cargo.lock` y los `Cargo.toml` de `core` y `server` (`ed25519-dalek` y `base64`).

## Pendiente

- M1 tiene que definir `AUSTRALIS_URL`, `AUTH_MODE=header` e `IDENTITY_PUBLIC_KEY` del servicio en el servidor, el registro DNS y el certificado de `campus.campusia.tech`, y servir la interfaz de Australis detrás de esa dirección.
- La clave pública se lee de `Identidad::publica`; falta un comando del núcleo que la imprima para configurarla.
- Prueba de punta a punta con Playwright (núcleo y Australis juntos): la cubre M8 o un tramo posterior.
