# Fase 1: identidad, roles y paneles

_Creado: 2026-11-10 05:16. Sigue a `261110_0400_plan-implementacion-plataforma.md`. Contrato: `contratos/fase-1.md`._

## Qué se hizo

- **Núcleo** (`nucleo/`): binario `campusia-nucleo` en Rust (axum 0.8, tokio, sqlx 0.8 con SQLite, reqwest con rustls). Migración única `nucleo/migraciones/0001_inicial.sql` embebida. Subcomandos `migrar`, `sembrar <archivo.json>` (solo `ENTORNO=desarrollo`) y `crear-owner <email>`.
  - Login solo con código por mail: 6 dígitos de CSPRNG, vence a los 10 minutos, se anula a los 5 fallos, se guarda solo su huella HMAC-SHA256. Límites por mail (3 cada 15 minutos) y por IP (20), Turnstile a partir de 5 pedidos o fallos por IP, verificado contra `siteverify`; si Turnstile o el envío fallan se niega con 503. Respuestas idénticas para cuentas existentes, inexistentes y de dominios no habilitados.
  - Cuentas automáticas en la universidad del dominio; cuentas pendientes por invitación.
  - Sesiones en cookie `campusia_sesion` (`HttpOnly`, `SameSite=Lax`, `Domain=DOMINIO_BASE`, `Secure` salvo desarrollo), validadas contra la base en cada petición, 30 días o 12 horas según el rol, logout y "cerrar las demás sesiones".
  - Control de `Origin` exacto más `X-Campusia: 1` en todo lo que modifica sin Bearer. Sin CORS. `Cache-Control: no-store` en la API.
  - Reautenticación por sesión, con código propio atado a la sesión, para marcar profesores, invitar, quitar dominios, crear universidades y crear tokens.
  - Tokens personales `cia_...` con permisos `cursos:leer`, `admin:leer`, `admin:escribir`, `owner:leer`, `owner:escribir`, limitados además por el rol actual.
  - API de administrador (solo su universidad) y de owner según el contrato. Auditoría de solo agregado con triggers.
  - `ProveedorDeEmail` con implementaciones `archivo` y `brevo`.
  - Enrutamiento por host: base y `<id>.base` sirven API e interfaz; `<id>-curso.base` sirve la página provisoria "Curso en preparación" solo a inscriptos; `<id>-prueba.base` y hosts ajenos dan 404; `/salud` en cualquier host.
- **Interfaz** (`interfaz/`): React 18 con Vite 6 y TypeScript, a partir de `prototipo/campus.html`. Login con 6 casillas (pegar, avance, reenviar, otro mail) y Turnstile cuando el núcleo lo pide; Mis cursos con tarjetas y estado vacío; barra del curso de 48 px con selector, menú de perfil y botones de profesor (paneles vacíos hasta las fases siguientes); panel de administrador (Personas, Cursos, Configuración, Actividad); panel de owner (Universidades, Uso y proveedores); modal de reautenticación que reintenta la acción; tokens personales y "cerrar las demás sesiones" desde el menú de perfil.
- **Despliegue** (`despliegue/`): `campusia-nucleo.service`, `Caddyfile`, `campusia.env.ejemplo` con marcadores y `instalar.sh` idempotente.
- **Contrato y pruebas**: `contratos/fase-1.md` y `pruebas/` (Playwright, ayudantes en `pruebas/comun/`, datos en `pruebas/fase-1/datos.json`).

## Cómo se compila

```bash
. "$HOME/.cargo/env"
cargo build --manifest-path nucleo/Cargo.toml                  # nucleo/target/debug/campusia-nucleo
pnpm --dir interfaz install && pnpm --dir interfaz run build   # interfaz/dist
```

Para producción: `cargo build --release --manifest-path nucleo/Cargo.toml`.

## Cómo se levanta en desarrollo

```bash
export DATABASE_URL=sqlite:///tmp/campusia.db DOMINIO_BASE=campusia.prueba ENTORNO=desarrollo \
  PROVEEDOR_EMAIL=archivo ARCHIVO_EMAIL=/tmp/mails.jsonl SESSION_SECRET=$(openssl rand -hex 32) \
  TURNSTILE_SITE_KEY=1x00000000000000000000AA TURNSTILE_SECRET=1x0000000000000000000000000000000AA \
  INTERFAZ_DIR=$PWD/interfaz/dist EMAIL_FROM=no-responder@campusia.prueba
nucleo/target/debug/campusia-nucleo migrar
nucleo/target/debug/campusia-nucleo sembrar pruebas/fase-1/datos.json
nucleo/target/debug/campusia-nucleo crear-owner equipo@campusia.prueba
nucleo/target/debug/campusia-nucleo
```

