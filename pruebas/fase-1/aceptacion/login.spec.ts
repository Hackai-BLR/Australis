import { testCodigo as test, expect, ADMIN_AUSTRAL, ALUMNO_AUSTRAL, OWNER, PENDIENTE_AUSTRAL, PROFE_AUSTRAL, UNI_AUSTRAL } from '../fixtures.ts';
import { atributosCookie } from '../../comun/http.ts';
import { COOKIE_SESION, DOMINIO } from '../../comun/entorno.ts';
import { TURNSTILE_SITE_KEY } from '../../comun/servicios-falsos.ts';
import { aleatorio, entrar, esperarCodigo, mailsPara, obtenerCodigo, pedirCodigo, verificar } from '../../comun/sesion.ts';

function cookieSesion(setCookies: string[]) {
  const sc = setCookies.find((s) => s.startsWith(`${COOKIE_SESION}=`));
  expect(sc, 'falta Set-Cookie de la sesión').toBeTruthy();
  return atributosCookie(sc!);
}

test.describe('login con código por mail', () => {
  test('la salud y la configuración pública responden sin sesión', async ({ cliente }) => {
    const c = cliente();
    const salud = await c.get('/salud');
    expect(salud.status).toBe(200);
    expect(salud.json).toEqual({ ok: true });
    const conf = await c.get('/api/config');
    expect(conf.status).toBe(200);
    expect(conf.json).toEqual({ dominio_base: DOMINIO, turnstile_site_key: TURNSTILE_SITE_KEY, reautenticacion: 'codigo' });
  });

  test('sin sesión /api/yo responde 401', async ({ cliente }) => {
    const r = await cliente().get('/api/yo');
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('no_autenticado');
    expect(typeof r.json.mensaje).toBe('string');
  });

  test('una persona existente entra con el código que le llega por mail', async ({ cliente, nucleo }) => {
    const c = cliente();
    const desde = nucleo.cantidadMails();
    const pedido = await pedirCodigo(c, PROFE_AUSTRAL);
    expect(pedido.status).toBe(200);
    expect(pedido.json).toEqual({ ok: true });
    const codigo = await esperarCodigo(nucleo, PROFE_AUSTRAL, desde);
    expect(codigo).toMatch(/^\d{6}$/);
    const mail = mailsPara(nucleo, PROFE_AUSTRAL, desde).pop()!;
    expect(mail.asunto.length).toBeGreaterThan(0);
    const r = await verificar(c, PROFE_AUSTRAL, codigo);
    expect(r.status).toBe(200);
    expect(r.json.usuario).toMatchObject({
      email: PROFE_AUSTRAL,
      nombre: 'Lucía Fernández',
      profesor: true,
      administrador: false,
      owner: false,
    });
    expect(r.json.usuario.universidad).toMatchObject({ nombre: UNI_AUSTRAL });
    expect(typeof r.json.usuario.id).toBe('number');
    const yo = await c.get('/api/yo');
    expect(yo.status).toBe(200);
    expect(yo.json.usuario.email).toBe(PROFE_AUSTRAL);
    expect(yo.json.sesion.tipo).toBe('cookie');
    expect(yo.json.sesion.reautenticada_hasta).toBeNull();
    expect(Date.parse(yo.json.sesion.vence)).toBeGreaterThan(Date.now());
  });

  test('el código se usa una sola vez', async ({ cliente }) => {
    const c = cliente();
    const codigo = await obtenerCodigo(c, PROFE_AUSTRAL);
    expect((await verificar(c, PROFE_AUSTRAL, codigo)).status).toBe(200);
    const otro = cliente();
    const r = await verificar(otro, PROFE_AUSTRAL, codigo);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('codigo_invalido');
  });

  test('la cuenta se crea sola con un mail de un dominio habilitado', async ({ cliente }) => {
    const email = `${aleatorio('nuevo.')}@mail.austral.edu.ar`;
    const c = cliente();
    const usuario = await entrar(c, email);
    expect(usuario).toMatchObject({ email, profesor: false, administrador: false, owner: false });
    expect(usuario.universidad.nombre).toBe(UNI_AUSTRAL);
    expect(typeof usuario.nombre).toBe('string');
    expect(usuario.nombre.length).toBeGreaterThan(0);
    const cursos = await c.get('/api/mis-cursos');
    expect(cursos.status).toBe(200);
    expect(cursos.json).toEqual({ cursos: [] });
  });

  test('el mail se normaliza a minúsculas y sin espacios', async ({ cliente, nucleo }) => {
    const c = cliente();
    const desde = nucleo.cantidadMails();
    expect((await pedirCodigo(c, '  TGarcia@Mail.Austral.EDU.ar ')).status).toBe(200);
    const codigo = await esperarCodigo(nucleo, ALUMNO_AUSTRAL, desde);
    const r = await verificar(c, 'TGARCIA@mail.austral.edu.ar', codigo);
    expect(r.status).toBe(200);
    expect(r.json.usuario.email).toBe(ALUMNO_AUSTRAL);
  });

  test('un mail mal formado devuelve 400', async ({ cliente }) => {
    for (const email of ['', 'sin-arroba', 'a@', '@austral.edu.ar', 'a b@austral.edu.ar']) {
      const r = await pedirCodigo(cliente(), email);
      expect(r.status, email).toBe(400);
      expect(r.json.error).toBe('email_invalido');
    }
  });

  test('la cookie de sesión de alumnos y profesores dura 30 días y sirve en los subdominios', async ({ cliente }) => {
    const c = cliente();
    const codigo = await obtenerCodigo(c, ALUMNO_AUSTRAL);
    const r = await verificar(c, ALUMNO_AUSTRAL, codigo);
    const { valor, atributos } = cookieSesion(r.setCookies);
    expect(valor.length).toBeGreaterThanOrEqual(32);
    expect(atributos.httponly).toBe(true);
    expect(String(atributos.samesite).toLowerCase()).toBe('lax');
    expect(String(atributos.domain).replace(/^\./, '')).toBe(DOMINIO);
    expect(atributos.path).toBe('/');
    expect(atributos['max-age']).toBe('2592000');
    expect(atributos.secure).toBeUndefined();
    const enSub = await c.get('/api/yo', { sub: 'redes' });
    expect(enSub.status).toBe(200);
    expect(enSub.json.usuario.email).toBe(ALUMNO_AUSTRAL);
  });

  test('la sesión de administradores y owners dura 12 horas', async ({ cliente }) => {
    for (const email of [ADMIN_AUSTRAL, OWNER]) {
      const c = cliente();
      const codigo = await obtenerCodigo(c, email);
      const r = await verificar(c, email, codigo);
      expect(r.status).toBe(200);
      expect(cookieSesion(r.setCookies).atributos['max-age'], email).toBe('43200');
      const yo = await c.get('/api/yo');
      const horas = (Date.parse(yo.json.sesion.vence) - Date.now()) / 3_600_000;
      expect(horas).toBeGreaterThan(11.5);
      expect(horas).toBeLessThanOrEqual(12.01);
    }
  });

  test('el owner entra aunque su dominio no sea de ninguna universidad', async ({ cliente }) => {
    const usuario = await entrar(cliente(), OWNER);
    expect(usuario).toMatchObject({ email: OWNER, owner: true, universidad: null });
  });

  test('logout revoca la sesión y borra la cookie', async ({ cliente }) => {
    const c = cliente();
    await entrar(c, ALUMNO_AUSTRAL);
    const copia = c.clonarSesion();
    const r = await c.post('/api/logout');
    expect(r.status).toBe(204);
    const borrada = cookieSesion(r.setCookies);
    expect(borrada.atributos['max-age'] === '0' || borrada.valor === '').toBe(true);
    expect((await c.get('/api/yo')).status).toBe(401);
    expect((await copia.get('/api/yo')).status).toBe(401);
  });

  test('volver a entrar renueva la sesión y anula la anterior del mismo navegador', async ({ cliente }) => {
    const c = cliente();
    await entrar(c, PROFE_AUSTRAL);
    const vieja = c.sesion!;
    await entrar(c, PROFE_AUSTRAL);
    const nueva = c.sesion!;
    expect(nueva).not.toBe(vieja);
    expect((await c.get('/api/yo')).status).toBe(200);
    expect((await c.get('/api/yo', { cookie: `${COOKIE_SESION}=${vieja}` })).status).toBe(401);
  });

  test('una cuenta invitada pendiente entra y deja de estar pendiente conservando sus marcas', async ({ cliente }) => {
    const c = cliente();
    const usuario = await entrar(c, PENDIENTE_AUSTRAL);
    expect(usuario).toMatchObject({ email: PENDIENTE_AUSTRAL, profesor: true });
    const admin = cliente();
    await entrar(admin, ADMIN_AUSTRAL);
    const personas = await admin.get(`/api/admin/personas?buscar=${encodeURIComponent('cpendiente')}`);
    expect(personas.status).toBe(200);
    const p = personas.json.personas.find((x: any) => x.email === PENDIENTE_AUSTRAL);
    expect(p).toMatchObject({ pendiente: false, profesor: true });
    expect(p.ultimo_ingreso).toBeTruthy();
  });

  test('reautenticarse con un código nuevo habilita las acciones sensibles por 10 minutos', async ({ cliente, nucleo }) => {
    const c = cliente();
    await entrar(c, ADMIN_AUSTRAL);
    const desde = nucleo.cantidadMails();
    expect((await c.post('/api/reautenticacion/codigo')).status).toBe(200);
    const codigo = await esperarCodigo(nucleo, ADMIN_AUSTRAL, desde);
    const v = await c.post('/api/reautenticacion/verificar', { codigo });
    expect(v.status).toBe(200);
    const minutos = (Date.parse(v.json.reautenticada_hasta) - Date.now()) / 60_000;
    expect(minutos).toBeGreaterThan(9);
    expect(minutos).toBeLessThanOrEqual(10.1);
    const yo = await c.get('/api/yo');
    expect(yo.json.sesion.reautenticada_hasta).toBeTruthy();
  });
});

