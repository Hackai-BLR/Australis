import { crearTestTramo, expect, ADMIN_AUSTRAL, OWNER, PROFE_AUSTRAL } from '../fixtures.ts';
import { Cliente, type Respuesta } from '../../comun/http.ts';
import { entrar, esperarCodigo, obtenerCodigo, pedirCodigo, reautenticar, verificar } from '../../comun/sesion.ts';
import {
  AUSTRAL,
  cuentaNueva,
  cursoDePrueba,
  deshabilitar,
  ejecutarSql,
  fila,
  idUniversidad,
  idUsuario,
  mailNuevo,
  paginaCurso,
  reactivar,
  rehabilitar,
  revivirSesiones,
  sesion,
  sesionReautenticada,
  suspender,
  tokenPersonal,
  universidadNueva,
} from '../lib.ts';
import { MODO_CODIGO } from '../../comun/nucleo.ts';

const test = crearTestTramo({ entorno: MODO_CODIGO });

const RUTAS_LECTURA = ['/api/yo', '/api/mis-cursos'];

async function todasRechazadas(c: Cliente, op: Record<string, any> = {}) {
  for (const ruta of RUTAS_LECTURA) {
    const r = await c.get(ruta, op);
    expect(r.status, `${ruta}: ${r.texto}`).toBe(401);
    expect(r.json?.error).toBe('no_autenticado');
  }
  const u = await c.post('/api/unirse', { codigo: 'RED-AAAAAA' }, op);
  expect(u.status).toBe(401);
  const t = await c.post('/api/reautenticacion/codigo', {}, op);
  expect(t.status).toBe(401);
}

