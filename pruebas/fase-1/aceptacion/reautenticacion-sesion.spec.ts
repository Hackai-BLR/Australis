import { test, expect, ADMIN_AUSTRAL, OWNER, UNI_DEMO } from '../fixtures.ts';
import { Cliente } from '../../comun/http.ts';
import { aleatorio, entrar } from '../../comun/sesion.ts';

test.describe('reautenticación en modo sesion', () => {
  test('la configuración informa el modo y la sesión queda reautenticada por toda su vigencia', async ({ cliente, nucleo }) => {
    const c = cliente();
    const conf = await c.get('/api/config');
    expect(conf.json.reautenticacion).toBe('sesion');
    const u = await entrar(c, ADMIN_AUSTRAL);
    const yo = await c.get('/api/yo');
    expect(yo.json.sesion.reautenticada_hasta).toBe(yo.json.sesion.vence);
    const filas = nucleo.consultar(
      'SELECT creada_en, reautenticada_en FROM sesiones WHERE usuario_id = ? ORDER BY id DESC LIMIT 1',
      u.id,
    );
    expect(filas[0].reautenticada_en).toBe(filas[0].creada_en);
  });

  test('un administrador recién entrado cambia roles, invita, quita dominios y crea tokens sin código', async ({ cliente, nucleo }) => {
    const persona = cliente();
    const u = await entrar(persona, `${aleatorio('rs.')}@austral.edu.ar`);
    const admin = cliente();
    await entrar(admin, ADMIN_AUSTRAL);
    const dominio = `${aleatorio('rs')}.austral.edu.ar`;
    expect((await admin.post('/api/admin/dominios', { dominio })).status).toBe(201);
    const desde = nucleo.cantidadMails();

    const marca = await admin.put(`/api/admin/personas/${u.id}/profesor`, { profesor: true });
    expect(marca.status, marca.texto).toBe(200);
    expect((await persona.get('/api/yo')).json.usuario.profesor).toBe(true);

    const invitado = `${aleatorio('rsi.')}@austral.edu.ar`;
    const inv = await admin.post('/api/admin/invitaciones', { email: invitado, tipo: 'profesor' });
    expect(inv.status, inv.texto).toBe(201);

    const quitar = await admin.delete(`/api/admin/dominios/${dominio}`);
    expect(quitar.status, quitar.texto).toBe(200);

    expect(nucleo.mails().slice(desde).filter((m) => m.para === ADMIN_AUSTRAL)).toHaveLength(0);
  });

  test('el owner recién entrado crea universidades e invita administradores sin código', async ({ cliente, nucleo }) => {
    const owner = cliente();
    await entrar(owner, OWNER);
    const desde = nucleo.cantidadMails();
    const dominio = `${aleatorio('rsu')}.edu.ar`;
    const r = await owner.post('/api/owner/universidades', { nombre: `U ${dominio}`, dominio, email_administrador: `admin@${dominio}` });
    expect(r.status, r.texto).toBe(201);
    const demo = (await owner.get('/api/owner/universidades')).json.universidades.find((x: any) => x.nombre === UNI_DEMO);
    const a = await owner.post(`/api/owner/universidades/${demo.id}/administradores`, { email: `${aleatorio('rsa.')}@demo.edu.ar` });
    expect(a.status, a.texto).toBe(201);
    expect(nucleo.mails().slice(desde).filter((m) => m.para === OWNER)).toHaveLength(0);
  });

  test('las rutas de código de reautenticación no mandan mails', async ({ cliente, nucleo }) => {
    const c = cliente();
    await entrar(c, ADMIN_AUSTRAL);
    const desde = nucleo.cantidadMails();
    const pedido = await c.post('/api/reautenticacion/codigo');
    expect(pedido.status).toBe(404);
    expect(pedido.json.error).toBe('no_encontrado');
    const v = await c.post('/api/reautenticacion/verificar', { codigo: '123456' });
    expect(v.status).toBe(404);
    expect(nucleo.cantidadMails()).toBe(desde);
  });

  test('cada sesión nueva queda reautenticada, también después de volver a entrar', async ({ nucleo }) => {
    const a = new Cliente(nucleo);
    await entrar(a, ADMIN_AUSTRAL);
    await entrar(a, ADMIN_AUSTRAL);
    const r = await a.post('/api/admin/invitaciones', { email: `${aleatorio('rsv.')}@austral.edu.ar`, tipo: 'profesor' });
    expect(r.status, r.texto).toBe(201);
  });

  test('la interfaz marca profesor y crea universidades sin diálogo de reautenticación', async ({ paginaComo, nucleo }) => {
    const persona = new Cliente(nucleo);
    const u = await entrar(persona, `${aleatorio('rsui.')}@austral.edu.ar`);
    const admin = new Cliente(nucleo);
    await entrar(admin, ADMIN_AUSTRAL);
    const page = await paginaComo(admin);
    await page.goto(nucleo.url(undefined, '/administracion'));
    const sw = page.locator(`button[data-marca="${u.id}"]`);
    await expect(sw).toHaveAttribute('aria-pressed', 'false');
    const desde = nucleo.cantidadMails();
    await sw.click();
    await expect(sw).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#reaut-digitos')).toHaveCount(0);
    expect((await persona.get('/api/yo')).json.usuario.profesor).toBe(true);
    expect(nucleo.mails().slice(desde).filter((m) => m.para === ADMIN_AUSTRAL)).toHaveLength(0);
  });
});
