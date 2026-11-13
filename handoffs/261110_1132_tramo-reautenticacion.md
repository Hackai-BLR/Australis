# Tramo reautenticación: modo sesion

_Creado: 2026-11-10 11:32. Sigue a `261110_0924_fase-4.md`. Contrato: nota fechada al final de `contratos/fase-1.md`. Rama: `tramo-reautenticacion`, sin unir a `main`._

## Qué se hizo

Mandar mails cuesta plata, así que estando logueado ya no se piden códigos de reautenticación para las acciones sensibles. Se agregó `REAUTENTICACION_MODO`:

- `sesion` (predeterminado): el login crea la sesión con `reautenticada_en = creada_en` y la verificación de reautenticación acepta cualquier sesión válida; `reautenticada_hasta` en `GET /api/yo` es el vencimiento de la sesión. Las rutas `POST /api/reautenticacion/codigo` y `/verificar` responden `404 no_encontrado` sin mandar mails (después del control de sesión: con token siguen respondiendo `requiere_sesion`). La interfaz no monta el modal "Confirmá que sos vos".
- `codigo`: el comportamiento anterior, sin cambios.
- Un valor desconocido impide arrancar.

Archivos:
- `nucleo/src/config.rs`: `ModoReautenticacion` y su lectura.
- `nucleo/src/auth.rs`: `reautenticada_hasta` devuelve el vencimiento de la sesión en modo `sesion`. Los tokens no cambian: las rutas sensibles controlan `solo_sesion` antes.
- `nucleo/src/login.rs`: `reautenticada_en` al crear la sesión, `reautenticacion` en `GET /api/config` y bloqueo de las rutas de código en modo `sesion`.
- `interfaz/src/App.tsx`, `interfaz/src/api.ts`: el modal solo se monta con `reautenticacion: "codigo"`.
- `despliegue/campusia.env.ejemplo`: `REAUTENTICACION_MODO=sesion`.
- `contratos/fase-1.md`: nota del 2026-11-10 al final, sin borrar lo anterior.

## Pruebas

- `pruebas/comun/nucleo.ts`: `MODO_CODIGO` y `Nucleo.modoReautenticacion`.
- `pruebas/comun/sesion.ts`: `reautenticar` en modo `sesion` solo comprueba que la sesión ya esté reautenticada; en modo `codigo` hace el circuito con mail como antes. Así las pruebas que usan la reautenticación solo como paso previo corren en el modo predeterminado.
- En modo `codigo` (prueban el mecanismo del código): fase 1 `aceptacion/login`, `aceptacion/interfaz`, `aceptacion/interfaz-cuenta`, `ataque/reautenticacion`, `ataque/codigos`, `ataque/bloqueo`, `ataque/dominios`, `ataque/vencimientos` (con `testCodigo` de `fase-1/fixtures.ts` o `entorno: MODO_CODIGO`); fase 2 `aceptacion/inscripciones`, `aceptacion/interfaz`, `ataque/inscripciones`. La fase 4 usa `reautenticar` solo como paso previo (`lib/datos.ts`) y corre en modo `sesion`.
- Nuevas del modo `sesion`:
  - `fase-1/aceptacion/reautenticacion-sesion.spec.ts`: `/api/config` informa el modo; `reautenticada_en = creada_en` y `reautenticada_hasta = vence`; el administrador marca profesor, invita, quita dominios y crea tokens sin código y sin mails; el owner crea universidades e invita administradores sin código; las rutas de código responden 404 sin mandar mails; volver a entrar deja la sesión nueva habilitada; la interfaz marca profesor sin diálogo.
  - `fase-1/ataque/reautenticacion-sesion.spec.ts`: sesión cerrada con logout, cerrada desde otra, reemplazada por un login nuevo, revocada en la base o inventada responden 401; tokens de administrador y de owner con todos sus permisos responden `requiere_sesion` en las acciones sensibles; token junto a una cookie revocada no habilita nada; el núcleo no arranca con un modo desconocido.
  - `fase-1/ataque/vencimientos-sesion.spec.ts`: una sesión privilegiada vencida responde 401 en las acciones sensibles.

## Cómo se prueba

```bash
bash pruebas/correr.sh
```

## Resultado de las pruebas

`bash pruebas/correr.sh` desde cero: 373 passed (11.8 min), 0 fallidas.

## Desvíos

- Las rutas de código de reautenticación responden `404 no_encontrado` en modo `sesion` en lugar de seguir mandando códigos, para que no generen mails.
- `GET /api/config` suma el campo `reautenticacion`.

## Pendientes

- Los contratos de las fases 2 y 4 siguen hablando de "con reautenticación"; en modo `sesion` eso se cumple con cualquier sesión válida, según la nota de `contratos/fase-1.md`.
