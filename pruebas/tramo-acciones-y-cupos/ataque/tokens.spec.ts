import { crearTestSinDocker, expect, OWNER, ADMIN_AUSTRAL, PROFE_AUSTRAL, ALUMNO_AUSTRAL } from '../fixtures.ts';
import { Cliente } from '../../comun/http.ts';
import { COOKIE_SESION } from '../../comun/entorno.ts';
import { aleatorio } from '../../comun/sesion.ts';
import { AUSTRAL, auditoriaDe, cursoDePrueba, idDe, login, mailNuevo, ok, sesionDe, tokenViejo, universidadDe } from '../lib.ts';

const test = crearTestSinDocker();

test.describe('sin tokens personales', () => {
  test('un token personal viejo no sirve en ninguna ruta, con ningún permiso', async ({ nucleo }) => {
    const casos: Array<[string, string[]]> = [
      [PROFE_AUSTRAL, ['cursos:leer', 'cursos:escribir']],
      [ADMIN_AUSTRAL, ['admin:leer', 'admin:escribir', 'cursos:leer']],
      [OWNER, ['owner:leer', 'owner:escribir']],
    ];
    const curso = cursoDePrueba(nucleo, { universidad: universidadDe(nucleo, AUSTRAL), dueno: PROFE_AUSTRAL, alumnos: [ALUMNO_AUSTRAL] });
    for (const [email, permisos] of casos) {
      const duenio = await sesionDe(nucleo, email);
      const token = await tokenViejo(duenio, permisos);
      const api = new Cliente(nucleo);
      for (const ruta of ['/api/yo', '/api/mis-cursos', '/api/admin/personas', '/api/admin/universidad', '/api/owner/universidades', '/api/owner/uso', `/api/cursos/${curso}`, `/api/cursos/${curso}/inscriptos`]) {
        const r = await api.get(ruta, { bearer: token });
        expect(r.status, `${email} ${ruta}`).toBe(401);
        expect(r.json?.error).toBe('no_autenticado');
      }
      const dominio = `${aleatorio('tok')}.austral.edu.ar`;
      const sinOrigen = await api.post('/api/admin/dominios', { dominio }, { bearer: token, origen: null, sinEncabezadoPropio: true });
      expect(sinOrigen.status).toBe(403);
      expect(sinOrigen.json.error).toBe('origen_invalido');
      const conOrigen = await api.post('/api/admin/dominios', { dominio }, { bearer: token });
      expect(conOrigen.status).toBe(401);
      const inscribir = await api.post(`/api/cursos/${curso}/inscriptos`, { emails: [mailNuevo('mail.austral.edu.ar')], rol: 'alumno' }, { bearer: token });
      expect(inscribir.status).toBe(401);
      expect(nucleo.consultar('SELECT COUNT(*) AS n FROM dominios WHERE dominio = ?', dominio)[0].n).toBe(0);
    }
    expect(nucleo.consultar('SELECT COUNT(*) AS n FROM tokens_api WHERE ultimo_uso IS NOT NULL')[0].n).toBe(0);
    expect(nucleo.consultar("SELECT COUNT(*) AS n FROM inscripciones WHERE curso_id = ?", curso)[0].n).toBe(2);
  });

  test('un Authorization nunca cae a la cookie, aunque la cookie sea buena', async ({ nucleo }) => {
    const c = await sesionDe(nucleo, ADMIN_AUSTRAL);
    const token = await tokenViejo(c, ['admin:leer', 'admin:escribir']);
    for (const valor of [`Bearer ${token}`, 'Bearer cia_inventado', `Bearer ${c.sesion}`, `Basic ${Buffer.from('a:b').toString('base64')}`, 'Bearer ']) {
      const r = await c.get('/api/yo', { encabezados: { authorization: valor } });
      expect(r.status, valor.slice(0, 12)).toBe(401);
      const p = await c.get('/api/admin/personas', { encabezados: { authorization: valor } });
      expect(p.status).toBe(401);
      const salir = await c.post('/api/logout', {}, { encabezados: { authorization: valor } });
      expect(salir.status).toBe(401);
    }
    expect((await c.get('/api/yo')).status).toBe(200);
    const yo = ok(await c.get('/api/yo'), 'yo');
    expect(yo.sesion).toBeTruthy();
  });

  test('las rutas de tokens, de cerrar las demás sesiones y del límite en USD ya no existen', async ({ nucleo }) => {
    const admin = await sesionDe(nucleo, ADMIN_AUSTRAL);
    const otra = await sesionDe(nucleo, ADMIN_AUSTRAL);
    const tokens = Number(nucleo.consultar('SELECT COUNT(*) AS n FROM tokens_api')[0].n);
    const limite = nucleo.consultar('SELECT limite_usd FROM universidades WHERE nombre = ?', AUSTRAL)[0].limite_usd;
    for (const [metodo, ruta, cuerpo] of [
      ['GET', '/api/tokens', undefined],
      ['POST', '/api/tokens', { nombre: 'x', permisos: ['cursos:leer'] }],
      ['POST', '/api/tokens', { nombre: 'x', permisos: ['admin:leer', 'admin:escribir'], dias: 365 }],
      ['DELETE', '/api/tokens/1', undefined],
      ['POST', '/api/sesiones/cerrar-otras', {}],
      ['PUT', '/api/admin/limite', { limite_usd: 1 }],
    ] as Array<[string, string, any]>) {
      const r = await admin.pedir(metodo, ruta, cuerpo);
      expect(r.status, `${metodo} ${ruta}`).toBe(404);
      expect(r.texto).not.toMatch(/cia_[A-Za-z0-9_-]{20,}/);
    }
    expect(Number(nucleo.consultar('SELECT COUNT(*) AS n FROM tokens_api')[0].n)).toBe(tokens);
    expect(nucleo.consultar('SELECT limite_usd FROM universidades WHERE nombre = ?', AUSTRAL)[0].limite_usd).toBe(limite);
    expect((await otra.get('/api/yo')).status).toBe(200);
    expect(auditoriaDe(nucleo, 'sesiones_cerradas', ADMIN_AUSTRAL).filter((e) => Number(e.actor_id) === idDe(nucleo, ADMIN_AUSTRAL))).toHaveLength(0);
    const yo = ok(await admin.get('/api/yo'), 'yo');
    expect(yo.sesion).toMatchObject({ tipo: 'cookie' });
  });

  test('solo el owner ve y cierra las sesiones de otra persona', async ({ nucleo }) => {
    const email = mailNuevo('austral.edu.ar', 'victima');
    const victima = await login(nucleo, email);
    const id = idDe(nucleo, email);
    const sid = Number(nucleo.consultar('SELECT id FROM sesiones WHERE usuario_id = ? AND revocada = 0', id)[0].id);
    for (const quien of [ADMIN_AUSTRAL, PROFE_AUSTRAL, ALUMNO_AUSTRAL]) {
      const c = await sesionDe(nucleo, quien);
      for (const [metodo, ruta] of [
        ['GET', `/api/owner/personas/${id}/sesiones`],
        ['DELETE', `/api/owner/personas/${id}/sesiones/${sid}`],
        ['POST', `/api/owner/personas/${id}/sesiones/cerrar`],
        ['GET', `/api/admin/personas/${id}/sesiones`],
      ]) {
        const r = await c.pedir(metodo, ruta, metodo === 'POST' ? {} : undefined);
        expect([403, 404], `${quien} ${metodo} ${ruta}`).toContain(r.status);
        expect(r.texto).not.toContain(victima.sesion!);
      }
    }
    expect((await new Cliente(nucleo).get(`/api/owner/personas/${id}/sesiones`)).status).toBe(401);
    expect((await victima.get('/api/yo')).status).toBe(200);

    const owner = await sesionDe(nucleo, OWNER);
    const viejo = await tokenViejo(owner, ['owner:leer', 'owner:escribir']);
    expect((await new Cliente(nucleo).get(`/api/owner/personas/${id}/sesiones`, { bearer: viejo })).status).toBe(401);
    expect((await new Cliente(nucleo).post(`/api/owner/personas/${id}/sesiones/cerrar`, {}, { bearer: viejo })).status).toBe(401);
    const sinOrigen = await owner.post(`/api/owner/personas/${id}/sesiones/cerrar`, {}, { origen: null });
    expect(sinOrigen.status).toBe(403);
    expect(sinOrigen.json.error).toBe('origen_invalido');
    const ajena = Number(nucleo.consultar('SELECT id FROM sesiones WHERE usuario_id = ? AND revocada = 0 ORDER BY id DESC', idDe(nucleo, OWNER))[0].id);
    expect((await owner.delete(`/api/owner/personas/${id}/sesiones/${ajena}`)).status).toBe(404);
    expect((await owner.get('/api/owner/personas/99999999/sesiones')).status).toBe(404);
    expect((await owner.get('/api/owner/personas/abc/sesiones')).status).not.toBe(200);
    expect((await owner.get('/api/yo')).status).toBe(200);
    expect((await victima.get('/api/yo')).status).toBe(200);

    const lista = ok(await owner.get(`/api/owner/personas/${id}/sesiones`), 'sesiones');
    const texto = JSON.stringify(lista);
    expect(texto).not.toContain(victima.sesion!);
    const huella = String(nucleo.consultar('SELECT huella FROM sesiones WHERE id = ?', sid)[0].huella);
    expect(texto).not.toContain(huella);
    for (const s of lista.sesiones) expect(Object.keys(s).sort()).toEqual(['agente', 'creada', 'dispositivo', 'id', 'ip', 'ultimo_uso', 'vence']);
  });

  test('una sesión cerrada por el owner no revive', async ({ nucleo }) => {
    const email = mailNuevo('austral.edu.ar', 'cerrada');
    const victima = await login(nucleo, email);
    const robada = victima.sesion!;
    const id = idDe(nucleo, email);
    const owner = await sesionDe(nucleo, OWNER);
    const sid = ok(await owner.get(`/api/owner/personas/${id}/sesiones`), 'sesiones').sesiones[0].id;
    expect((await owner.delete(`/api/owner/personas/${id}/sesiones/${sid}`)).status).toBe(204);
    for (const ruta of ['/api/yo', '/api/mis-cursos']) {
      expect((await new Cliente(nucleo).get(ruta, { cookie: `${COOKIE_SESION}=${robada}` })).status).toBe(401);
    }
    expect((await new Cliente(nucleo).post('/api/logout', {}, { cookie: `${COOKIE_SESION}=${robada}` })).status).toBe(401);
    expect((await owner.delete(`/api/owner/personas/${id}/sesiones/${sid}`)).status).toBe(404);
    const otra = await login(nucleo, email);
    expect(otra.sesion).not.toBe(robada);
    expect((await otra.get('/api/yo')).status).toBe(200);
  });
});
