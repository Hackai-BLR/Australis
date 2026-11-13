import { test, expect } from '../fixtures.ts';
import { atributosCookie } from '../../comun/http.ts';
import { COOKIE_SESION } from '../../comun/entorno.ts';
import { obtenerCodigo, verificar } from '../../comun/sesion.ts';

const OWNER_PROD = 'equipo@campusia.prueba';

test.use({ opcionesNucleo: { semilla: null, owner: OWNER_PROD, produccion: true } });

test('en producción la cookie es Secure y solo se aceptan orígenes https', async ({ cliente, nucleo }) => {
  const c = cliente();
  const codigo = await obtenerCodigo(c, OWNER_PROD);
  const r = await verificar(c, OWNER_PROD, codigo);
  expect(r.status).toBe(200);
  const sc = r.setCookies.find((s) => s.startsWith(`${COOKIE_SESION}=`))!;
  expect(atributosCookie(sc).atributos.secure).toBe(true);
  const http = await c.post('/api/logout', {}, { origen: `http://${nucleo.host()}` });
  expect(http.status).toBe(403);
  expect(http.json.error).toBe('origen_invalido');
  const https = await c.post('/api/logout', {}, { origen: `https://${nucleo.host()}` });
  expect(https.status).toBe(204);
});

test('en producción sembrar datos de prueba está prohibido', async ({ nucleo }) => {
  const r = nucleo.ejecutar(['sembrar', '/dev/null']);
  expect(r.status).not.toBe(0);
});