Los códigos de login aparecen en `/tmp/mails.jsonl`.

## Cómo se prueba

```bash
bash pruebas/correr.sh                    # todo, compilando desde cero
CAMPUSIA_SIN_COMPILAR=1 bash pruebas/correr.sh fase-1/ataque
```

Las pruebas de despliegue necesitan Docker (imagen `caddy:2.8.4`).

## Cómo se despliega

```bash
cargo build --release --manifest-path nucleo/Cargo.toml
pnpm --dir interfaz install && pnpm --dir interfaz run build
sudo despliegue/instalar.sh --binario nucleo/target/release/campusia-nucleo --interfaz interfaz/dist
sudo -u campusia env DATABASE_URL=sqlite:///srv/campusia/datos/campusia.db /usr/local/bin/campusia-nucleo crear-owner <mail>
```

Antes de la primera instalación hay que crear `/srv/campusia/config/campusia.env` a partir de `despliegue/campusia.env.ejemplo`, con los secretos reales (Brevo, Turnstile, `SESSION_SECRET`). `instalar.sh` nunca lo crea ni lo pisa. Con `--raiz <carpeta> --sin-servicios` se puede ensayar sin tocar el sistema.

## Resultado de las pruebas

- Aceptación: 74/74.
- Ataque: 72/72.

## Decisiones tomadas

- Huellas con HMAC-SHA256 de `SESSION_SECRET`; nunca se guardan en claro códigos, tokens de sesión ni tokens de API.
- Los códigos de login se atan a la solicitud que los pidió: la interfaz manda un identificador aleatorio `solicitud` en el pedido y en la verificación, y los fallos solo cuentan contra esa solicitud. Así un tercero que conoce el mail no puede anular el código de otra persona ni dejarla sin entrar agotando intentos. Sin `solicitud`, vale el comportamiento del contrato. Columna `solicitud` en `codigos_login`.
- La IP del cliente sale de `ENCABEZADO_IP_CLIENTE` solo si la conexión viene de `PROXIES_CONFIABLES` (por defecto `127.0.0.1,::1`). Un `CF-Connecting-IP` inventado desde otra dirección se ignora.
- Caddy solo atiende a los rangos de Cloudflare (`trusted_proxies` estrictos, `abort` para el resto) y reescribe `CF-Connecting-IP` y `X-Forwarded-For` con la IP real.
- Un administrador solo puede agregar subdominios de los dominios de su universidad (403 `prohibido` para cualquier otro). Los dominios nuevos los habilita el owner con `POST /api/owner/universidades/{id}/dominios`, con reautenticación. Evita que un administrador se apropie de dominios ajenos o públicos.
- La unidad de systemd no usa `NoNewPrivileges`, `PrivateUsers`, `RestrictNamespaces` ni `ProtectHome`, y deja `/run/user` escribible, para no romper Podman sin root en la fase 2.

## Desvíos del plan y del contrato

- Variable nueva `PROXIES_CONFIABLES`, campo opcional `solicitud` en el login y ruta nueva del owner para dominios (ver decisiones).
- `POST /api/admin/dominios` responde 403 `prohibido` para dominios que no son subdominios de la universidad; el contrato solo preveía 400 y 409.
- Pruebas agregadas fuera de la tabla del contrato: `aceptacion/interfaz-cuenta.spec.ts`, `ataque/bloqueo.spec.ts`, `ataque/dominios.spec.ts`, `ataque/ip-cliente.spec.ts` y `despliegue/cloudflare.spec.ts`.
- El plan prevé Podman en producción; las pruebas usan Docker solo para validar el Caddyfile.

## Pendientes conocidos

- Crear curso, unirse con código, inscripciones, enrutador a contenedores y paneles Editar, Inscriptos, Versiones y Publicar: fase 2 en adelante. La página provisoria del curso se reemplaza en la fase 2.
- La elección de proveedores del owner solo se guarda; el núcleo sigue usando `PROVEEDOR_EMAIL`. Resend no está implementado.
- `uso_agente` solo se carga con `sembrar`; la medición real llega con el intermediario del modelo (fase 3).
- Quitar personas de una universidad no existe todavía.
- La tabla `limites` acumula eventos; falta una limpieza periódica de los vencidos.
- El instalador no se probó todavía contra el servidor real de la fase 0.
