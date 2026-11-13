import { crearTestCursos, expect, PROFE_AUSTRAL, PROFE2_AUSTRAL, ALUMNO_AUSTRAL, ALUMNA2_AUSTRAL, ADMIN_AUSTRAL, OWNER, PROFE_DEMO } from '../fixtures.ts';
import { DOMINIO } from '../../comun/entorno.ts';
import { reautenticar } from '../../comun/sesion.ts';
import { Cliente } from '../../comun/http.ts';
import { firmaValida, firmar, leerIdentidad, nuevaSemilla } from '../lib/identidad.ts';
import {
  TIEMPO_PRUEBA_DOCKER,
  cursoListo,
  enCurso,
  getCurso,
  idAleatorio,
  idUsuario,
  inscribirOk,
  sesion,
} from '../lib/cursos.ts';

const CLAVE = nuevaSemilla();
const test = crearTestCursos({ espia: true, entorno: { IDENTIDAD_CLAVE_PRIVADA: CLAVE.semilla } });
test.describe.configure({ mode: 'serial', timeout: TIEMPO_PRUEBA_DOCKER });

let a = '';
let b = '';

async function registro(c: Cliente, id: string): Promise<any[]> {
  const r = await getCurso(c, id, '/espia/registro');
  expect(r.status, r.texto).toBe(200);
  return r.json;
}

