# Contrato fijo: modelo de Australis

Lo usan el intermediario del núcleo (que atiende) y el backend de Australis (que llama). No se cambia sin actualizar ambos lados. Es el mismo intermediario de `tramo-acciones-y-cupos.md` con un token propio para Australis.

## Credencial

- Variable del núcleo `AUSTRALIS_TOKEN_MODELO`: un token `cmt_` de 43 caracteres base64url. Si falta, el núcleo no acepta a Australis en el intermediario. Si tiene otro formato, el núcleo no arranca.
- Australis lo recibe como `AI_API_KEY` con `AI_PROVIDER=proxy`, y la dirección del intermediario como `AI_PROXY_URL`. El token solo sirve en `/modelo/v1/messages`: no es una credencial del modelo, que nunca sale del núcleo.

## Pedido

- `POST <AI_PROXY_URL>/modelo/v1/messages` con el cuerpo de la API de mensajes (`model`, `max_tokens`, `system`, `messages`, `tools`), `x-api-key: <token>` y `anthropic-version`.
- `X-Campus-Identidad: <valor>`: la identidad firmada por el núcleo (`identidad-australis.md`) de la persona que hizo el pedido a Australis, la misma que el núcleo agregó al reenviárselo. Australis la copia tal cual en cada llamada al modelo. El token solo nunca alcanza: sin una identidad válida el núcleo responde 401 y no cobra nada, así que filtrar el token no permite gastar el cupo de nadie.
- El núcleo verifica su propia firma, que `curso` sea `australis`, que no esté vencida, que no se haya emitido más de 30 segundos en el futuro y que la vigencia no pase de 120 segundos. Cobra a la persona del mail firmado, que tiene que ser activa, con universidad, profesora o administradora; si no, 401 como con un token inválido.
- `X-Campus-Usuario: <mail>` es opcional y redundante. Si está y no coincide con el mail firmado (sin distinguir mayúsculas), el núcleo responde 401. Nunca decide a quién se cobra.
- Sin sesión de la persona no hay identidad: con `AUTH_MODE=password` (desarrollo y pruebas) el proveedor `proxy` falla cerrado con un error claro en lugar de mandar el token solo.
- Un token de curso (`cmt_` de un espacio) no puede usar este encabezado: el encabezado solo cuenta con el token de Australis.

## Cupos y uso

- El núcleo descuenta los tokens de la persona del encabezado con las mismas reglas de los cupos de tokens: cupo del profesor y cupo de la universidad, por mes. Si alguno se agotó responde 429 con el mensaje del cupo y Australis lo muestra tal cual.
- Cada pedido queda en `uso_modelo` con `curso_id = 'australis'`, la universidad y el `usuario_id` de la persona.
- El cupo diario de Australis (`ai.<función>.daily_quota`) sigue como segundo límite y se reserva antes de llamar al núcleo. Si el núcleo falla o responde 429, la reserva se devuelve.

## Respuesta

- La respuesta de la API de mensajes sin cambios. Australis usa los bloques `text` y `tool_use` (solo de herramientas que ofreció) y `usage` para su registro de uso.
- La insignia "Simulado" no aparece cuando el proveedor es `proxy`.
