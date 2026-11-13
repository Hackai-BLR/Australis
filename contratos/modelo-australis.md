# Contrato fijo: modelo de Australis

Lo usan el intermediario del núcleo (que atiende) y el backend de Australis (que llama). No se cambia sin actualizar ambos lados. Es el mismo intermediario de `tramo-acciones-y-cupos.md` con un token propio para Australis.

## Credencial

- Variable del núcleo `AUSTRALIS_TOKEN_MODELO`: un token `cmt_` de 43 caracteres base64url. Si falta, el núcleo no acepta a Australis en el intermediario. Si tiene otro formato, el núcleo no arranca.
- Australis lo recibe como `AI_API_KEY` con `AI_PROVIDER=proxy`, y la dirección del intermediario como `AI_PROXY_URL`. El token solo sirve en `/modelo/v1/messages`: no es una credencial del modelo, que nunca sale del núcleo.

## Pedido

- `POST <AI_PROXY_URL>/modelo/v1/messages` con el cuerpo de la API de mensajes (`model`, `max_tokens`, `system`, `messages`, `tools`), `x-api-key: <token>` y `anthropic-version`.
- `X-Campus-Usuario: <mail>` con el mail de quien pide. El núcleo lo busca entre las personas de la plataforma. Tiene que ser una persona activa, con universidad, profesora o administradora. Si no, responde 401 como con un token inválido.
- Un token de curso (`cmt_` de un espacio) no puede usar este encabezado: el encabezado solo cuenta con el token de Australis.

## Cupos y uso

- El núcleo descuenta los tokens de la persona del encabezado con las mismas reglas de los cupos de tokens: cupo del profesor y cupo de la universidad, por mes. Si alguno se agotó responde 429 con el mensaje del cupo y Australis lo muestra tal cual.
- Cada pedido queda en `uso_modelo` con `curso_id = 'australis'`, la universidad y el `usuario_id` de la persona.
- El cupo diario de Australis (`ai.<función>.daily_quota`) sigue como segundo límite y se reserva antes de llamar al núcleo. Si el núcleo falla o responde 429, la reserva se devuelve.

## Respuesta

- La respuesta de la API de mensajes sin cambios. Australis usa los bloques `text` y `tool_use` (solo de herramientas que ofreció) y `usage` para su registro de uso.
- La insignia "Simulado" no aparece cuando el proveedor es `proxy`.