test.describe('enrutador: quién llega al curso y con qué', () => {
  test.beforeAll(async ({ nucleo }) => {
    test.setTimeout(TIEMPO_PRUEBA_DOCKER);
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    a = idAleatorio('espa');
    b = idAleatorio('espb');
    await cursoListo(profe, { id: a, nombre: 'Curso Espía A' });
    await cursoListo(profe, { id: b, nombre: 'Curso Espía B' });
    await inscribirOk(profe, a, [ALUMNO_AUSTRAL]);
    await inscribirOk(profe, b, [ALUMNO_AUSTRAL]);
  });

  test('el núcleo firma con IDENTIDAD_CLAVE_PRIVADA y publica la clave pública correspondiente', async ({ nucleo }) => {
    const r = nucleo.ejecutar(['clave-publica']);
    expect(r.stdout.trim()).toBe(CLAVE.publica);
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    const eco = await getCurso(alumno, a, '/espia/eco');
    expect(eco.status, eco.texto).toBe(200);
    const id = eco.json.encabezados['x-campus-identidad'];
    expect(firmaValida(id, CLAVE.publica)).toBe(true);
    const carga = leerIdentidad(id);
    const ahora = Math.floor(Date.now() / 1000);
    expect(carga).toMatchObject({ v: 1, curso: a, usuario: String(idUsuario(nucleo, ALUMNO_AUSTRAL)), email: ALUMNO_AUSTRAL, nombre: 'Tomás García', rol: 'alumno' });
    expect(Math.abs(carga.emitido - ahora)).toBeLessThanOrEqual(5);
    expect(carga.vence - carga.emitido).toBeGreaterThan(0);
    expect(carga.vence - carga.emitido).toBeLessThanOrEqual(120);
    expect(Object.keys(carga).sort()).toEqual(['curso', 'email', 'emitido', 'nombre', 'rol', 'usuario', 'v', 'vence']);
  });

  test('sin sesión no se llega al curso, aunque se mande una identidad firmada', async ({ nucleo, cliente }) => {
    await registro(await sesion(nucleo, PROFE_AUSTRAL), a);
    const anon = cliente();
    const falsa = firmar({ v: 1, curso: a, usuario: '1', email: PROFE_AUSTRAL, nombre: 'X', rol: 'dueño', emitido: Math.floor(Date.now() / 1000), vence: Math.floor(Date.now() / 1000) + 60 }, CLAVE.privada);
    for (const ruta of ['/', '/api/yo', '/espia/eco', '/espia/registro', '/salud']) {
      const r = await getCurso(anon, a, ruta, { encabezados: { 'x-campus-identidad': falsa, authorization: 'Bearer cia_inventado' } });
      expect(r.status, ruta).toBe(401);
      expect(r.texto).not.toContain('Curso Espía A');
    }
    const p = await enCurso(anon, a, 'POST', '/espia/eco', { x: 1 }, { encabezados: { 'x-campus-identidad': falsa } });
    expect(p.status).toBe(401);
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const reg = await registro(profe, a);
    expect(reg.filter((x: any) => x.ruta !== '/espia/registro' && x.ruta !== '/salud')).toEqual([]);
  });

  test('una cookie de sesión inventada o revocada no entra', async ({ nucleo }) => {
    const falsa = new Cliente(nucleo);
    falsa.sesion = 'A'.repeat(43);
    expect((await getCurso(falsa, a, '/api/yo')).status).toBe(401);
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    const copia = alumno.clonarSesion();
    expect((await alumno.post('/api/logout')).status).toBe(204);
    expect((await getCurso(copia, a, '/api/yo')).status).toBe(401);
  });

  test('los no inscriptos no entran, aunque sean administradores, owner o de otra universidad', async ({ nucleo }) => {
    await registro(await sesion(nucleo, PROFE_AUSTRAL), a);
    for (const email of [ALUMNA2_AUSTRAL, ADMIN_AUSTRAL, OWNER, PROFE_DEMO, PROFE2_AUSTRAL]) {
      const c = await sesion(nucleo, email);
      for (const ruta of ['/', '/api/yo', '/espia/eco']) {
        const r = await getCurso(c, a, ruta);
        expect(r.status, `${email} ${ruta}`).toBe(403);
        expect(r.texto).not.toContain('Curso Espía A');
      }
    }
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    const reg = await registro(profe, a);
    expect(reg.filter((x: any) => x.ruta === '/espia/eco')).toEqual([]);
  });

  test('una identidad mandada desde el navegador se reemplaza por la del núcleo', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    const falsa = firmar({ v: 1, curso: a, usuario: String(idUsuario(nucleo, PROFE_AUSTRAL)), email: PROFE_AUSTRAL, nombre: 'Lucía Fernández', rol: 'dueño', emitido: Math.floor(Date.now() / 1000), vence: Math.floor(Date.now() / 1000) + 60 }, CLAVE.privada);
    const r = await getCurso(alumno, a, '/espia/eco', {
      encabezados: { 'x-campus-identidad': falsa, 'x-campus-rol': 'dueño', 'x-campus-usuario': '1', 'x-forwarded-user': PROFE_AUSTRAL },
    });
    expect(r.status).toBe(200);
    const h = r.json.encabezados;
    expect(h['x-campus-identidad']).not.toBe(falsa);
    expect(h['x-campus-identidad']).not.toContain(',');
    expect(firmaValida(h['x-campus-identidad'], CLAVE.publica)).toBe(true);
    expect(leerIdentidad(h['x-campus-identidad'])).toMatchObject({ email: ALUMNO_AUSTRAL, rol: 'alumno', curso: a });
    expect(h['x-campus-rol']).toBeUndefined();
    expect(h['x-campus-usuario']).toBeUndefined();
    const yo = await getCurso(alumno, a, '/api/yo', { encabezados: { 'x-campus-identidad': falsa } });
    expect(yo.json.rol).toBe('alumno');
    const p = await enCurso(alumno, a, 'POST', '/api/clases', { titulo: 'Soy dueño' }, { encabezados: { 'x-campus-identidad': falsa } });
    expect(p.status).toBe(403);
  });

  test('las cookies y la autorización de la plataforma nunca llegan al curso', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    const t = { json: { token: `cia_${'T'.repeat(43)}` } };
    const r = await getCurso(alumno, a, '/espia/eco', {
      cookie: `campusia_sesion=${alumno.sesion}; otra=1; curso_propia=2`,
      encabezados: { authorization: `Bearer ${t.json.token}`, 'proxy-authorization': 'Basic eDp5' },
    });
    expect(r.status).toBe(200);
    const h = r.json.encabezados;
    expect(h.cookie).toBeUndefined();
    expect(h.authorization).toBeUndefined();
    expect(h['proxy-authorization']).toBeUndefined();
    expect(JSON.stringify(r.json)).not.toContain(alumno.sesion!);
    expect(JSON.stringify(r.json)).not.toContain(t.json.token);
    const p = await enCurso(alumno, a, 'POST', '/espia/eco?x=1', { hola: 'mundo' });
    expect(p.status).toBe(200);
    expect(p.json.metodo).toBe('POST');
    expect(p.json.consulta).toBe('?x=1');
    expect(JSON.parse(p.json.cuerpo)).toEqual({ hola: 'mundo' });
    expect(p.json.encabezados.cookie).toBeUndefined();
  });

  test('las cookies que el curso intenta plantar se descartan', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    const antes = alumno.sesion;
    const r = await getCurso(alumno, a, '/espia/cookie');
    expect(r.status).toBe(200);
    expect(r.setCookies).toEqual([]);
    expect(alumno.sesion).toBe(antes);
    expect((await alumno.get('/api/yo')).status).toBe(200);
  });

  test('el navegador tampoco recibe cookies plantadas por el curso', async ({ nucleo, paginaComo }) => {
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    const page = await paginaComo(alumno);
    await page.goto(`http://${a}-curso.${DOMINIO}:${nucleo.puerto}/espia/cookie`);
    const cookies = await page.context().cookies();
    expect(cookies.filter((c) => c.name !== 'campusia_sesion')).toEqual([]);
    expect(cookies.find((c) => c.name === 'campusia_sesion')?.value).toBe(alumno.sesion);
  });

  test('un curso no puede mandar peticiones que modifican a otro curso', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    const p = nucleo.puerto;
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    await registro(profe, b);
    for (const origen of [
      `http://${a}-curso.${DOMINIO}:${p}`,
      `http://${b}.${DOMINIO}:${p}`,
      `http://${DOMINIO}:${p}`,
      `http://evil.com:${p}`,
      'null',
      null,
    ]) {
      const r = await enCurso(alumno, b, 'POST', '/espia/eco', { x: 1 }, { origen });
      expect(r.status, `Origin ${origen}`).toBe(403);
      const d = await enCurso(profe, b, 'POST', '/api/clases', { titulo: 'CSRF' }, { origen });
      expect(d.status, `Origin ${origen}`).toBe(403);
    }
    const reg = await registro(profe, b);
    expect(reg.filter((x: any) => x.metodo === 'POST')).toEqual([]);
    expect((await getCurso(profe, b, '/api/clases')).json).toEqual([]);
    const ok = await enCurso(alumno, b, 'POST', '/espia/eco', { x: 1 });
    expect(ok.status).toBe(200);
  });

  test('la identidad es del curso pedido, no de otro', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    const ra = await getCurso(alumno, a, '/espia/eco');
    const rb = await getCurso(alumno, b, '/espia/eco');
    expect(leerIdentidad(ra.json.encabezados['x-campus-identidad']).curso).toBe(a);
    expect(leerIdentidad(rb.json.encabezados['x-campus-identidad']).curso).toBe(b);
  });

  test('una persona quitada pierde el acceso enseguida', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    await inscribirOk(profe, a, [ALUMNA2_AUSTRAL]);
    const sofia = await sesion(nucleo, ALUMNA2_AUSTRAL);
    expect((await getCurso(sofia, a, '/api/yo')).status).toBe(200);
    await reautenticar(profe);
    expect((await profe.delete(`/api/cursos/${a}/inscriptos/${idUsuario(nucleo, ALUMNA2_AUSTRAL)}`)).status).toBe(204);
    expect((await getCurso(sofia, a, '/api/yo')).status).toBe(403);
    expect((await getCurso(sofia, a, '/espia/eco')).status).toBe(403);
  });

  test('un cambio de rol se refleja en la identidad siguiente', async ({ nucleo }) => {
    const profe = await sesion(nucleo, PROFE_AUSTRAL);
    await inscribirOk(profe, b, ['mruiz@austral.edu.ar']);
    const martin = await sesion(nucleo, 'mruiz@austral.edu.ar');
    expect((await getCurso(martin, b, '/api/yo')).json.rol).toBe('alumno');
    await reautenticar(profe);
    expect((await profe.put(`/api/cursos/${b}/inscriptos/${idUsuario(nucleo, 'mruiz@austral.edu.ar')}`, { rol: 'profesor' })).status).toBe(200);
    expect((await getCurso(martin, b, '/api/yo')).json.rol).toBe('profesor');
  });

  test('las rutas raras no escapan del curso', async ({ nucleo }) => {
    const alumno = await sesion(nucleo, ALUMNO_AUSTRAL);
    for (const ruta of ['/../../api/yo', '/%2e%2e/%2e%2e/api/admin/personas', '//api/yo']) {
      const r = await getCurso(alumno, a, ruta);
      expect(r.json?.usuario?.universidad, ruta).toBeUndefined();
      expect(r.json?.personas, ruta).toBeUndefined();
    }
    const otroHost = await alumno.get('/api/yo', { host: `${a}-curso.${DOMINIO}.evil.com:${nucleo.puerto}` });
    expect(otroHost.status).toBe(404);
  });
});
