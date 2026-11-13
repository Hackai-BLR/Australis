# Orquestación del día 1: plataforma Campus IA en producción

_Creado: 2026-11-11 00:00. Resumen de lo construido entre el 2026-11-10 04:00 y las 24:00, cómo está desplegado y qué queda pendiente. Complementa el plan `261110_0400_plan-implementacion-plataforma.md` y los handoffs de cada fase y tramo._

## Estado en producción (`https://campusia.tech`)

Todo lo de `main` en `99cdba8` está desplegado y sano:
- Fases 1 a 4: login con código, roles, paneles de owner y administrador, cursos por subdominio con contenedores, inscripciones, agente con versión de prueba, publicar y versiones, archivos, entregas, notas, endurecimiento y respaldo diario.
- Tramos: plantilla de curso y SDK (0.3.0), resguardo y Docker sin root, experimento del intermediario (plan A: el token real nunca entra a los contenedores), inhabilitar (cuentas, universidades, cursos, owners y administradores, owner como administrador de cualquier universidad), reautenticación por sesión (el código se pide solo para entrar), acciones del profesor para el agente con confirmación, sin tokens personales de API, cupos de tokens del owner a la universidad y de la universidad a los profesores.
- Infraestructura como código: Cloudflare importado a OpenTofu con estado cifrado en `infraestructura/cloudflare/estado/`; servidor aplicado con Ansible (idempotente, segunda corrida sin cambios); secretos en `infraestructura/servidor/secretos.vault.yml` (Ansible Vault).
- Despliegue continuo: webhook de GitHub firmado a `https://campusia.tech/_despliegue/webhook` y temporizador de 5 minutos; el servidor clona con su deploy key de solo lectura, prueba y compila en contenedores, instala, verifica salud y vuelve atrás si falla. Registro en `/srv/campusia/despliegue/registro.log`.

## Cómo se trabajó

- Las fases y tramos los implementaron workflows (contrato, módulos en paralelo, verificación con pruebas de aceptación y de ataque, revisión de seguridad y completitud, cierre) corridos por sesiones en la máquina de desarrollo, cada una en su rama y árbol de git; la orquestación unió ramas, desplegó y verificó en producción.
- Última corrida completa de pruebas (integración): fases 1 a 4 con Playwright 454 pasadas y 0 fallidas, inhabilitar 78/78, plantilla y SDK 162/162, resguardo 352 controles, experimento 52/52; luego acciones y cupos 39/39 y 33/33.

## Credenciales (fuera del repo)

- `~/.config/campusia/` de quien opera: token de Cloudflare (vence el 2026-11-17), clave de Brevo, token de Claude de la suscripción del equipo (vence en un año), claves de Turnstile, frase del estado de OpenTofu (`tofu-frase`) y contraseña del Vault (`vault-pass`). La frase y la contraseña no se pueden recuperar: guardarlas también en un gestor de contraseñas.
- Servidor: `/srv/campusia/config/campusia.env` (generado por Ansible desde el Vault), deploy key en `/srv/campusia/.ssh/campusia_deploy`.
- Archivos ignorados con datos reales: `infraestructura/cloudflare/produccion.tfvars`, `infraestructura/servidor/inventario.yml`.

## Incidentes del día

- Al desplegar la fase 2 el núcleo no arrancó unos minutos: faltaba el módulo `br_netfilter` para la red de cursos con Docker sin root. Ahora lo carga Ansible.
- La Caddy de Debian no soportaba la configuración; se instala la oficial.
- Contra el servidor real aparecieron dos fallas de Ansible que las pruebas en contenedores no mostraban: Cloudflare respondía 403 al agente por defecto de Python al bajar sus IP, y el swap ya activo hacía fallar la activación. Corregidas en `252623e`.
- El despliegue continuo instala solo el núcleo y la interfaz; la plantilla, el SDK y la imagen del espacio se actualizaron a mano. La corrección está en curso en la rama `tramo-despliegue-completo`.

## Pendientes

- Completar el despliegue continuo para plantilla, SDK y espacio de trabajo (en curso).
- Copias de respaldo fuera del servidor (R2 u otra máquina): hoy viven en el mismo servidor.
- Ley 25.326: política de privacidad, términos, consentimiento y pedidos de acceso, rectificación y supresión.
- Exportar notas y entregas a CSV o Excel para cargarlas en el SIU.
- Perfil propio (nombre y mail), reenviar y cancelar invitaciones, monitoreo y alertas.
- Credenciales del modelo por owner (suscripciones de prueba solo en cursos donde ese owner es el profesor) y decidir si la empresa provee el modelo o cada universidad pone su clave de API.
- El certificado de origen quedó fuera de la gestión de OpenTofu (se excluyó al aplicar para no arriesgar una reemisión); revisar cómo importarlo sin cambios.
- La IP real del servidor figura en el plan del primer commit y en commits viejos de la rama de infraestructura; decidir si se reescribe la historia.
- Prueba manual con el modelo real de punta a punta en producción (crear curso, pedir un cambio al agente, publicar, volver atrás).

## Nota 2026-11-11 00:10

El despliegue continuo completo (rama `tramo-despliegue-completo`) quedó unido a `main` en `aff7d78` y Ansible instaló en el servidor los scripts nuevos: cada despliegue empaqueta el SDK, instala la plantilla, el SDK y el espacio de trabajo, y reconstruye la imagen del espacio cuando cambian. Sus pruebas usaron un Docker simulado; queda pendiente correr `pruebas/tramo-infraestructura-cierre/correr.sh` completo con Ansible y observar la primera reconstrucción real de la imagen disparada por un cambio en `sdk/`, `plantilla-curso/` o `despliegue/espacio-trabajo/`.