test.describe('cuenta suspendida', () => {
  test('sus sesiones y tokens viejos no sirven, ni siquiera revividos en la base', async ({ nucleo }) => {
    const ana = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
    const alumno = await cuentaNueva(nucleo);
    const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL, alumnos: [alumno.email] });
    await reautenticar(alumno.cliente);
    const token = await tokenPersonal(alumno.cliente, ['cursos:leer', 'cursos:escribir']);
    const copia = alumno.cliente.clonarSesion();

    expect((await suspender(ana, alumno.id)).status).toBe(200);
    await todasRechazadas(alumno.cliente);
    await todasRechazadas(copia);
    for (const ruta of ['/api/yo', '/api/mis-cursos', `/api/cursos/${curso}`]) {
      expect((await alumno.cliente.get(ruta, { bearer: token, sinCookies: true })).status).toBe(401);
    }

    revivirSesiones(nucleo, alumno.email);
    ejecutarSql(nucleo, 'UPDATE tokens_api SET revocado = 0 WHERE usuario_id = ?', alumno.id);
    await todasRechazadas(alumno.cliente);
    expect((await alumno.cliente.get('/api/yo', { bearer: token, sinCookies: true })).status).toBe(401);
    const pagina = await paginaCurso(alumno.cliente, curso);
    expect(pagina.status, 'el enrutador no emite identidad para una cuenta suspendida').toBe(403);
    expect(pagina.texto).not.toContain(`Curso de prueba ${curso}`);
    expect(pagina.texto).not.toContain('Curso en preparación');

    ejecutarSql(nucleo, 'UPDATE sesiones SET revocada = 1 WHERE usuario_id = ?', alumno.id);
    expect((await reactivar(ana, alumno.id)).status).toBe(200);
    await todasRechazadas(copia);
    ejecutarSql(nucleo, 'UPDATE tokens_api SET revocado = 1 WHERE usuario_id = ?', alumno.id);
    expect((await alumno.cliente.get('/api/yo', { bearer: token, sinCookies: true })).status).toBe(401);
  });

  test('un código pedido antes de la suspensión no sirve después', async ({ nucleo }) => {
    const ana = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
    const persona = await cuentaNueva(nucleo);
    const atacante = new Cliente(nucleo);
    const codigo = await obtenerCodigo(atacante, persona.email);
    const desde = nucleo.cantidadMails();
    const reaut = await persona.cliente.post('/api/reautenticacion/codigo');
    expect(reaut.status).toBe(200);
    const codigoReaut = await esperarCodigo(nucleo, persona.email, desde);

    expect((await suspender(ana, persona.id)).status).toBe(200);
    const v = await verificar(atacante, persona.email, codigo);
    expect(v.status).toBe(400);
    expect(v.json.error).toBe('codigo_invalido');
    expect(v.setCookies.filter((c) => c.startsWith('campusia_sesion=') && !/max-age=0/i.test(c))).toHaveLength(0);
    expect((await atacante.get('/api/yo')).status).toBe(401);
    revivirSesiones(nucleo, persona.email);
    const vr = await persona.cliente.post('/api/reautenticacion/verificar', { codigo: codigoReaut });
    expect(vr.status).toBe(401);
    expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM codigos_login WHERE email = ? AND usado = 0 AND anulado = 0', persona.email).n).toBe(0);
  });

  test('pedir código con una cuenta suspendida responde igual que cualquier mail y no manda nada', async ({ nucleo }) => {
    const ana = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
    const suspendida = await cuentaNueva(nucleo);
    const activa = await cuentaNueva(nucleo);
    expect((await suspender(ana, suspendida.id)).status).toBe(200);

    const casos = [suspendida.email, activa.email, mailNuevo('austral.edu.ar', 'nadie'), mailNuevo('gmail.com', 'otro')];
    const desde = nucleo.cantidadMails();
    const respuestas: Respuesta[] = [];
    for (const email of casos) respuestas.push(await pedirCodigo(new Cliente(nucleo), email));
    for (const r of respuestas) {
      expect(r.status).toBe(200);
      expect(r.texto).toBe(respuestas[0].texto);
      expect(r.setCookies).toEqual([]);
      expect(r.encabezados['content-type']).toBe(respuestas[0].encabezados['content-type']);
    }
    await new Promise((res) => setTimeout(res, 500));
    const enviados = nucleo.mails().slice(desde).map((m) => m.para);
    expect(enviados).toContain(activa.email);
    expect(enviados).not.toContain(suspendida.email);

    const malo1 = await verificar(new Cliente(nucleo), suspendida.email, '123456');
    const malo2 = await verificar(new Cliente(nucleo), activa.email, '123456');
    expect(malo1.status).toBe(400);
    expect(malo1.texto).toBe(malo2.texto);
  });

  test('un owner suspendido pierde el acceso de owner', async ({ nucleo }) => {
    const owner = await sesionReautenticada(nucleo, OWNER);
    const otro = await cuentaNueva(nucleo);
    expect(nucleo.ejecutar(['crear-owner', otro.email]).status).toBe(0);
    expect((await otro.cliente.get('/api/owner/universidades')).status).toBe(200);
    expect((await suspender(owner, otro.id, 'owner')).status).toBe(200);
    expect((await otro.cliente.get('/api/owner/universidades')).status).toBe(401);
    revivirSesiones(nucleo, otro.email);
    expect((await otro.cliente.get('/api/owner/universidades')).status).toBe(401);
    const desde = nucleo.cantidadMails();
    expect((await pedirCodigo(new Cliente(nucleo), otro.email)).status).toBe(200);
    await new Promise((res) => setTimeout(res, 500));
    expect(nucleo.mails().slice(desde).filter((m) => m.para === otro.email)).toHaveLength(0);
    expect((await reactivar(owner, otro.id, 'owner')).status).toBe(200);
  });

  test('una cuenta suspendida no se reactiva sola al ser invitada o inscripta', async ({ nucleo }) => {
    const ana = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
    const persona = await cuentaNueva(nucleo);
    expect((await suspender(ana, persona.id)).status).toBe(200);
    await ana.post('/api/admin/invitaciones', { email: persona.email, tipo: 'profesor' });
    const dueno = await sesionReautenticada(nucleo, PROFE_AUSTRAL);
    const curso = cursoDePrueba(nucleo, { universidad: idUniversidad(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL });
    await dueno.post(`/api/cursos/${curso}/inscriptos`, { emails: [persona.email], rol: 'alumno' });
    expect(fila(nucleo, 'SELECT suspendida_en FROM usuarios WHERE id = ?', persona.id).suspendida_en).toBeTruthy();
    const desde = nucleo.cantidadMails();
    await pedirCodigo(new Cliente(nucleo), persona.email);
    await new Promise((res) => setTimeout(res, 500));
    expect(nucleo.mails().slice(desde).filter((m) => /(?<!\d)\d{6}(?!\d)/.test(m.texto) && m.para === persona.email)).toHaveLength(0);
  });
});

