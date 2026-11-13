# Convenciones del repo

## Idioma y estilo

- Nombres de dominio, mensajes de interfaz, documentación y commits en castellano rioplatense. Identificadores de código en castellano cuando sean del dominio (`curso`, `inscripcion`, `universidad`) y en inglés cuando sean técnicos estándar.
- Sin comentarios en el código.
- Sin emojis.
- Commits chicos y descriptivos, en castellano. Sin trailers de coautoría ni menciones a herramientas de asistencia.
- La interfaz no lleva textos explicativos innecesarios: etiquetas cortas y claras.

## Estructura

| Carpeta | Contenido |
|---|---|
| `nucleo/` | Servicio en Rust (axum, tokio, sqlx con SQLite). Un solo binario: API, enrutador por subdominio, supervisor de contenedores, intermediario del modelo, envío de mails y archivos estáticos de la interfaz |
| `interfaz/` | Interfaz de la plataforma en React con Vite y TypeScript. Se compila a `interfaz/dist` y la sirve el núcleo |
| `plantilla-curso/` | Proyecto inicial de cada curso: Node 22, Hono, better-sqlite3, React con Vite, TypeScript |
| `sdk/` | Paquete `@campusia/sdk` que usan los cursos para verificar la identidad y llamar a la API de la plataforma |
| `pruebas/` | Pruebas de aceptación y de ataque de punta a punta, por fase |
| `contratos/` | Contrato de cada fase: rutas, formatos, permisos y criterios |
| `despliegue/` | Unidades de systemd, Caddyfile, scripts de instalación, respaldo y restauración |
| `handoffs/` | Historia del trabajo: `AAMMDD_HHMM_tema.md`. Solo se agregan archivos nuevos; los existentes no se borran ni se reescriben |
| `prototipo/` | Prototipo HTML de todas las pantallas. Es la referencia visual de la interfaz |

## Interfaz

La interfaz reproduce el prototipo `prototipo/campus.html`: la misma paleta (azul Austral `#001D9C`, `#1E4FD6`, grises neutros), la tipografía Inter, la barra blanca fina de 48 px, el login con código en 6 casillas, Mis cursos con tarjetas, los paneles de owner y administrador con pestañas y tablas, y los paneles laterales del curso (Editar, Inscriptos, Versiones).

## Configuración

Todo se configura por variables de entorno. En producción vienen de `/srv/campusia/config/campusia.env`. Nunca se escriben secretos en el repo. En desarrollo y en las pruebas:

- `PROVEEDOR_EMAIL=archivo` escribe los mails en un archivo en lugar de enviarlos.
- Turnstile usa las claves de prueba públicas de Cloudflare (`1x00000000000000000000AA` y `1x0000000000000000000000000000000AA`).
- `DOMINIO_BASE=localhost` y los subdominios se prueban con el encabezado `Host`.

## Cómo correr

Cada fase documenta en su contrato y en su handoff cómo compilar, levantar y probar. El comando de pruebas de punta a punta de cada fase tiene que poder correrse desde cero, sin pasos manuales.
