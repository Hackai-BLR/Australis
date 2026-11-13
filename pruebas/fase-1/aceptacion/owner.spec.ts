import { test, expect, OWNER, UNI_AUSTRAL, UNI_DEMO, USO_AUSTRAL, ADMIN_AUSTRAL, PROFE_DEMO } from '../fixtures.ts';
import { aleatorio, entrar, esperarMail, reautenticar } from '../../comun/sesion.ts';

test.describe('panel de owner', () => {
  test('lista las universidades con dominios, administradores y conteos', async ({ cliente }) => {
    const c = cliente();
    await entrar(c, OWNER);
    const r = await c.get('/api/owner/universidades');
    expect(r.status).toBe(200);
    const austral = r.json.universidades.find((u: any) => u.nombre === UNI_AUSTRAL);
    expect(austral).toBeTruthy();
    expect(austral.dominios).toEqual(expect.arrayContaining(['austral.edu.ar', 'mail.austral.edu.ar']));
    expect(austral.administradores.map((a: any) => a.email)).toContain(ADMIN_AUSTRAL);
    expect(austral.administradores[0]).toHaveProperty('pendiente');
    expect(austral.cursos).toBe(3);
    expect(austral.profesores).toBeGreaterThanOrEqual(3);
    expect(austral.personas).toBeGreaterThanOrEqual(5);
    expect(typeof austral.limite_usd).toBe('number');
    expect(r.json.universidades.find((u: any) => u.nombre === UNI_DEMO).cursos).toBe(1);
  });

  test('crea una universidad con su primer administrador, que entra y la administra', async ({ cliente, nucleo }) => {
    const c = cliente();
    await entrar(c, OWNER);
    await reautenticar(c);
    const dominio = `${aleatorio('u')}.edu.ar`;
    const emailAdmin = `rectorado@${dominio}`;
    const desde = nucleo.cantidadMails();
    const r = await c.post('/api/owner/universidades', { nombre: `Universidad ${dominio}`, dominio, email_administrador: emailAdmin });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ nombre: `Universidad ${dominio}`, dominios: [dominio], cursos: 0 });
    expect(r.json.administradores).toEqual([expect.objectContaining({ email: emailAdmin, pendiente: true })]);
    const mail = await esperarMail(nucleo, emailAdmin, desde);
    expect(mail.asunto).toMatch(/^Invitación/);

    const admin = cliente();
    const u = await entrar(admin, emailAdmin);
    expect(u).toMatchObject({ administrador: true, universidad: { id: r.json.id, nombre: `Universidad ${dominio}` } });
    const personas = await admin.get('/api/admin/personas');
    expect(personas.json.personas.map((p: any) => p.email)).toEqual([emailAdmin]);

    const alumno = cliente();
    const ua = await entrar(alumno, `alguien@${dominio}`);
    expect(ua.universidad.id).toBe(r.json.id);

    const aud = await admin.get('/api/admin/auditoria');
    expect(aud.json.eventos.map((e: any) => e.accion)).toEqual(expect.arrayContaining(['universidad_creada', 'login']));
  });

  test('invita otro administrador a una universidad existente', async ({ cliente, nucleo }) => {
    const c = cliente();
    await entrar(c, OWNER);
    await reautenticar(c);
    const lista = await c.get('/api/owner/universidades');
    const demo = lista.json.universidades.find((u: any) => u.nombre === UNI_DEMO);
    const email = `${aleatorio('sec.')}@demo.edu.ar`;
    const desde = nucleo.cantidadMails();
    const r = await c.post(`/api/owner/universidades/${demo.id}/administradores`, { email });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ email, administrador: true, pendiente: true });
    await esperarMail(nucleo, email, desde);
    const despues = await c.get('/api/owner/universidades');
    const demo2 = despues.json.universidades.find((u: any) => u.id === demo.id);
    expect(demo2.administradores.map((a: any) => a.email)).toContain(email);
  });

  test('ve el uso por universidad', async ({ cliente }) => {
    const c = cliente();
    await entrar(c, OWNER);
    const r = await c.get('/api/owner/uso');
    expect(r.status).toBe(200);
    expect(r.json.cursos).toBeGreaterThanOrEqual(4);
    expect(r.json.personas).toBeGreaterThanOrEqual(8);
    expect(r.json.agente_usd_mes).toBeGreaterThanOrEqual(USO_AUSTRAL + 5);
    expect(typeof r.json.mails_hoy).toBe('number');
    expect(r.json.mails_hoy).toBeGreaterThan(0);
    const austral = r.json.universidades.find((u: any) => u.nombre === UNI_AUSTRAL);
    expect(austral).toMatchObject({ cursos: 3, agente_usd_mes: USO_AUSTRAL });
    expect(typeof austral.id).toBe('number');
  });

  test('elige los proveedores del modelo y de mails', async ({ cliente }) => {
    const c = cliente();
    await entrar(c, OWNER);
    const inicial = await c.get('/api/owner/proveedores');
    expect(inicial.status).toBe(200);
    expect(['api', 'suscripcion']).toContain(inicial.json.modelo);
    expect(['brevo', 'resend']).toContain(inicial.json.email);
    const r = await c.put('/api/owner/proveedores', { modelo: 'suscripcion', email: 'resend' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ modelo: 'suscripcion', email: 'resend' });
    expect((await c.get('/api/owner/proveedores')).json).toEqual({ modelo: 'suscripcion', email: 'resend' });
    const mal = await c.put('/api/owner/proveedores', { modelo: 'otro', email: 'brevo' });
    expect(mal.status).toBe(400);
    expect(mal.json.error).toBe('datos_invalidos');
    expect((await c.put('/api/owner/proveedores', { modelo: 'api', email: 'brevo' })).status).toBe(200);
  });

  test('crear una universidad con un dominio ya habilitado responde dominio_en_uso y no crea nada', async ({ cliente, nucleo }) => {
    const c = cliente();
    await entrar(c, OWNER);
    await reautenticar(c);
    const nombre = `U ${aleatorio('dup')}`;
    const antes = nucleo.cantidadMails();
    const r = await c.post('/api/owner/universidades', { nombre, dominio: 'demo.edu.ar', email_administrador: `${aleatorio('n.')}@demo.edu.ar` });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('dominio_en_uso');
    expect(nucleo.consultar('SELECT COUNT(*) AS n FROM universidades WHERE nombre = ?', nombre)[0].n).toBe(0);
    const filas = nucleo.consultar("SELECT u.nombre AS uni FROM dominios d JOIN universidades u ON u.id = d.universidad_id WHERE d.dominio = 'demo.edu.ar'");
    expect(filas).toEqual([{ uni: UNI_DEMO }]);
    await new Promise((x) => setTimeout(x, 300));
    expect(nucleo.cantidadMails()).toBe(antes);
  });

  test('crear una universidad con un administrador de otro dominio responde dominio_no_habilitado', async ({ cliente, nucleo }) => {
    const c = cliente();
    await entrar(c, OWNER);
    await reautenticar(c);
    const dominio = `${aleatorio('dnh')}.edu.ar`;
    const r = await c.post('/api/owner/universidades', { nombre: `U ${dominio}`, dominio, email_administrador: `rector@otro-${dominio}` });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('dominio_no_habilitado');
    expect(nucleo.consultar('SELECT COUNT(*) AS n FROM dominios WHERE dominio = ?', dominio)[0].n).toBe(0);
    expect(nucleo.consultar('SELECT COUNT(*) AS n FROM universidades WHERE nombre = ?', `U ${dominio}`)[0].n).toBe(0);
  });

  test('crear una universidad con el mail de una cuenta existente responde email_en_uso y no crea nada', async ({ cliente, nucleo }) => {
    const c = cliente();
    await entrar(c, OWNER);
    await reautenticar(c);
    const dominio = OWNER.split('@')[1];
    const nombre = `U ${aleatorio('eu')}`;
    const r = await c.post('/api/owner/universidades', { nombre, dominio, email_administrador: OWNER });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('email_en_uso');
    expect(nucleo.consultar('SELECT COUNT(*) AS n FROM dominios WHERE dominio = ?', dominio)[0].n).toBe(0);
    expect(nucleo.consultar('SELECT COUNT(*) AS n FROM universidades WHERE nombre = ?', nombre)[0].n).toBe(0);
    const yo = await c.get('/api/yo');
    expect(yo.json.usuario).toMatchObject({ owner: true, administrador: false, universidad: null });
  });

  test('invitar un administrador a una universidad que no existe responde 404', async ({ cliente, nucleo }) => {
    const c = cliente();
    await entrar(c, OWNER);
    await reautenticar(c);
    const email = `${aleatorio('nx.')}@demo.edu.ar`;
    for (const id of ['999999', 'abc', '-1']) {
      const r = await c.post(`/api/owner/universidades/${id}/administradores`, { email });
      expect(r.status, id).toBe(404);
      expect(r.json.error, id).toBe('no_encontrado');
    }
    expect(nucleo.consultar('SELECT COUNT(*) AS n FROM usuarios WHERE email = ?', email)[0].n).toBe(0);
    const profe = await c.post('/api/owner/universidades/999999/administradores', { email: PROFE_DEMO });
    expect(profe.status).toBe(404);
    expect(nucleo.consultar('SELECT administrador FROM usuarios WHERE email = ?', PROFE_DEMO)[0].administrador).toBe(0);
  });
});
