import { test, expect, ADMIN_AUSTRAL, PROFE_AUSTRAL } from '../fixtures.ts';
import { DOMINIO } from '../../comun/entorno.ts';
import { aleatorio, entrar, reautenticar } from '../../comun/sesion.ts';

test.describe('peticiones falsificadas desde otros orígenes', () => {
  test('las modificaciones sin Origin válido se rechazan aunque la cookie sea buena', async ({ cliente, nucleo }) => {
    const c = cliente();
    await entrar(c, ADMIN_AUSTRAL);
    const p = nucleo.puerto;
    const malos: Array<string | null> = [
      null,
      'null',
      `http://evil.com:${p}`,
      `http://${DOMINIO}.evil.com:${p}`,
      `http://evil${DOMINIO}:${p}`,
      `http://redes-curso.${DOMINIO}:${p}`,
      `http://redes-prueba.${DOMINIO}:${p}`,
      `http://${DOMINIO}:${p + 1}`,
      `http://redes.${DOMINIO}:${p}`,
    ];
    for (const origen of malos) {
      const dominio = `${aleatorio('csrf')}.austral.edu.ar`;
      const r = await c.post('/api/admin/dominios', { dominio }, { origen });
      expect(r.status, `Origin ${origen}`).toBe(403);
      expect(r.json.error).toBe('origen_invalido');
      const uni = await c.get('/api/admin/universidad');
      expect(uni.json.dominios).not.toContain(dominio);
    }
  });

  test('sin el encabezado propio de la interfaz las modificaciones se rechazan', async ({ cliente }) => {
    const c = cliente();
    await entrar(c, ADMIN_AUSTRAL);
    const r = await c.post('/api/admin/dominios', { dominio: 'sin-encabezado.austral.edu.ar' }, { sinEncabezadoPropio: true });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('origen_invalido');
    const r2 = await c.post('/api/logout', {}, { sinEncabezadoPropio: true });
    expect(r2.status).toBe(403);
    expect((await c.get('/api/yo')).status).toBe(200);
  });

  test('el login también exige Origin válido', async ({ cliente, nucleo }) => {
    const desde = nucleo.cantidadMails();
    const email = `${aleatorio('o.')}@austral.edu.ar`;
    const r = await cliente().post('/api/login/codigo', { email }, { origen: 'http://evil.com' });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('origen_invalido');
    const r2 = await cliente().post('/api/login/verificar', { email, codigo: '123456' }, { origen: null });
    expect(r2.status).toBe(403);
    await new Promise((x) => setTimeout(x, 300));
    expect(nucleo.mails().slice(desde).filter((m) => m.para === email)).toHaveLength(0);
  });

  test('un formulario simple de otro sitio no pasa', async ({ cliente }) => {
    const c = cliente();
    await entrar(c, ADMIN_AUSTRAL);
    const r = await c.post('/api/admin/dominios', undefined, {
      origen: 'http://evil.com',
      sinEncabezadoPropio: true,
      cuerpoCrudo: 'dominio=evil.edu.ar',
      tipo: 'application/x-www-form-urlencoded',
    });
    expect(r.status).toBe(403);
    const r2 = await c.post('/api/admin/dominios', undefined, {
      cuerpoCrudo: 'dominio=evil.edu.ar',
      tipo: 'text/plain',
    });
    expect([400, 415]).toContain(r2.status);
  });

  test('desde la barra del curso, en su propio subdominio, las modificaciones funcionan', async ({ cliente }) => {
    const c = cliente();
    await entrar(c, PROFE_AUSTRAL);
    const r = await c.post('/api/logout', {}, { sub: 'redes' });
    expect(r.status).toBe(204);
  });

  test('la API no habilita CORS para otros orígenes', async ({ cliente }) => {
    const c = cliente();
    await entrar(c, PROFE_AUSTRAL);
    const r = await c.get('/api/yo', { encabezados: { origin: 'http://evil.com' } });
    expect(r.encabezados['access-control-allow-origin']).toBeUndefined();
    expect(r.encabezados['access-control-allow-credentials']).toBeUndefined();
    const pre = await c.pedir('OPTIONS', '/api/admin/dominios', undefined, {
      encabezados: { origin: `http://redes-curso.${DOMINIO}:${c.nucleo.puerto}`, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-campusia,content-type' },
    });
    expect(pre.encabezados['access-control-allow-origin']).toBeUndefined();
  });

  test('hosts ajenos no se atienden', async ({ cliente }) => {
    const c = cliente();
    for (const host of ['evil.com', `${DOMINIO}.evil.com`, `a.b.${DOMINIO}`]) {
      const r = await c.get('/api/config', { host });
      expect(r.status, host).toBe(404);
    }
  });

  test('las páginas de la plataforma no se pueden embeber en otros sitios', async ({ cliente }) => {
    const r = await cliente().get('/');
    const csp = String(r.encabezados['content-security-policy'] ?? '');
    expect(csp).toMatch(/frame-ancestors 'none'/);
    const r2 = await cliente().get('/', { sub: 'redes' });
    expect(String(r2.encabezados['content-security-policy'] ?? '')).toMatch(/frame-ancestors 'none'/);
  });

  test('las acciones sensibles con Origin falso no se cuelan aunque haya reautenticación', async ({ cliente }) => {
    const c = cliente();
    await entrar(c, ADMIN_AUSTRAL);
    await reautenticar(c);
    const r = await c.delete('/api/admin/dominios/mail.austral.edu.ar', { origen: 'http://evil.com' } as any);
    expect(r.status).toBe(403);
    expect((await c.get('/api/admin/universidad')).json.dominios).toContain('mail.austral.edu.ar');
  });
});
