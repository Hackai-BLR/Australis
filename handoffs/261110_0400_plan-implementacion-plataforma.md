# Plan de implementación de la plataforma Campus IA

_Creado: 2026-11-10 04:00. Primer handoff del repo. Los handoffs siguientes se agregan como archivos nuevos `handoffs/AAMMDD_HHMM_tema.md`; los existentes no se borran ni se reescriben: si algo queda obsoleto se marca con una nota fechada y se agrega lo nuevo debajo._

## 1. Qué es

- La plataforma es propia y fija: identidad, roles, inscripciones, API con permisos, versiones, publicación y la barra.
- Cada curso lo construye su profesor hablando con un agente, en código libre, en su propio subdominio, aislado.
- El prototipo de todas las pantallas está en `prototipo/campus.html` y es la referencia visual: login con código, Mis cursos, curso con barra (Editar, Inscriptos, Versiones, Publicar), Crear curso, Unirme con código, paneles de administrador (Personas, Cursos, Configuración, Actividad) y de owner (Universidades, Uso y proveedores).

## 2. Roles

Plataforma y universidad:

| Rol | Cómo se obtiene | Puede |
|---|---|---|
| Owner | Por línea de comandos en el servidor | Crear universidades y sus administradores; ver uso y costos; elegir proveedores |
| Administrador | Lo invita el owner | Marcar profesores; ver cursos y personas de su universidad; dominios habilitados; límite de uso del agente; auditoría |
| Profesor | Marca que pone el administrador | Crear cursos |
| Cuenta común | Entrar con un mail de un dominio habilitado | Ver los cursos donde está inscripto |

Curso:

| Rol | Puede |
|---|---|
| Dueño (quien lo creó) | Todo lo del profesor; agregar y quitar profesores; transferir el curso |
| Profesor | Editar con el agente, publicar, volver a una versión, inscribir y quitar alumnos |
| Alumno | Ver el curso publicado, entregar, rendir |

Reglas:
- Solo puede ser profesor de un curso alguien con la marca de profesor.
- El rol en cada curso depende solo de la inscripción en ese curso.
- Solo el dueño agrega o quita profesores; dueño y profesores inscriben y quitan alumnos; al dueño solo lo saca una transferencia.
- Todo lo que hace la interfaz se puede hacer por la API con los mismos permisos.

## 3. Login

- Solo código por email: 6 dígitos, vence a los 10 minutos, se anula a los 5 intentos. Sin contraseñas.
- La cuenta se crea sola la primera vez que entra un mail de un dominio habilitado.
- Límites de envío por mail y por IP; Turnstile ante intentos sospechosos; nunca se bloquean cuentas; ante fallas se niega el acceso.
- Sesión en cookie `HttpOnly`, `Secure`, `SameSite=Lax`, revocable, validada contra la base; se renueva en cada login. 30 días para alumnos y profesores, 12 horas para administradores y owners.
- Las acciones sensibles (cambiar roles, borrar) piden un código nuevo.
- Mensajes que no revelan si una cuenta existe.
- Auditoría de logins, cambios de rol, inscripciones y publicaciones.
- Envío con Brevo desde `no-responder@campusia.tech`, detrás del contrato `ProveedorDeEmail` (Resend como alternativa; en desarrollo, un proveedor que escribe a un archivo o a la consola).

## 4. Arquitectura

```
Cloudflare (DNS, proxy, Turnstile)
   │  certificado de origen de 15 años
Caddy (HTTPS), solo acepta tráfico de Cloudflare
   │
Núcleo (Rust)
   ├─ identidad, sesiones, roles, inscripciones, auditoría
   ├─ interfaz: login, Mis cursos, barra, paneles de owner y administrador
   ├─ API de plataforma con permisos por token
   ├─ servicios comunes: archivos, registro de entregas, registro de notas
   ├─ enrutador por subdominio que enciende los cursos apagados
   ├─ supervisor de contenedores
   ├─ intermediario del modelo: ProveedorDeModelo (suscripción o API)
   └─ ProveedorDeEmail (Brevo o Resend)
        │
   ┌────┴──────────────────────┬───────────────────────────────────┐
 curso publicado (Node)       espacio de trabajo del profesor
 contenedor sin root          contenedor con Claude Code y el repo del curso
 se apaga sin visitas         sirve la versión de prueba en vivo
```

Direcciones:
- `campusia.tech`: login, Mis cursos y paneles.
- `<curso>.campusia.tech`: la barra con el curso en un iframe.
- `<curso>-curso.campusia.tech`: el contenido del curso publicado.
- `<curso>-prueba.campusia.tech`: la versión de prueba, solo para sus profesores.

Aislamiento plataforma y cursos:
- El núcleo borra las cookies de cada petición que reenvía a un curso y agrega un encabezado firmado con el usuario y su rol.
- La cookie de sesión no es legible por scripts y la sesión se valida contra la base; las cookies que un curso intente plantar no sirven.
- Los formularios sensibles llevan protección contra peticiones falsificadas.

Datos de la plataforma: entregas, notas y archivos en registros que solo se agregan, con la hora de la plataforma. El código del curso no los puede alterar.

Credencial del modelo:
- Nunca entra a un contenedor. Cada curso tiene un token propio que solo sirve contra el intermediario, que mide el uso por curso y corta al llegar al límite.
- En desarrollo, token de suscripción del equipo (`CLAUDE_CODE_OAUTH_TOKEN` de `claude setup-token`); en producción, clave de API.

