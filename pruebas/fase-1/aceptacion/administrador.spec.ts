import { test, expect, ADMIN_AUSTRAL, ALUMNO_AUSTRAL, PROFE_AUSTRAL, PROFE2_AUSTRAL, ADMIN_DEMO, UNI_AUSTRAL } from '../fixtures.ts';
import type { Cliente } from '../../comun/http.ts';
import { aleatorio, entrar, esperarMail, reautenticar } from '../../comun/sesion.ts';

async function adminAustral(cliente: () => Cliente, conReaut = false) {
  const c = cliente();
  await entrar(c, ADMIN_AUSTRAL);
  if (conReaut) await reautenticar(c);
  return c;
}

async function crearCuenta(cliente: () => Cliente, dominio = 'austral.edu.ar') {
  const email = `${aleatorio('per.')}@${dominio}`;
  const c = cliente();
  const u = await entrar(c, email);
  return { email, id: u.id as number, c };
}

test.describe('panel de administrador', () => {
  test('ve los datos de su universidad', async ({ cliente }) => {
    const c = await adminAustral(cliente);
    const r = await c.get('/api/admin/universidad');
    expect(r.status).toBe(200);
    expect(r.json.nombre).toBe(UNI_AUSTRAL);
    expect(r.json.dominios).toEqual(expect.arrayContaining(['austral.edu.ar', 'mail.austral.edu.ar']));
    expect(typeof r.json.limite_usd).toBe('number');
    expect(typeof r.json.id).toBe('number');
  });

  test('lista solo las personas de su universidad, con filtros y búsqueda', async ({ cliente }) => {
    const c = await adminAustral(cliente);
    const r = await c.get('/api/admin/personas');
    expect(r.status).toBe(200);
    const mails = r.json.personas.map((p: any) => p.email);
    expect(mails).toEqual(expect.arrayContaining([ADMIN_AUSTRAL, PROFE_AUSTRAL, PROFE2_AUSTRAL, ALUMNO_AUSTRAL]));
    expect(mails.some((m: string) => m.endsWith('@demo.edu.ar'))).toBe(false);
    const lucia = r.json.personas.find((p: any) => p.email === PROFE_AUSTRAL);
    expect(lucia).toMatchObject({ nombre: 'Lucía Fernández', profesor: true, administrador: false, pendiente: false, cursos: 3 });
    expect(typeof lucia.id).toBe('number');
    expect('ultimo_ingreso' in lucia).toBe(true);

    const profes = await c.get('/api/admin/personas?filtro=profesores');
    expect(profes.json.personas.length).toBeGreaterThan(0);
    expect(profes.json.personas.every((p: any) => p.profesor)).toBe(true);
    expect(profes.json.personas.map((p: any) => p.email)).not.toContain(ALUMNO_AUSTRAL);

    const admins = await c.get('/api/admin/personas?filtro=administradores');
    expect(admins.json.personas.every((p: any) => p.administrador)).toBe(true);
    expect(admins.json.personas.map((p: any) => p.email)).toContain(ADMIN_AUSTRAL);

    const busca = await c.get(`/api/admin/personas?buscar=${encodeURIComponent('herrera')}`);
    expect(busca.json.personas.map((p: any) => p.email)).toEqual([PROFE2_AUSTRAL]);
    const buscaNombre = await c.get(`/api/admin/personas?buscar=${encodeURIComponent('Lucía')}`);
    expect(buscaNombre.json.personas.map((p: any) => p.email)).toEqual([PROFE_AUSTRAL]);
  });

  test('marca y desmarca profesor después de reautenticarse', async ({ cliente }) => {
    const persona = await crearCuenta(cliente);
    const c = await adminAustral(cliente, true);
    const r = await c.put(`/api/admin/personas/${persona.id}/profesor`, { profesor: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: persona.id, email: persona.email, profesor: true });
    expect((await persona.c.get('/api/yo')).json.usuario.profesor).toBe(true);
    const r2 = await c.put(`/api/admin/personas/${persona.id}/profesor`, { profesor: false });
    expect(r2.status).toBe(200);
    expect(r2.json.profesor).toBe(false);
    expect((await persona.c.get('/api/yo')).json.usuario.profesor).toBe(false);
    const aud = await c.get('/api/admin/auditoria');
    const acciones = aud.json.eventos.filter((e: any) => String(e.detalle).includes(persona.email)).map((e: any) => e.accion);
    expect(acciones).toEqual(expect.arrayContaining(['marca_profesor', 'quita_profesor']));
  });

  test('invita un profesor nuevo: queda pendiente, le llega un mail y entra como profesor', async ({ cliente, nucleo }) => {
    const c = await adminAustral(cliente, true);
    const email = `${aleatorio('inv.')}@austral.edu.ar`;
    const desde = nucleo.cantidadMails();
    const r = await c.post('/api/admin/invitaciones', { email, tipo: 'profesor' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ email, profesor: true, administrador: false, pendiente: true });
    const mail = await esperarMail(nucleo, email, desde);
    expect(mail.asunto).toMatch(/^Invitación/);
    const lista = await c.get(`/api/admin/personas?buscar=${encodeURIComponent(email)}`);
    expect(lista.json.personas).toHaveLength(1);
    expect(lista.json.personas[0].pendiente).toBe(true);
    const nuevo = cliente();
    const u = await entrar(nuevo, email);
    expect(u).toMatchObject({ email, profesor: true, administrador: false });
  });

  test('invita un administrador, y re-invitar a alguien existente le pone la marca', async ({ cliente, nucleo }) => {
    const c = await adminAustral(cliente, true);
    const email = `${aleatorio('adm.')}@mail.austral.edu.ar`;
    const r = await c.post('/api/admin/invitaciones', { email, tipo: 'administrador' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ email, administrador: true, pendiente: true });
    const nuevo = cliente();
    const u = await entrar(nuevo, email);
    expect(u.administrador).toBe(true);
    expect((await nuevo.get('/api/admin/universidad')).json.nombre).toBe(UNI_AUSTRAL);

    const existente = await crearCuenta(cliente);
    const desde = nucleo.cantidadMails();
    const r2 = await c.post('/api/admin/invitaciones', { email: existente.email, tipo: 'profesor' });
    expect(r2.status).toBe(200);
    expect(r2.json).toMatchObject({ id: existente.id, profesor: true, pendiente: false });
    await esperarMail(nucleo, existente.email, desde);
  });

  test('lista los cursos de su universidad con dueño, profesores, alumnos, estado y uso', async ({ cliente }) => {
    const c = await adminAustral(cliente);
    const r = await c.get('/api/admin/cursos');
    expect(r.status).toBe(200);
    const porId = Object.fromEntries(r.json.cursos.map((x: any) => [x.id, x]));
    expect(Object.keys(porId).sort()).toEqual(['algoritmos', 'etica', 'redes']);
    expect(porId.redes).toMatchObject({
      nombre: 'Redes de Computadoras',
      periodo: '2.º cuatrimestre 2026',
      color: '#1F7A4D',
      dueno: { email: PROFE_AUSTRAL, nombre: 'Lucía Fernández' },
      profesores: 2,
      alumnos: 1,
      version_publicada: 12,
      uso_usd_mes: 31,
    });
    expect(porId.etica.version_publicada).toBeNull();
  });

  test('agrega y quita dominios habilitados', async ({ cliente }) => {
    const c = await adminAustral(cliente);
    const dominio = `${aleatorio('d')}.austral.edu.ar`;
    const r = await c.post('/api/admin/dominios', { dominio: `@${dominio.toUpperCase()}` });
    expect(r.status).toBe(201);
    expect(r.json.dominios).toContain(dominio);
    const persona = await crearCuenta(cliente, dominio);
    expect(persona.id).toBeGreaterThan(0);
    await reautenticar(c);
    const q = await c.delete(`/api/admin/dominios/${encodeURIComponent(dominio)}`);
    expect(q.status).toBe(200);
    expect(q.json.dominios).not.toContain(dominio);
    const aud = await c.get('/api/admin/auditoria');
    const acciones = aud.json.eventos.filter((e: any) => String(e.detalle).includes(dominio)).map((e: any) => e.accion);
    expect(acciones).toEqual(expect.arrayContaining(['dominio_agregado', 'dominio_quitado']));
  });

  test('ve la auditoría de su universidad, la más reciente primero', async ({ cliente }) => {
    const alumno = cliente();
    await entrar(alumno, ALUMNO_AUSTRAL);
    const otraUni = cliente();
    await entrar(otraUni, ADMIN_DEMO);
    const c = await adminAustral(cliente);
    const r = await c.get('/api/admin/auditoria');
    expect(r.status).toBe(200);
    const eventos = r.json.eventos;
    expect(eventos.length).toBeGreaterThan(0);
    for (const e of eventos) {
      expect(typeof e.id).toBe('number');
      expect(typeof e.fecha).toBe('string');
      expect(typeof e.accion).toBe('string');
      expect('actor' in e && 'detalle' in e && 'ip' in e).toBe(true);
    }
    const fechas = eventos.map((e: any) => Date.parse(e.fecha));
    expect([...fechas].sort((a, b) => b - a)).toEqual(fechas);
    const logins = eventos.filter((e: any) => e.accion === 'login');
    expect(logins.some((e: any) => e.actor?.email === ALUMNO_AUSTRAL && e.ip === alumno.ip)).toBe(true);
    expect(eventos.some((e: any) => e.actor?.email === ADMIN_DEMO)).toBe(false);
    const pocos = await c.get('/api/admin/auditoria?limite=2');
    expect(pocos.json.eventos).toHaveLength(2);
  });
});
