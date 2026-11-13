import { testCodigo as test, expect, ADMIN_AUSTRAL, OWNER, UNI_AUSTRAL, UNI_DEMO } from '../fixtures.ts';
import { aleatorio, entrar, esperarCodigo, pedirCodigo, reautenticar, verificar } from '../../comun/sesion.ts';

test.describe('un administrador no se apropia de dominios ajenos', () => {
  test('no puede habilitar el dominio de otra institución, uno público ni uno bajo otra universidad', async ({ cliente, nucleo }) => {
    const admin = cliente();
    await entrar(admin, ADMIN_AUSTRAL);
    const ajenos = [`${aleatorio('unib')}.edu.ar`, 'gmail.com', 'outlook.com', `${aleatorio('x')}.demo.edu.ar`, 'edu.ar', `austral.edu.ar.${aleatorio('e')}.com`];
    for (const dominio of ajenos) {
      const r = await admin.post('/api/admin/dominios', { dominio });
      expect(r.status, dominio).toBe(403);
      expect(r.json.error, dominio).toBe('prohibido');
      expect(nucleo.consultar('SELECT COUNT(*) AS n FROM dominios WHERE dominio = ?', dominio)[0].n, dominio).toBe(0);
    }
    const uni = await admin.get('/api/admin/universidad');
    for (const dominio of ajenos) expect(uni.json.dominios).not.toContain(dominio);
  });

  test('las personas de una institución rechazada no quedan en la universidad del administrador', async ({ cliente, nucleo }) => {
    const admin = cliente();
    await entrar(admin, ADMIN_AUSTRAL);
    const dominio = `${aleatorio('unib')}.edu.ar`;
    expect((await admin.post('/api/admin/dominios', { dominio })).status).toBe(403);
    const email = `alguien@${dominio}`;
    const desde = nucleo.cantidadMails();
    expect((await pedirCodigo(cliente(), email)).status).toBe(200);
    await new Promise((x) => setTimeout(x, 500));
    expect(nucleo.mails().slice(desde).filter((m) => m.para === email)).toHaveLength(0);
    expect(nucleo.consultar('SELECT COUNT(*) AS n FROM usuarios WHERE email = ?', email)[0].n).toBe(0);
  });

  test('puede habilitar subdominios de los dominios de su universidad', async ({ cliente, nucleo }) => {
    const admin = cliente();
    await entrar(admin, ADMIN_AUSTRAL);
    const dominio = `${aleatorio('alumnos')}.mail.austral.edu.ar`;
    const r = await admin.post('/api/admin/dominios', { dominio });
    expect(r.status).toBe(201);
    expect(r.json.dominios).toContain(dominio);
    const persona = cliente();
    const u = await entrar(persona, `x@${dominio}`);
    expect(u.universidad.nombre).toBe(UNI_AUSTRAL);
  });

  test('el owner habilita un dominio nuevo en una universidad, con reautenticación', async ({ cliente, nucleo }) => {
    const owner = cliente();
    await entrar(owner, OWNER);
    const lista = await owner.get('/api/owner/universidades');
    const demo = lista.json.universidades.find((u: any) => u.nombre === UNI_DEMO);
    const dominio = `${aleatorio('otro')}.edu.ar`;
    const sinReaut = await owner.post(`/api/owner/universidades/${demo.id}/dominios`, { dominio });
    expect(sinReaut.status).toBe(403);
    expect(sinReaut.json.error).toBe('reautenticacion_requerida');
    await reautenticar(owner);
    const r = await owner.post(`/api/owner/universidades/${demo.id}/dominios`, { dominio: `@${dominio.toUpperCase()}` });
    expect(r.status).toBe(201);
    expect(r.json.dominios).toContain(dominio);
    const repetido = await owner.post(`/api/owner/universidades/${demo.id}/dominios`, { dominio: 'austral.edu.ar' });
    expect(repetido.status).toBe(409);
    expect(repetido.json.error).toBe('dominio_en_uso');
    expect((await owner.post('/api/owner/universidades/999999/dominios', { dominio: `${aleatorio('n')}.edu.ar` })).status).toBe(404);
    expect((await owner.post(`/api/owner/universidades/${demo.id}/dominios`, { dominio: 'no valido' })).status).toBe(400);
    const persona = cliente();
    const email = `p@${dominio}`;
    const desde = nucleo.cantidadMails();
    expect((await pedirCodigo(persona, email)).status).toBe(200);
    const codigo = await esperarCodigo(nucleo, email, desde);
    const v = await verificar(persona, email, codigo);
    expect(v.json.usuario.universidad.nombre).toBe(UNI_DEMO);
    const aud = nucleo.consultar("SELECT universidad_id FROM auditoria WHERE accion = 'dominio_agregado' AND detalle LIKE ?", `%${dominio}%`);
    expect(aud).toEqual([{ universidad_id: demo.id }]);
  });

  test('un administrador no usa la ruta del owner para agregar dominios', async ({ cliente }) => {
    const admin = cliente();
    await entrar(admin, ADMIN_AUSTRAL);
    await reautenticar(admin);
    const yo = await admin.get('/api/yo');
    const r = await admin.post(`/api/owner/universidades/${yo.json.usuario.universidad.id}/dominios`, { dominio: `${aleatorio('u')}.edu.ar` });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('prohibido');
  });
});
