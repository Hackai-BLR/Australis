# Contrato fijo: identidad de Australis

Lo usan el núcleo (que firma y reenvía) y el backend de Australis (que verifica). No se cambia sin actualizar ambos lados. Es el mismo mecanismo de `identidad-cursos.md` con un destinatario fijo.

## Dirección

- Australis se sirve en `campus.<DOMINIO_BASE>` (en producción `campus.campusia.tech`). El nombre `campus` está reservado: ningún curso lo recibe.
- El núcleo clasifica ese host como Australis y reenvía todo (`/api/*` y la interfaz) a `AUSTRALIS_URL` (variable del núcleo, por ejemplo `http://127.0.0.1:8081`). Sin esa variable responde 503 con reintento.
- La cookie de sesión del núcleo vale para todo el dominio base, así que llega a `campus.*`.

## Lo que hace el núcleo

1. Sin sesión: `/api/*` responde 401 JSON; el resto, una página con el enlace a Campus IA.
2. Cuenta inhabilitada (suspendida o de una universidad deshabilitada): 403 y no se reenvía nada.
3. Pedidos que modifican: el `Origin` tiene que ser exactamente el origen de `campus.*`; si no, 403.
4. Borra `Cookie`, `Authorization`, `Host` y todo encabezado `x-campus-*` que mande el navegador, agrega `X-Campus-Identidad` y descarta `Set-Cookie` de la respuesta.

## Encabezado

- Nombre `X-Campus-Identidad`, valor `<carga>.<firma>`, igual que en `identidad-cursos.md` (carga JSON en base64url sin relleno, firma Ed25519 de los bytes ASCII de `<carga>`).
- Carga: `{"v":1,"curso":"australis","usuario":"<id>","email":"<mail>","nombre":"<nombre>","rol":"dueño"|"profesor"|"alumno","administrador":true|false,"emitido":<epoch s>,"vence":<epoch s>}`.
- `rol` es `dueño` para el owner, `profesor` para quien tiene la marca de profesor y `alumno` para el resto. `administrador` es aparte porque un administrador de universidad puede no tener la marca de profesor.
- Vigencia máxima 120 segundos (`IDENTIDAD_VIGENCIA_SEG`, 60 por defecto).

## Lo que hace Australis

- `AUTH_MODE=header` y `IDENTITY_PUBLIC_KEY` (clave pública del núcleo, 32 bytes en base64url sin relleno; el núcleo la publica con `Identidad::publica`). Sin la clave, el backend no arranca en ese modo.
- Rechaza con 401: encabezado ausente, firma inválida, `v` distinto de 1, `curso` distinto de `australis`, vencido, emitido más de 30 segundos en el futuro o con vigencia mayor a 120 segundos.
- Rol en Australis: `dueño` o `administrador` es secretaría; `profesor`, profesor; todo lo demás, alumno. El rol y el nombre se actualizan en cada pedido si cambiaron en el núcleo.
- La cuenta se crea la primera vez que aparece (sin contraseña). Una cuenta invitada por la importación de alumnos se activa. Una cuenta suspendida en Australis responde 403.
- En este modo no existen `POST /api/auth/login`, `/api/auth/invites/*`, `POST /api/users` ni `POST /api/users/{id}/invite` (404), y la cookie `australis_session` no autentica a nadie.
- `GET /api/auth/mode` responde `{"mode":"password"|"header"}`. Con `AUTH_MODE=password` (por defecto, para desarrollo local y pruebas) el encabezado se ignora.
- El backend de Australis tiene que escuchar solo en la interfaz local: en modo `header` confía en el encabezado firmado y en nada más.
