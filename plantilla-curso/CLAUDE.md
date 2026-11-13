# Reglas para editar este curso

Este proyecto es un curso de Campus IA: un solo proceso Node 22 que sirve la API del curso (Hono, `servidor/`) y la interfaz compilada (React con Vite, `web/`) en el puerto `PORT`. La plataforma lo corre en un contenedor endurecido, detrás de su propio enrutador.

## Qué podés tocar

- El código del curso: `servidor/` y `web/`, sus pruebas y, si hace falta agregar dependencias, `package.json`.
- No toques `vendor/` (el SDK empaquetado de la plataforma), `Containerfile`, `.containerignore` ni `.dockerignore`, salvo que te lo pidan explícitamente.

## Identidad y datos de la plataforma

- La identidad de quien visita y los datos de la plataforma se obtienen solo con `@campusia/sdk`: `identidadCampus()`, `requiereRol()`, `obtenerIdentidad()` y `encabezadoIdentidad()` de `@campusia/sdk/hono`, y `ClienteCampus` de `@campusia/sdk` (`yo()`, `inscriptos()`, y para archivos, entregas y notas `subirArchivo()`, `archivos()`, `bajarArchivo()`, `entregar()`, `entregas()`, `ponerNota()`, `notas()` e `historialNotas()`).
- Nunca tomes la identidad de cookies, parámetros de consulta, `Authorization` ni otros encabezados. La identidad solo viaja a la plataforma como primer argumento de los métodos de archivos, entregas y notas, con el valor de `encabezadoIdentidad(c)` del pedido que estás atendiendo. Nunca reenvíes cookies a la plataforma.
- Archivos, entregas y notas los guarda la plataforma: no guardes copias en la base del curso. `servidor/entregas.ts` y la sección Entregas de la portada son el ejemplo.
- El curso no maneja logins ni contraseñas, ni crea cuentas: de eso se ocupa la plataforma.
- No muestres mails ni datos de otros inscriptos a quien no corresponda.

## Red y entorno

- El curso no sale a internet: no llama servicios externos ni carga fuentes, scripts o imágenes de CDN. Todo lo que usa la interfaz va empaquetado.
- Solo se leen estas variables de entorno de la plataforma: `PORT`, `CAMPUSIA_CURSO`, `CAMPUSIA_CLAVE_PUBLICA`, `CAMPUSIA_API`, `CAMPUSIA_TOKEN_CURSO` y `CAMPUSIA_DATOS`. No leas otras ni muestres sus valores.

## Datos

- Los datos van en SQLite (better-sqlite3) dentro de `CAMPUSIA_DATOS`, en `curso.sqlite`. Es la única carpeta escribible además de `/tmp`.
- Los cambios de esquema se hacen con migraciones nuevas en `servidor/base.ts`, numeradas en orden. Nunca modifiques ni borres una migración ya aplicada.

## Rutas

- `/salud` se mantiene siempre y responde sin identidad.
- Todo lo demás, incluidos `index.html` y los archivos estáticos, pasa por `identidadCampus()`.
- Las rutas de la API van bajo `/api/` y responden JSON.

## Espacio de trabajo

- El repo está en `/repo` y solo se trabaja ahí: no leas ni escribas fuera de esa carpeta.
- La versión de prueba ya corre con `pnpm dev` y se recarga sola con los cambios en `servidor/` y `web/`. No la arranques ni la detengas.
- Git lo maneja la plataforma: no uses `git` ni toques `.git`. Cada cambio queda guardado al terminar el pedido.
- Para agregar dependencias usá `pnpm add`, que actualiza `package.json` y `pnpm-lock.yaml`. Solo se puede bajar de npm.

## Acciones del profesor

Desde el panel Editar podés hacer, en nombre del profesor que te está hablando, las mismas acciones que él hace en el panel Inscriptos de este curso. Son solo estas, con `@campusia/sdk`:

- `listarInscriptos()`: inscriptos del curso con su rol, y la cantidad de alumnos y profesores.
- `inscribir(emails, rol)`: inscribe por mail; `rol` es `'alumno'` (por defecto) o `'profesor'`.
- `importarSiu(archivo, contenido)`: importa el listado del SIU (CSV o Excel) como alumnos; `contenido` son los bytes del archivo.
- `codigoInscripcion()`, `generarCodigo(dias)` y `activarCodigo(activo)`: ver, generar y activar o desactivar el código de inscripción.
- `pedirQuitar(usuarioId)`: pide quitar a una persona del curso.
- `pedirCambioDeRol(usuarioId, rol)`: pide pasar a una persona a `'alumno'` o `'profesor'`.
- `confirmaciones()`: los pedidos que esperan la confirmación del profesor.

Cómo usarlas:

- Escribí un script `.mjs` dentro de `/repo` (por ejemplo `acciones/inscribir.mjs`) que cree el cliente con `clienteDesdeEntorno()` de `@campusia/sdk` y llame a los métodos, y corrélo con `node acciones/inscribir.mjs`, directamente con `node` (sin `pnpm exec`, `npx`, `env`, `timeout` ni otro programa delante): solo así el script recibe el acceso a la plataforma. Cuando termines, borrá el script.
- `clienteDesdeEntorno()` toma solo la dirección y el token de la plataforma. No leas ni muestres variables de entorno, ni escribas tokens en archivos o comandos.
- Ejemplo:

```js
import { clienteDesdeEntorno } from '@campusia/sdk';

const campus = clienteDesdeEntorno();
const resultado = await campus.inscribir(['ana.gomez@mail.austral.edu.ar'], 'alumno');
console.log(resultado);
```

- Los errores llegan como `ErrorApi` con `codigo` (`dominio_no_habilitado`, `email_invalido`, `no_es_profesor`, `es_dueno`, `prohibido`, `no_encontrado`, ...) y, si corresponde, `emails` con los mails rechazados. Contale al profesor qué pasó.

Reglas:

- Actuás con los permisos del profesor que está hablando, en este curso y nada más: solo el dueño inscribe profesores, cambia roles y pide quitar a otro profesor, y nadie quita al dueño.
- Quitar personas y cambiar roles no se hacen en el momento: quedan pendientes hasta que el profesor los confirme en el panel Editar. Avisale que tiene que confirmarlos ahí.
- No hay otras acciones: transferir el curso, archivarlo, publicar, entregas y notas no se hacen desde acá. Fuera del panel Editar, el curso solo puede leer.

## Antes de terminar

Corré `pnpm test` y `pnpm build`, y asegurate de que los dos terminen bien. Si agregás funcionalidad, agregá pruebas (`*.test.ts`) con identidad válida e inválida.

## Estilo

- Castellano rioplatense en nombres del dominio, textos de la interfaz y mensajes.
- Sin comentarios en el código.
- Sin emojis.
- Textos de la interfaz cortos y claros.
