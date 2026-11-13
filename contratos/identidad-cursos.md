# Contrato fijo: identidad y entorno de los cursos

Lo usan el núcleo (que firma y lanza los contenedores) y la plantilla de curso y el SDK (que verifican). No se cambia sin actualizar ambos lados.

## Encabezado de identidad

- Nombre: `X-Campus-Identidad`.
- Valor: `<carga>.<firma>`, donde `carga` es JSON en UTF-8 codificado en base64url sin relleno y `firma` es la firma Ed25519 de los bytes ASCII de `<carga>` (la cadena base64url), también en base64url sin relleno.
- Carga JSON: `{"v":1,"curso":"<id del curso>","usuario":"<id>","email":"<mail>","nombre":"<nombre>","rol":"dueño"|"profesor"|"alumno","emitido":<epoch s>,"vence":<epoch s>}`. Vigencia máxima 120 segundos.
- El curso rechaza: firma inválida, `v` distinto de 1, `curso` distinto del suyo, vencido, emitido en el futuro con más de 30 segundos de tolerancia, o encabezado ausente.
- El núcleo borra cualquier `X-Campus-Identidad` y cualquier `Cookie` que mande el navegador antes de reenviar.

## Variables de entorno del contenedor de un curso

| Variable | Contenido |
|---|---|
| `PORT` | Puerto donde escucha el curso dentro del contenedor (3000) |
| `CAMPUSIA_CURSO` | Id del curso |
| `CAMPUSIA_CLAVE_PUBLICA` | Clave pública Ed25519 del núcleo, 32 bytes en base64url sin relleno |
| `CAMPUSIA_API` | URL base de la API de la plataforma accesible desde el contenedor |
| `CAMPUSIA_TOKEN_CURSO` | Token del curso para la API de la plataforma, con permisos solo sobre ese curso |
| `CAMPUSIA_DATOS` | Carpeta persistente del curso (`/datos`), donde vive su SQLite |

## API de la plataforma para los cursos

Con `Authorization: Bearer $CAMPUSIA_TOKEN_CURSO`:
- `GET /api/curso/yo`: datos del curso (id, nombre, período).
- `GET /api/curso/inscriptos`: lista de inscriptos (id, nombre, email, rol).
Las fases siguientes agregan archivos, entregas y notas bajo `/api/curso/`.
