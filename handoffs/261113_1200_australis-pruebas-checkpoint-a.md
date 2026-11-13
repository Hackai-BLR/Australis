# Pruebas de navegador de Australis: checkpoint A (M8)

_Creado: 2026-11-13 12:00._ Tarea M8 del plan (`docs/plan.md`): pruebas Playwright del checkpoint A, en `pruebas/australis/checkpoint-a/`, con el estilo de `pruebas/fase-*`.

## Qué hay

- `pruebas/australis/` es un paquete aparte (pnpm, Playwright 1.56.1) que no toca `pruebas/` ni sus fases.
- `comun/pila.ts`: levanta una pila propia con Docker (imágenes de `backend/` y `frontend/`, red privada, nginx real, puerto libre en 127.0.0.1) sobre una base nueva, con la secretaria sembrada por `SEED_ADMIN_EMAIL` y `SEED_ADMIN_PASSWORD`, proveedores `placeholder`. Al terminar borra contenedores y red. No hay volúmenes: la base nace vacía en cada corrida.
- `checkpoint-a/aceptacion/historia.spec.ts`: los nueve pasos de la historia de la demo, en orden. Las pantallas se usan para entrar, crear el campus, aceptar la invitación, ver la clase de hoy, las notas, seguir las diapositivas y ver la grabación; el resto va por la API a través de nginx.
- `checkpoint-a/ataque/rechazos.spec.ts`: lo que debe rechazarse (docente en el campus de otro, alumno escribiendo notas, alumno leyendo notas ajenas, pedido a la IA de cambiar una nota, alumno suspendido, sin sesión, invitación reutilizada).

## Cómo correrlas

`pruebas/australis/correr.sh` instala dependencias, el navegador y corre todo desde cero. Variables: `AUSTRALIS_SIN_COMPILAR=1` reutiliza las imágenes ya construidas; `AUSTRALIS_URL=http://...` apunta a una pila local ya levantada en vez de crear una (nunca a producción).

## Pendiente

- Cada función nueva suma sus pruebas en la carpeta del checkpoint que cierra su fase.
- Las pruebas no usan el modo de código por correo: entran con contraseña, como pide M8, hasta que M2 exista.
