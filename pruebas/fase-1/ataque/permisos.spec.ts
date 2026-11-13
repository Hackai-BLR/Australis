import { test, expect, ADMIN_AUSTRAL, ADMIN_DEMO, ALUMNO_AUSTRAL, ALUMNO_DEMO, OWNER, PROFE_AUSTRAL, PROFE_DEMO, UNI_AUSTRAL } from '../fixtures.ts';
import type { Cliente, Respuesta } from '../../comun/http.ts';
import { aleatorio, entrar, esperarCodigo, reautenticar } from '../../comun/sesion.ts';
import { RUTAS_ADMIN, RUTAS_CON_SESION, RUTAS_OWNER, type Ruta } from '../rutas.ts';

function llamar(c: Cliente, r: Ruta): Promise<Respuesta> {
  return c.pedir(r.metodo, r.ruta, r.cuerpo ?? (r.metodo === 'GET' || r.metodo === 'DELETE' ? undefined : {}));
}

async function idDe(admin: Cliente, email: string): Promise<number> {
  const r = await admin.get(`/api/admin/personas?buscar=${encodeURIComponent(email)}`);
  const p = r.json.personas.find((x: any) => x.email === email);
  expect(p, email).toBeTruthy();
  return p.id;
}

test.describe('ataques a los permisos', () => {
  test('sin sesión todas las rutas protegidas responden 401', async ({ cliente }) => {
    const c = cliente();
    for (const r of [...RUTAS_CON_SESION, ...RUTAS_ADMIN, ...RUTAS_OWNER]) {
      const res = await llamar(c, r);
      expect(res.status, `${r.metodo} ${r.ruta}`).toBe(401);
      expect(res.json?.error).toBe('no_autenticado');
    }
  });

  test('alumnos y profesores no pueden usar rutas de administrador ni de owner', async ({ cliente, nucleo }) => {
    for (const email of [ALUMNO_AUSTRAL, PROFE_AUSTRAL]) {
      const c = cliente();
      await entrar(c, email);
      await reautenticar(c);
      for (const r of [...RUTAS_ADMIN, ...RUTAS_OWNER]) {
        const res = await llamar(c, r);
        expect(res.status, `${email} ${r.metodo} ${r.ruta}`).toBe(403);
        expect(res.json?.error).toBe('prohibido');
      }
    }
    const dominios = nucleo.consultar("SELECT COUNT(*) AS n FROM dominios WHERE dominio = 'robado.edu.ar'");
    expect(dominios[0].n).toBe(0);
  });

  test('un administrador no puede usar rutas de owner y el owner no es administrador de ninguna universidad', async ({ cliente }) => {
    const admin = cliente();
    await entrar(admin, ADMIN_AUSTRAL);
    await reautenticar(admin);
    for (const r of RUTAS_OWNER) {
      const res = await llamar(admin, r);
      expect(res.status, `${r.metodo} ${r.ruta}`).toBe(403);
    }
    const owner = cliente();
    await entrar(owner, OWNER);
    await reautenticar(owner);
    for (const r of RUTAS_ADMIN) {
      const res = await llamar(owner, r);
      expect(res.status, `${r.metodo} ${r.ruta}`).toBe(403);
    }
  });

  test('un administrador no ve ni toca personas de otra universidad', async ({ cliente }) => {
    const demo = cliente();
    await entrar(demo, ADMIN_DEMO);
    const idAlumnoDemo = await idDe(demo, ALUMNO_DEMO);
    const idProfeDemo = await idDe(demo, PROFE_DEMO);
    const austral = cliente();
    await entrar(austral, ADMIN_AUSTRAL);
    await reautenticar(austral);
    const lista = await austral.get(`/api/admin/personas?buscar=${encodeURIComponent('demo.edu.ar')}`);
    expect(lista.json.personas).toEqual([]);
    const r1 = await austral.put(`/api/admin/personas/${idAlumnoDemo}/profesor`, { profesor: true });
    expect(r1.status).toBe(404);
    expect(r1.json.error).toBe('no_encontrado');
    const r2 = await austral.put(`/api/admin/personas/${idProfeDemo}/profesor`, { profesor: false });
    expect(r2.status).toBe(404);
    const verificacion = await demo.get(`/api/admin/personas?buscar=${encodeURIComponent('demo.edu.ar')}`);
    const porMail = Object.fromEntries(verificacion.json.personas.map((p: any) => [p.email, p]));
    expect(porMail[ALUMNO_DEMO].profesor).toBe(false);
    expect(porMail[PROFE_DEMO].profesor).toBe(true);
    const r3 = await austral.put('/api/admin/personas/999999/profesor', { profesor: true });
    expect(r3.status).toBe(404);
  });

  test('un administrador no invita a nadie fuera de los dominios de su universidad', async ({ cliente, nucleo }) => {
    const austral = cliente();
    await entrar(austral, ADMIN_AUSTRAL);
    await reautenticar(austral);
    for (const email of [`${aleatorio('x.')}@demo.edu.ar`, `${aleatorio('x.')}@gmail.com`, ALUMNO_DEMO]) {
      const desde = nucleo.cantidadMails();
      const r = await austral.post('/api/admin/invitaciones', { email, tipo: 'administrador' });
      expect(r.status, email).toBe(400);
      expect(r.json.error).toBe('dominio_no_habilitado');
      expect(nucleo.mails().slice(desde).filter((m) => m.para === email)).toHaveLength(0);
    }
    const alumnoDemo = cliente();
    const u = await entrar(alumnoDemo, ALUMNO_DEMO);
    expect(u.administrador).toBe(false);
    const r = await austral.post('/api/admin/invitaciones', { email: ALUMNO_AUSTRAL, tipo: 'jefe' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('datos_invalidos');
  });

  test('un administrador no puede quitar ni apropiarse dominios de otra universidad', async ({ cliente, nucleo }) => {
    const austral = cliente();
    await entrar(austral, ADMIN_AUSTRAL);
    await reautenticar(austral);
    const q = await austral.delete('/api/admin/dominios/demo.edu.ar');
    expect(q.status).toBe(404);
    const a = await austral.post('/api/admin/dominios', { dominio: 'demo.edu.ar' });
    expect(a.status).toBe(409);
    expect(a.json.error).toBe('dominio_en_uso');
    const a2 = await austral.post('/api/admin/dominios', { dominio: 'DEMO.edu.ar.' });
    expect([400, 409]).toContain(a2.status);
    const filas = nucleo.consultar("SELECT u.nombre AS uni FROM dominios d JOIN universidades u ON u.id = d.universidad_id WHERE d.dominio = 'demo.edu.ar'");
    expect(filas).toEqual([{ uni: 'Universidad de Prueba' }]);
    const demo = cliente();
    const u = await entrar(demo, ALUMNO_DEMO);
    expect(u.universidad.nombre).toBe('Universidad de Prueba');
  });

  test('los cursos y la auditoría de otra universidad no se ven', async ({ cliente }) => {
    const demo = cliente();
    await entrar(demo, ADMIN_DEMO);
    const cursos = await demo.get('/api/admin/cursos');
    expect(cursos.json.cursos.map((c: any) => c.id)).toEqual(['quimica']);
    const aud = await demo.get('/api/admin/auditoria?limite=1000');
    const texto = JSON.stringify(aud.json);
    expect(texto).not.toContain('austral.edu.ar');
    const uni = await demo.get('/api/admin/universidad');
    expect(uni.json.nombre).not.toBe(UNI_AUSTRAL);
  });

  test('no se pueden asignar marcas ni universidad a través del cuerpo de las peticiones', async ({ cliente }) => {
    const email = `${aleatorio('m.')}@austral.edu.ar`;
    const c = cliente();
    const desde = c.nucleo.cantidadMails();
    await c.post('/api/login/codigo', { email, owner: true, administrador: true, universidad_id: 2 });
    const codigo = await esperarCodigo(c.nucleo, email, desde);
    const r = await c.post('/api/login/verificar', { email, codigo, owner: true, administrador: true, profesor: true, universidad_id: 2 });
    expect(r.status).toBe(200);
    expect(r.json.usuario).toMatchObject({ owner: false, administrador: false, profesor: false, universidad: { nombre: UNI_AUSTRAL } });
    c.email = email;

    const admin = cliente();
    await entrar(admin, ADMIN_AUSTRAL);
    await reautenticar(admin);
    const id = await idDe(admin, email);
    const m = await admin.put(`/api/admin/personas/${id}/profesor`, { profesor: true, administrador: true, owner: true });
    expect(m.status).toBe(200);
    const yo = await c.get('/api/yo');
    expect(yo.json.usuario).toMatchObject({ profesor: true, administrador: false, owner: false });
  });

  test('mis cursos muestra solo los cursos propios y la página provisoria exige inscripción', async ({ cliente }) => {
    const alumno = cliente();
    await entrar(alumno, ALUMNO_AUSTRAL);
    const ids = (await alumno.get('/api/mis-cursos')).json.cursos.map((c: any) => c.id);
    expect(ids).not.toContain('etica');
    expect(ids).not.toContain('quimica');
    for (const sub of ['etica-curso', 'quimica-curso']) {
      const r = await alumno.get('/', { sub });
      expect(r.status, sub).toBe(403);
      expect(r.texto).not.toContain('Ética Profesional');
      expect(r.texto).not.toContain('Química General');
    }
    const admin = cliente();
    await entrar(admin, ADMIN_AUSTRAL);
    expect((await admin.get('/', { sub: 'redes-curso' })).status).toBe(403);
    const anonimo = cliente();
    const r = await anonimo.get('/', { sub: 'redes-curso' });
    expect([401, 403]).toContain(r.status);
    expect(r.texto).not.toContain('Redes de Computadoras');
    expect((await alumno.get('/', { sub: 'no-existe-curso' })).status).toBe(404);
  });

});