test.describe('mis cursos y páginas servidas', () => {
  test('cada persona ve sus cursos con su rol', async ({ cliente }) => {
    const profe = cliente();
    await entrar(profe, PROFE_AUSTRAL);
    const r = await profe.get('/api/mis-cursos');
    expect(r.status).toBe(200);
    const porId = Object.fromEntries(r.json.cursos.map((c: any) => [c.id, c]));
    expect(Object.keys(porId).sort()).toEqual(['algoritmos', 'etica', 'redes']);
    expect(porId.redes).toEqual({
      id: 'redes',
      nombre: 'Redes de Computadoras',
      periodo: '2.º cuatrimestre 2026',
      color: '#1F7A4D',
      rol: 'dueño',
      version_publicada: 12,
      archivado: false,
    });
    expect(porId.etica.rol).toBe('alumno');
    expect(porId.etica.version_publicada).toBeNull();

    const alumno = cliente();
    await entrar(alumno, ALUMNO_AUSTRAL);
    const ra = await alumno.get('/api/mis-cursos');
    expect(ra.json.cursos.map((c: any) => [c.id, c.rol]).sort()).toEqual([
      ['algoritmos', 'alumno'],
      ['redes', 'alumno'],
    ]);

    const otro = cliente();
    await entrar(otro, 'dherrera@austral.edu.ar');
    const ro = await otro.get('/api/mis-cursos');
    expect(Object.fromEntries(ro.json.cursos.map((c: any) => [c.id, c.rol]))).toEqual({ redes: 'profesor', etica: 'dueño' });
  });

  test('la interfaz se sirve en el dominio base y en los subdominios de curso', async ({ cliente }) => {
    const c = cliente();
    for (const op of [{}, { sub: 'redes' }, { sub: 'no-existe' }]) {
      for (const ruta of ['/', '/administracion', '/owner']) {
        const r = await c.get(ruta, op);
        expect(r.status, `${JSON.stringify(op)} ${ruta}`).toBe(200);
        expect(String(r.encabezados['content-type'])).toContain('text/html');
        expect(r.texto).toMatch(/<div id="raiz"><\/div>|id="raiz"/);
      }
    }
  });

  test('la página provisoria del curso se muestra a sus inscriptos', async ({ cliente }) => {
    const c = cliente();
    await entrar(c, ALUMNO_AUSTRAL);
    const r = await c.get('/', { sub: 'redes-curso' });
    expect(r.status).toBe(200);
    expect(String(r.encabezados['content-type'])).toContain('text/html');
    expect(r.texto).toContain('Redes de Computadoras');
    const csp = String(r.encabezados['content-security-policy'] ?? '');
    expect(csp).toContain('frame-ancestors');
    expect(csp).toContain(`redes.${DOMINIO}`);
  });
});