Repositorios:
- La plataforma: `ORGANIZACION/campusia` en GitHub.
- Los cursos: repos de git en el servidor (`/srv/campusia/cursos/<id>`), manejados por el núcleo. Rama `prueba` para el agente, `main` publicada, versiones como etiquetas `vN`. Volver atrás es desplegar una etiqueta anterior como versión nueva.
- Cada curso usa una versión fija del SDK.

Límites del agente: solo su repo; sin internet salvo el intermediario y npm; límites de CPU, RAM y disco; `CLAUDE.md` y hooks; las operaciones destructivas piden confirmación del profesor.

Los cursos sin visitas se apagan y se despiertan con la primera petición.

## 5. Tecnologías

| Parte | Elección |
|---|---|
| Servidor | Hostinger: 2 núcleos, 8 GB, 100 GB NVMe, Debian 13, 4 GB de swap |
| Borde | Cloudflare: proxy, certificado de origen, Turnstile, reenvío de correo |
| HTTPS | Caddy |
| Núcleo | Rust: axum, tokio, sqlx, SQLite |
| Interfaz de plataforma | React con Vite, a partir de `prototipo/campus.html` |
| Cursos | TypeScript: Node 22, Hono, better-sqlite3, React con Vite, pnpm con almacén compartido |
| Contenedores | Podman sin root con límites (Docker en desarrollo) |
| Agente | Claude Code (`claude -p`) |
| Mails | Brevo |
| Copias de seguridad | Litestream y paquetes de git hacia R2 |

## 6. Fases

| Fase | Contenido | Terminada cuando |
|---|---|---|
| 0. Servidor | Usuario propio sin privilegios; root solo con clave; firewall solo Cloudflare en 443 y SSH; actualizaciones automáticas; swap; Podman; Caddy con certificado de origen; SSL Full (strict); remitente de Brevo; Claude Code para el usuario del servicio | `https://campusia.tech` responde con candado a través de Cloudflare, el 443 rechaza accesos directos, llega un mail de prueba sin ir a spam, Claude responde desde el usuario del servicio |
| 1. Identidad | Núcleo en Rust; login con código; cuentas automáticas; roles; Mis cursos; barra; paneles de owner y administrador; API de usuarios, roles y dominios; auditoría; Turnstile | Cada rol ve lo suyo y las pruebas de permisos, incluidos los intentos de saltarlos, dan lo esperado |
| 2. Cursos | Plantilla de curso y SDK; crear curso; inscripciones por interfaz y por API (mails, listado del SIU, código); enrutador por subdominio; apagado y encendido | Un profesor crea un curso, inscribe alumnos, el alumno lo ve en su subdominio, el curso se apaga solo y se despierta con una visita |
| 3. Agente | Intermediario del modelo; espacio de trabajo; chat en el panel Editar; prueba; publicar; versiones; volver atrás; límites por curso | Se pide un cambio, se ve en prueba, se publica, se vuelve atrás; el agente no logra leer otro curso, ni el token real, ni salir a internet |
| 4. Datos y resguardo | Archivos; registro de entregas y notas; copias de seguridad; restauración; pruebas de ataque | Un curso no puede alterar una entrega registrada y la restauración funciona |

Pruebas de aceptación: comprueban que lo que tiene que funcionar funcione como lo usaría una persona. Pruebas de ataque: comprueban que lo prohibido falle.

## 7. Cómo se ejecuta

- La fase 0 la hace el orquestador directamente en el servidor.
- Las fases 1 a 4 las implementan workflows que corren sesiones de Claude Code en la máquina `n` (otra cuenta), en `~/projects/campusia`, con Docker local y datos de prueba. Cada workflow: un agente escribe el contrato (rutas, formatos, permisos, pruebas de aceptación y de ataque); dos o tres agentes implementan en paralelo por módulo; un verificador corre todas las pruebas y el workflow para solo cuando pasan.
- Cada workflow deja su handoff en `handoffs/` al terminar.
- El orquestador revisa, despliega al servidor y verifica en producción.
- Commits chicos, sin rastros de IA (sin trailers de coautoría ni menciones).

## 8. Credenciales

- En la máquina del orquestador, `~/.config/campusia/` (`cloudflare-token`, `brevo-key`, `claude-oauth-token`), solo legibles por su usuario.
- En el servidor van a archivos de entorno del servicio, solo legibles por su usuario. Nunca a contenedores ni al repo.
- Los workflows de desarrollo no reciben ningún secreto real.
- `n` accede al repo con una deploy key propia con escritura solo sobre `campusia`.

## 9. Estado de dependencias externas (2026-11-10)

- Servidor `203.0.113.10` (Debian 13) con acceso por clave.
- `campusia.tech` con servidores de Cloudflare, zona activa; `campusia.tech` y `*.campusia.tech` apuntan al servidor con proxy.
- Reenvío de `hola@campusia.tech` activo.
- Brevo con clave de API y dominio `campusia.tech` autenticado (DKIM, DMARC, SPF).
- Token de Claude de larga duración probado en el servidor.
- Pendientes para más adelante: bucket de R2 (fase 4), clave de API de Anthropic para producción, casilla de la Austral para probar entregabilidad.
