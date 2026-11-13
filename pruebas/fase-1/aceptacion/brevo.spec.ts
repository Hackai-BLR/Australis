import { test, expect, SEMILLA, OWNER, PROFE_AUSTRAL } from '../fixtures.ts';
import { BREVO_CLAVE_PRUEBA } from '../../comun/servicios-falsos.ts';
import { DOMINIO } from '../../comun/entorno.ts';
import { pedirCodigo, verificar } from '../../comun/sesion.ts';

test.use({ opcionesNucleo: { semilla: SEMILLA, owner: OWNER, brevo: true } });

test('el proveedor brevo manda el código por la API v3 y el código sirve', async ({ cliente, nucleo }) => {
  const c = cliente();
  const antes = nucleo.brevo!.pedidos.length;
  const r = await pedirCodigo(c, PROFE_AUSTRAL);
  expect(r.status).toBe(200);
  await expect.poll(() => nucleo.brevo!.pedidos.length).toBe(antes + 1);
  const p = nucleo.brevo!.pedidos[antes];
  expect(p.ruta).toBe('/v3/smtp/email');
  expect(p.encabezados['api-key']).toBe(BREVO_CLAVE_PRUEBA);
  expect(String(p.encabezados['content-type'])).toContain('application/json');
  expect(p.cuerpo.sender).toEqual({ email: `no-responder@${DOMINIO}`, name: 'Campus IA' });
  expect(p.cuerpo.to).toEqual([{ email: PROFE_AUSTRAL }]);
  expect(typeof p.cuerpo.subject).toBe('string');
  expect(typeof p.cuerpo.htmlContent).toBe('string');
  const codigo = String(p.cuerpo.textContent).match(/(?<!\d)(\d{6})(?!\d)/)![1];
  const v = await verificar(c, PROFE_AUSTRAL, codigo);
  expect(v.status).toBe(200);
});

test('si brevo falla se niega el acceso y no queda un código usable', async ({ cliente, nucleo }) => {
  nucleo.brevo!.fallar = true;
  try {
    const r = await pedirCodigo(cliente(), PROFE_AUSTRAL);
    expect(r.status).toBe(503);
    expect(r.json.error).toBe('servicio_no_disponible');
  } finally {
    nucleo.brevo!.fallar = false;
  }
});
