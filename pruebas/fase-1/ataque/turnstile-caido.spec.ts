import { test, expect, SEMILLA, OWNER } from '../fixtures.ts';
import { TURNSTILE_TOKEN_VALIDO } from '../../comun/servicios-falsos.ts';
import { aleatorio, pedirCodigo } from '../../comun/sesion.ts';

test.use({ opcionesNucleo: { semilla: SEMILLA, owner: OWNER, turnstileCaido: true, entorno: { UMBRAL_TURNSTILE: '1' } } });

test('si no se puede verificar Turnstile se niega el acceso', async ({ cliente, nucleo }) => {
  const c = cliente();
  expect((await pedirCodigo(c, `${aleatorio('t.')}@austral.edu.ar`)).status).toBe(200);
  const email = `${aleatorio('t.')}@austral.edu.ar`;
  const desde = nucleo.cantidadMails();
  const r = await pedirCodigo(c, email, { turnstile: TURNSTILE_TOKEN_VALIDO });
  expect(r.status).toBe(503);
  expect(r.json.error).toBe('servicio_no_disponible');
  await new Promise((x) => setTimeout(x, 500));
  expect(nucleo.mails().slice(desde).filter((m) => m.para === email)).toHaveLength(0);
});