test.describe('universidad deshabilitada', () => {
  test('sesiones revividas, tokens y pedidos de código de sus cuentas fallan sin revelar nada', async ({ nucleo }) => {
    const owner = await sesionReautenticada(nucleo, OWNER);
    const uni = await universidadNueva(owner);
    const admin = await sesion(nucleo, uni.admin);
    await reautenticar(admin);
    const token = await tokenPersonal(admin, ['admin:leer', 'admin:escribir']);
    const persona = await cuentaNueva(nucleo, uni.dominio);
    const profe = await cuentaNueva(nucleo, uni.dominio, 'prof');
    const curso = cursoDePrueba(nucleo, { universidad: uni.id, dueno: profe.email, alumnos: [persona.email] });

    expect((await deshabilitar(owner, uni.id)).status).toBe(200);
    revivirSesiones(nucleo, uni.admin);
    revivirSesiones(nucleo, persona.email);
    await todasRechazadas(admin);
    await todasRechazadas(persona.cliente);
    for (const r of [
      await admin.get('/api/admin/personas'),
      await admin.get('/api/admin/personas', { bearer: token, sinCookies: true }),
      await admin.post('/api/admin/dominios', { dominio: `x.${uni.dominio}` }, { bearer: token, sinCookies: true }),
      await admin.post(`/api/admin/personas/${persona.id}/reactivar`, {}),
    ]) {
      expect(r.status, r.texto).toBe(401);
    }
    const p = await paginaCurso(persona.cliente, curso);
    expect(p.status).toBe(403);
    expect(p.texto).not.toContain(`Curso de prueba ${curso}`);

    const nuevo = mailNuevo(uni.dominio, 'nuevo');
    const casos = [persona.email, uni.admin, nuevo, mailNuevo('austral.edu.ar', 'nadie')];
    const respuestas: Respuesta[] = [];
    const desde = nucleo.cantidadMails();
    for (const email of casos) respuestas.push(await pedirCodigo(new Cliente(nucleo), email));
    for (const r of respuestas) {
      expect(r.status).toBe(200);
      expect(r.texto).toBe(respuestas[0].texto);
      expect(r.setCookies).toEqual([]);
    }
    await new Promise((res) => setTimeout(res, 500));
    const enviados = nucleo.mails().slice(desde).map((m) => m.para);
    for (const email of [persona.email, uni.admin, nuevo]) expect(enviados).not.toContain(email);
    const v = await verificar(new Cliente(nucleo), nuevo, '000000');
    expect(v.status).toBe(400);
    expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM usuarios WHERE email = ?', nuevo).n).toBe(0);
    expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM dominios WHERE dominio = ?', `x.${uni.dominio}`).n).toBe(0);

    expect((await rehabilitar(owner, uni.id)).status).toBe(200);
    ejecutarSql(nucleo, 'UPDATE sesiones SET revocada = 1 WHERE usuario_id IN (?, ?)', idUsuario(nucleo, uni.admin), persona.id);
  });

  test('el administrador de otra universidad no puede inscribir ni invitar en la deshabilitada', async ({ nucleo }) => {
    const owner = await sesionReautenticada(nucleo, OWNER);
    const uni = await universidadNueva(owner);
    expect((await deshabilitar(owner, uni.id)).status).toBe(200);
    const ana = await sesionReautenticada(nucleo, ADMIN_AUSTRAL);
    const inv = await ana.post('/api/admin/invitaciones', { email: mailNuevo(uni.dominio), tipo: 'profesor' });
    expect(inv.status).toBe(400);
    const inv2 = await owner.post(`/api/owner/universidades/${uni.id}/administradores`, { email: mailNuevo(uni.dominio, 'adm') });
    expect(inv2.status).toBe(409);
    expect(inv2.json.error).toBe('universidad_deshabilitada');
    expect(fila(nucleo, 'SELECT COUNT(*) AS n FROM usuarios WHERE universidad_id = ?', uni.id).n).toBe(1);
    expect((await rehabilitar(owner, uni.id)).status).toBe(200);
  });
});

test('volver a entrar con la universidad rehabilitada no revive las sesiones revocadas', async ({ nucleo }) => {
  const owner = await sesionReautenticada(nucleo, OWNER);
  const uni = await universidadNueva(owner);
  const persona = await cuentaNueva(nucleo, uni.dominio);
  const vieja = persona.cliente.clonarSesion();
  expect((await deshabilitar(owner, uni.id)).status).toBe(200);
  expect((await rehabilitar(owner, uni.id)).status).toBe(200);
  expect((await vieja.get('/api/yo')).status).toBe(401);
  const nueva = new Cliente(nucleo);
  await entrar(nueva, persona.email);
  expect((await nueva.get('/api/yo')).status).toBe(200);
  expect((await vieja.get('/api/yo')).status).toBe(401);
});
